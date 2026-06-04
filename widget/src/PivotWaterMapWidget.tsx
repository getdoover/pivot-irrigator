import "./styles.css";

import { useEffect, useMemo, useRef, useState } from "react";

import RemoteComponentWrapper from "customer_site/RemoteComponentWrapper";
import { useRemoteParams } from "customer_site/useRemoteParams";

import { useAgentChannel, useDooverClient } from "doover-js/react";
import { extractSnowflakeId, generateSnowflakeIdAtTime } from "doover-js";
import { useQuery } from "@tanstack/react-query";
import dayjs from "dayjs";

import GoogleMap from "google-maps-react-markers";

import {
  buildGeoJSON,
  buildSamples,
  computeEvents,
  computeSectorDepths,
  legendStops,
  zoomForRadius,
  type PivotConfig,
  type Sample,
} from "./lib/pivot";

const HISTORY_LIMIT = 1500;
const MAX_PAGES = 40; // safety cap: up to 60k points per window

interface UiElement {
  app_key?: string;
}

// Deployment-config keys match the snake_case `name=` set on each config field
// in src/pivot_water_map/app_config.py.
interface RawConfig {
  flow_tag?: { app_name?: string; tag_name?: string };
  position_tag?: { app_name?: string; tag_name?: string };
  end_gun_tag?: { app_name?: string; tag_name?: string };
  flow_units?: string;
  pivot_centre_lat?: number;
  pivot_centre_lon?: number;
  wetted_radius_m?: number;
  end_gun_radius_m?: number;
  sector_resolution_deg?: number;
  position_offset_deg?: number;
  dormancy_days?: number;
  google_maps_api_key?: string;
}

const WINDOW_OPTIONS = [7, 30, 90];

function toPivotConfig(raw: RawConfig): PivotConfig | null {
  if (
    raw.pivot_centre_lat == null ||
    raw.pivot_centre_lon == null ||
    raw.wetted_radius_m == null ||
    !raw.flow_tag?.app_name ||
    !raw.flow_tag?.tag_name ||
    !raw.position_tag?.app_name ||
    !raw.position_tag?.tag_name
  ) {
    return null;
  }
  return {
    flow: raw.flow_tag,
    position: raw.position_tag,
    endGun: raw.end_gun_tag?.app_name && raw.end_gun_tag?.tag_name ? raw.end_gun_tag : undefined,
    flowUnits: raw.flow_units ?? "L/s",
    centreLat: raw.pivot_centre_lat,
    centreLon: raw.pivot_centre_lon,
    wettedRadiusM: raw.wetted_radius_m,
    endGunRadiusM: raw.end_gun_radius_m ?? 0,
    sectorResolutionDeg: raw.sector_resolution_deg ?? 1,
    positionOffsetDeg: raw.position_offset_deg ?? 0,
    dormancyDays: raw.dormancy_days ?? 5,
    mapsApiKey: raw.google_maps_api_key ?? "",
  };
}

function fmtRange(startMs: number, endMs: number): string {
  return `${dayjs(startMs).format("D MMM YYYY HH:mm")} – ${dayjs(endMs).format("D MMM HH:mm")}`;
}

function PivotWaterMapInner({ uiElement }: { uiElement?: UiElement }) {
  const params = useRemoteParams();
  const agentId = params.agentId;
  const appKey = uiElement?.app_key;
  const client = useDooverClient();

  const { data: depCfg, isLoading: cfgLoading } = useAgentChannel<{
    applications?: Record<string, RawConfig>;
  }>(agentId, "deployment_config");

  const raw = (appKey ? depCfg?.applications?.[appKey] : undefined) ?? {};
  const cfg = useMemo(() => toPivotConfig(raw), [JSON.stringify(raw)]);

  const [windowDays, setWindowDays] = useState(30);
  const [viewMode, setViewMode] = useState<"event" | "window">("event");
  const [eventIdx, setEventIdx] = useState<number | null>(null);

  const uniqueApps = useMemo(() => {
    if (!cfg) return [] as string[];
    const apps = [cfg.flow.app_name, cfg.position.app_name, cfg.endGun?.app_name].filter(
      (a): a is string => Boolean(a),
    );
    return Array.from(new Set(apps));
  }, [cfg]);

  const tsQuery = useQuery({
    queryKey: ["pivot", agentId, uniqueApps, windowDays] as const,
    enabled: !!agentId && !!cfg && uniqueApps.length > 0,
    queryFn: async () => {
      // Page through the whole window: getTimeseries caps each call at the
      // server limit and returns a `next` cursor — pass it back as `before`.
      const now = dayjs();
      const after = generateSnowflakeIdAtTime(now.subtract(windowDays, "day"));
      let before = generateSnowflakeIdAtTime(now.add(2, "minute"));
      const results: Array<{ value: Record<string, unknown>; message_id: string }> = [];
      let hitCap = false;
      for (let page = 0; page < MAX_PAGES; page++) {
        const res = await client.messages.getTimeseries(agentId!, "tag_values", {
          before,
          after,
          field_name: uniqueApps,
          limit: HISTORY_LIMIT,
          paginate: true,
        });
        results.push(...((res.results ?? []) as typeof results));
        if (!res.next) break;
        before = res.next;
        if (page === MAX_PAGES - 1) hitCap = true;
      }
      return { results, hitCap };
    },
  });

  const samples: Sample[] = useMemo(() => {
    if (!cfg) return [];
    const flowKey = `${cfg.flow.app_name}.${cfg.flow.tag_name}`;
    const posKey = `${cfg.position.app_name}.${cfg.position.tag_name}`;
    const gunKey = cfg.endGun ? `${cfg.endGun.app_name}.${cfg.endGun.tag_name}` : null;
    const rows = (tsQuery.data?.results ?? []).map((p: { value: Record<string, unknown>; message_id: string }) => {
      const v = p.value ?? {};
      const num = (x: unknown) => (typeof x === "number" ? x : typeof x === "string" ? Number(x) : null);
      // robust truthiness — guard against string "false"/"0" from string-typed tags
      const truthy = (x: unknown) =>
        x === true || x === 1 || x === "true" || x === "True" || x === "1";
      return {
        t: extractSnowflakeId(p.message_id).timestamp,
        flow: num(v[flowKey]),
        angle: num(v[posKey]),
        endGun: gunKey != null ? truthy(v[gunKey]) : null,
      };
    });
    return buildSamples(rows);
  }, [tsQuery.data, cfg]);

  const events = useMemo(
    () => (cfg ? computeEvents(samples, cfg.dormancyDays) : []),
    [samples, cfg],
  );

  // Default to the latest detected event whenever the event list changes.
  useEffect(() => {
    if (events.length > 0) setEventIdx(events.length - 1);
    else setEventIdx(null);
  }, [events.length]);

  const selectedSamples: Sample[] = useMemo(() => {
    if (viewMode === "window") return samples;
    if (eventIdx == null) return [];
    return events[eventIdx]?.samples ?? [];
  }, [viewMode, samples, events, eventIdx]);

  const result = useMemo(
    () => (cfg && selectedSamples.length > 1 ? computeSectorDepths(selectedSamples, cfg) : null),
    [cfg, selectedSamples],
  );

  const geojson = useMemo(
    () => (cfg && result ? buildGeoJSON(result, cfg) : null),
    [cfg, result],
  );

  // --- map plumbing ---------------------------------------------------------
  const mapRef = useRef<any>(null);
  const mapsRef = useRef<any>(null);
  const infoRef = useRef<any>(null);
  const [mapReady, setMapReady] = useState(false);

  const onGoogleApiLoaded = ({ map, maps }: { map: any; maps: any }) => {
    mapRef.current = map;
    mapsRef.current = maps;
    infoRef.current = new maps.InfoWindow();
    // Register the click handler ONCE — re-registering on every render would
    // leak listeners and stack duplicate info windows.
    map.data.addListener("click", (e: any) => {
      const depth = e.feature.getProperty("depthMm");
      if (depth == null) return;
      infoRef.current.setContent(`<b>${depth.toFixed(1)} mm</b> applied`);
      infoRef.current.setPosition(e.latLng);
      infoRef.current.open(map);
    });
    map.data.setStyle((feature: any) => ({
      fillColor: feature.getProperty("fill"),
      fillOpacity: 0.75,
      strokeColor: "#222",
      strokeWeight: 0.4,
    }));
    setMapReady(true);
  };

  useEffect(() => {
    const map = mapRef.current;
    const maps = mapsRef.current;
    if (!map || !maps || !cfg) return;

    // clear previous features
    map.data.forEach((f: any) => map.data.remove(f));

    if (geojson && geojson.features.length > 0) {
      map.data.addGeoJson(geojson);
    }

    map.setCenter({ lat: cfg.centreLat, lng: cfg.centreLon });
    map.setZoom(zoomForRadius(cfg.centreLat, cfg.wettedRadiusM + cfg.endGunRadiusM));
  }, [geojson, cfg, mapReady]);

  // --- render ---------------------------------------------------------------
  if (cfgLoading) return <div className="pwm-msg">Loading configuration…</div>;
  if (!appKey) return <div className="pwm-msg">Widget is missing its app key.</div>;
  if (!cfg)
    return (
      <div className="pwm-msg">
        Configure the pivot water map: set the flow &amp; position tags and the pivot centre and
        wetted radius in this app's config.
      </div>
    );
  if (!cfg.mapsApiKey)
    return (
      <div className="pwm-msg">
        Set the Google Maps API key in this app's config to render the map.
      </div>
    );

  const truncated = Boolean(tsQuery.data?.hitCap);
  // If Google Maps JS is already on the page (host map, or another pivot widget
  // instance), don't let the library inject a second copy — reuse the loaded one.
  const mapsAlreadyLoaded =
    typeof window !== "undefined" && Boolean((window as { google?: { maps?: unknown } }).google?.maps);

  return (
    <div className="pwm">
      <div className="pwm-controls">
        <div className="pwm-pills">
          {WINDOW_OPTIONS.map((d) => (
            <button
              key={d}
              className={d === windowDays ? "pwm-pill active" : "pwm-pill"}
              onClick={() => setWindowDays(d)}
            >
              {d}d
            </button>
          ))}
        </div>

        <select
          className="pwm-select"
          value={viewMode === "window" ? "window" : eventIdx ?? ""}
          onChange={(e) => {
            if (e.target.value === "window") {
              setViewMode("window");
            } else {
              setViewMode("event");
              setEventIdx(Number(e.target.value));
            }
          }}
        >
          {events.map((ev, i) => (
            <option key={i} value={i}>
              Event {i + 1}: {fmtRange(ev.startMs, ev.endMs)}
            </option>
          ))}
          <option value="window">Whole window ({windowDays}d)</option>
        </select>

        {tsQuery.isFetching && <span className="pwm-note">loading…</span>}
      </div>

      <div className="pwm-mapwrap">
        <GoogleMap
          apiKey={cfg.mapsApiKey}
          defaultCenter={{ lat: cfg.centreLat, lng: cfg.centreLon }}
          defaultZoom={zoomForRadius(cfg.centreLat, cfg.wettedRadiusM + cfg.endGunRadiusM)}
          mapMinHeight="60vh"
          loadScriptExternally={mapsAlreadyLoaded}
          status={mapsAlreadyLoaded ? "ready" : undefined}
          options={{ mapTypeId: "hybrid", tilt: 0, streetViewControl: false }}
          onGoogleApiLoaded={onGoogleApiLoaded}
        />

        {result && (
          <div className="pwm-legend">
            <div className="pwm-legend-title">Applied depth (mm)</div>
            {legendStops(result.colourMaxMm)
              .slice()
              .reverse()
              .map((s, i) => {
                const clampedTop = i === 0 && result.colourMaxMm < result.maxDepthMm;
                return (
                  <div key={i} className="pwm-legend-row">
                    <span className="pwm-swatch" style={{ background: s.colour }} />
                    {clampedTop ? `≥ ${s.depth.toFixed(1)}` : s.depth.toFixed(1)}
                  </div>
                );
              })}
          </div>
        )}
      </div>

      <div className="pwm-stats">
        {result ? (
          <>
            <span>max {result.maxDepthMm.toFixed(1)} mm</span>
            <span>mean {result.meanDepthMm.toFixed(1)} mm</span>
            <span>{(result.totalVolumeM3 / 1000).toFixed(1)} ML applied</span>
            <span>{selectedSamples.length} samples</span>
          </>
        ) : (
          <span>No water applied in this selection.</span>
        )}
        {truncated && <span className="pwm-warn">history truncated to {HISTORY_LIMIT} points</span>}
      </div>
    </div>
  );
}

export default function PivotWaterMapWidget(props: { uiElement?: UiElement }) {
  return (
    <RemoteComponentWrapper>
      <PivotWaterMapInner {...props} />
    </RemoteComponentWrapper>
  );
}
