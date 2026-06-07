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
  Area,
  Brush,
  ComposedChart,
  Line,
  ReferenceArea,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import {
  buildGeoJSON,
  buildSamples,
  computeEvents,
  computeSectorDepths,
  legendStops,
  toCSV,
  zoomForRadius,
  type IrrigationEvent,
  type PivotConfig,
  type Sample,
} from "./lib/pivot";

const HISTORY_LIMIT = 1500;
const MAX_PAGES = 40; // safety cap: up to 60k points per window
const CHART_BUCKETS = 600; // uniform time grid so the brush travels by time, not by sample

// interpreter mini-chart palette (matches ~/customer-site ui/chart CustomBrush)
const BRUSH_TRACK = "oklch(0.929 0.013 255.508)";
const BRUSH_TRAVELLER = "oklch(0.208 0.042 265.755)";

interface UiElement {
  app_key?: string;
}

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

interface ChartPoint {
  t: number;
  flow: number;
  speed: number | null; // angular speed, deg/hr
}

const FLOW_COLOUR = "#2c7fb8";
const SPEED_COLOUR = "#dc2626";
const SPEED_MAX_GAP_MIN = 60; // don't infer speed across gaps longer than this

const WINDOW_OPTIONS = [2, 7, 30, 90];
const DEFAULT_WINDOW_DAYS = 2;

function DownloadIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

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
  return `${dayjs(startMs).format("D MMM HH:mm")} – ${dayjs(endMs).format("D MMM HH:mm")}`;
}

function nearestIndex(data: ChartPoint[], t: number): number {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < data.length; i++) {
    const d = Math.abs(data[i].t - t);
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  return best;
}

function download(filename: string, text: string, mime: string) {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// --- flow sparkline + brush ------------------------------------------------

// Pill-shaped traveller (dark rounded bar + white grip), matching the Doover
// interpreter's CustomBrush.
function brushTraveller({ x, y, width, height }: { x: number; y: number; width: number; height: number }) {
  return (
    <>
      <rect x={x} y={y} width={width} height={height} rx={width / 2} fill={BRUSH_TRAVELLER} stroke="none" />
      <rect
        x={x + 4}
        y={y + 4}
        width={width - 8}
        height={height - 8}
        rx={Math.max(0, width / 2 - 4)}
        fill="white"
        stroke="none"
      />
    </>
  );
}

function FlowTimeline({
  data,
  events,
  units,
  startIndex,
  endIndex,
  onBrush,
  showFlow,
  showSpeed,
  onToggle,
}: {
  data: ChartPoint[];
  events: IrrigationEvent[];
  units: string;
  startIndex: number;
  endIndex: number;
  onBrush: (s: number, e: number) => void;
  showFlow: boolean;
  showSpeed: boolean;
  onToggle: (key: "flow" | "speed") => void;
}) {
  return (
    <div className="pwm-timeline">
      <div className="pwm-chartlegend">
        <button
          className={showFlow ? "pwm-legitem" : "pwm-legitem off"}
          onClick={() => onToggle("flow")}
        >
          <i style={{ background: FLOW_COLOUR }} /> Flow ({units})
        </button>
        <button
          className={showSpeed ? "pwm-legitem" : "pwm-legitem off"}
          onClick={() => onToggle("speed")}
        >
          <i style={{ background: SPEED_COLOUR }} /> Speed (°/hr)
        </button>
      </div>
      <ResponsiveContainer width="100%" height={180}>
        <ComposedChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: 8 }}>
          <defs>
            <linearGradient id="pwmFlow" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={FLOW_COLOUR} stopOpacity={0.5} />
              <stop offset="100%" stopColor={FLOW_COLOUR} stopOpacity={0.05} />
            </linearGradient>
          </defs>
          <XAxis
            dataKey="t"
            type="number"
            scale="time"
            domain={["dataMin", "dataMax"]}
            tickFormatter={(t) => dayjs(t).format("D MMM HH:mm")}
            tick={{ fontSize: 11, fill: "#64748b" }}
            minTickGap={50}
          />
          <YAxis yAxisId="flow" hide domain={[0, "dataMax"]} />
          <YAxis yAxisId="speed" orientation="right" hide domain={[0, "dataMax"]} />
          <Tooltip
            labelFormatter={(t) => dayjs(Number(t)).format("D MMM YYYY HH:mm")}
            formatter={(v: number, name: string) =>
              name === "speed"
                ? [`${Number(v).toFixed(1)} °/hr`, "speed"]
                : [`${Number(v).toFixed(1)} ${units}`, "flow"]
            }
          />
          {events.map((ev, i) => (
            <ReferenceArea
              key={i}
              yAxisId="flow"
              x1={ev.startMs}
              x2={ev.endMs}
              fill={FLOW_COLOUR}
              fillOpacity={0.12}
            />
          ))}
          {showFlow && (
            <Area
              yAxisId="flow"
              type="monotone"
              dataKey="flow"
              stroke={FLOW_COLOUR}
              fill="url(#pwmFlow)"
              strokeWidth={1.4}
              isAnimationActive={false}
            />
          )}
          {showSpeed && (
            <Line
              yAxisId="speed"
              type="monotone"
              dataKey="speed"
              stroke={SPEED_COLOUR}
              strokeWidth={1.2}
              dot={false}
              connectNulls={false}
              isAnimationActive={false}
            />
          )}
          <Brush
            dataKey="t"
            height={50}
            travellerWidth={12}
            gap={1}
            stroke={BRUSH_TRACK}
            fill="#f8fafc"
            startIndex={startIndex}
            endIndex={endIndex}
            tickFormatter={(t) => dayjs(Number(t)).format("D/M HH:mm")}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            traveller={brushTraveller as any}
            onChange={(r: { startIndex?: number; endIndex?: number }) => {
              if (r.startIndex != null && r.endIndex != null) onBrush(r.startIndex, r.endIndex);
            }}
          >
            <ComposedChart>
              <YAxis yAxisId="bf" hide domain={[0, "dataMax"]} />
              <YAxis yAxisId="bs" hide domain={[0, "dataMax"]} />
              {showFlow && (
                <Line
                  yAxisId="bf"
                  type="monotone"
                  dataKey="flow"
                  stroke={FLOW_COLOUR}
                  strokeWidth={1}
                  dot={false}
                  isAnimationActive={false}
                />
              )}
              {showSpeed && (
                <Line
                  yAxisId="bs"
                  type="monotone"
                  dataKey="speed"
                  stroke={SPEED_COLOUR}
                  strokeWidth={1}
                  dot={false}
                  connectNulls={false}
                  isAnimationActive={false}
                />
              )}
            </ComposedChart>
          </Brush>
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
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

  const [windowDays, setWindowDays] = useState(DEFAULT_WINDOW_DAYS);
  const [brush, setBrush] = useState<{ start: number; end: number } | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [series, setSeries] = useState({ flow: true, speed: false });

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
    const rows = (tsQuery.data?.results ?? []).map(
      (p: { value: Record<string, unknown>; message_id: string }) => {
        const v = p.value ?? {};
        const num = (x: unknown) => (typeof x === "number" ? x : typeof x === "string" ? Number(x) : null);
        const truthy = (x: unknown) =>
          x === true || x === 1 || x === "true" || x === "True" || x === "1";
        return {
          t: extractSnowflakeId(p.message_id).timestamp,
          flow: num(v[flowKey]),
          angle: num(v[posKey]),
          endGun: gunKey != null ? truthy(v[gunKey]) : null,
        };
      },
    );
    return buildSamples(rows);
  }, [tsQuery.data, cfg]);

  const events = useMemo(
    () => (cfg ? computeEvents(samples, cfg.dormancyDays) : []),
    [samples, cfg],
  );

  // Resample flow onto a UNIFORM time grid across the full selected window
  // (7/30/90 d). Equal-time buckets mean the brush travels proportionally to
  // time, not to where the data happens to be; empty buckets read as zero flow.
  const chartData = useMemo<ChartPoint[]>(() => {
    const end = Date.now();
    const start = end - windowDays * 86_400_000;
    const n = CHART_BUCKETS;
    const bucketMs = (end - start) / n;
    const sum = new Float64Array(n);
    const cnt = new Int32Array(n);
    const ang = new Float64Array(n).fill(NaN); // last position seen in each bucket
    for (const s of samples) {
      const i = Math.floor((s.t - start) / bucketMs);
      if (i < 0 || i >= n) continue;
      if (s.flow != null) {
        sum[i] += s.flow;
        cnt[i] += 1;
      }
      if (s.angle != null) ang[i] = s.angle;
    }
    // Angular speed (deg/min) from the net position change between consecutive
    // populated buckets — wrap-aware, and skipped across long gaps.
    const speed = new Float64Array(n).fill(NaN);
    let prevI = -1;
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(ang[i])) continue;
      if (prevI >= 0) {
        const dtMin = ((i - prevI) * bucketMs) / 60_000;
        if (dtMin > 0 && dtMin <= SPEED_MAX_GAP_MIN) {
          const dDeg = Math.abs(((ang[i] - ang[prevI] + 540) % 360) - 180);
          speed[i] = dDeg / (dtMin / 60); // deg per hour
        }
      }
      prevI = i;
    }
    const data: ChartPoint[] = [];
    for (let i = 0; i < n; i++) {
      data.push({
        t: Math.round(start + i * bucketMs),
        flow: cnt[i] ? sum[i] / cnt[i] : 0,
        speed: Number.isNaN(speed[i]) ? null : speed[i],
      });
    }
    return data;
  }, [samples, windowDays]);

  // Default the brush to the latest detected event (or the whole window)
  // whenever the underlying chart data changes shape.
  useEffect(() => {
    if (chartData.length < 2) {
      setBrush(null);
      return;
    }
    const last = events[events.length - 1];
    if (last) {
      setBrush({
        start: nearestIndex(chartData, last.startMs),
        end: nearestIndex(chartData, last.endMs),
      });
    } else {
      setBrush({ start: 0, end: chartData.length - 1 });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [windowDays, events.length]);

  const selRange = useMemo(() => {
    if (!brush || chartData.length === 0) return null;
    const a = chartData[Math.min(brush.start, chartData.length - 1)]?.t;
    const b = chartData[Math.min(brush.end, chartData.length - 1)]?.t;
    if (a == null || b == null) return null;
    return { startMs: Math.min(a, b), endMs: Math.max(a, b) };
  }, [brush, chartData]);

  const selectedSamples: Sample[] = useMemo(() => {
    if (!selRange) return [];
    return samples.filter((s) => s.t >= selRange.startMs && s.t <= selRange.endMs);
  }, [samples, selRange]);

  const result = useMemo(
    () => (cfg && selectedSamples.length > 1 ? computeSectorDepths(selectedSamples, cfg) : null),
    [cfg, selectedSamples],
  );

  const metadata = useMemo(
    () =>
      cfg && selRange && result
        ? {
            generatedAt: new Date().toISOString(),
            periodStart: new Date(selRange.startMs).toISOString(),
            periodEnd: new Date(selRange.endMs).toISOString(),
            centre: { lat: cfg.centreLat, lon: cfg.centreLon },
            wettedRadiusM: cfg.wettedRadiusM,
            endGunRadiusM: cfg.endGunRadiusM,
            flowUnits: cfg.flowUnits,
            maxDepthMm: result.maxDepthMm,
            meanDepthMm: result.meanDepthMm,
            totalVolumeM3: result.totalVolumeM3,
          }
        : undefined,
    [cfg, selRange, result],
  );

  const geojson = useMemo(
    () => (cfg && result ? buildGeoJSON(result, cfg, metadata) : null),
    [cfg, result, metadata],
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
    map.data.forEach((f: any) => map.data.remove(f));
    if (geojson && geojson.features.length > 0) map.data.addGeoJson(geojson);
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
  const mapsAlreadyLoaded =
    typeof window !== "undefined" && Boolean((window as { google?: { maps?: unknown } }).google?.maps);

  const stamp = selRange ? dayjs(selRange.startMs).format("YYYYMMDD-HHmm") : "export";
  const onExportGeoJSON = () => {
    if (geojson) download(`pivot-as-applied_${stamp}.geojson`, JSON.stringify(geojson, null, 2), "application/geo+json");
  };
  const onExportCSV = () => {
    if (result && cfg) download(`pivot-as-applied_${stamp}.csv`, toCSV(result, cfg), "text/csv");
  };

  const snapTo = (startMs: number, endMs: number) => {
    if (chartData.length < 2) return;
    setBrush({ start: nearestIndex(chartData, startMs), end: nearestIndex(chartData, endMs) });
  };

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

        {events.length > 0 && (
          <div className="pwm-pills">
            {events.map((ev, i) => (
              <button key={i} className="pwm-pill" onClick={() => snapTo(ev.startMs, ev.endMs)}>
                Event {i + 1}
              </button>
            ))}
            {chartData.length >= 2 && (
              <button
                className="pwm-pill"
                onClick={() => setBrush({ start: 0, end: chartData.length - 1 })}
              >
                All
              </button>
            )}
          </div>
        )}

        <div className="pwm-spacer" />

        <div className="pwm-export">
          <button
            className="pwm-iconbtn"
            title="Download"
            aria-label="Download"
            onClick={() => setExportOpen((o) => !o)}
            disabled={!result}
          >
            <DownloadIcon />
          </button>
          {exportOpen && (
            <>
              <div className="pwm-backdrop" onClick={() => setExportOpen(false)} />
              <div className="pwm-menu" role="menu">
                <div className="pwm-menu-title">Download as</div>
                <button
                  className="pwm-menu-item"
                  onClick={() => {
                    onExportGeoJSON();
                    setExportOpen(false);
                  }}
                >
                  GeoJSON
                </button>
                <button
                  className="pwm-menu-item"
                  onClick={() => {
                    onExportCSV();
                    setExportOpen(false);
                  }}
                >
                  CSV
                </button>
              </div>
            </>
          )}
        </div>
        {tsQuery.isFetching && <span className="pwm-note">loading…</span>}
      </div>

      {chartData.length >= 2 && (
        <>
          <FlowTimeline
            data={chartData}
            events={events}
            units={cfg.flowUnits}
            startIndex={brush ? Math.min(brush.start, chartData.length - 1) : 0}
            endIndex={brush ? Math.min(brush.end, chartData.length - 1) : chartData.length - 1}
            onBrush={(s, e) => setBrush({ start: s, end: e })}
            showFlow={series.flow}
            showSpeed={series.speed}
            onToggle={(key) => setSeries((s) => ({ ...s, [key]: !s[key] }))}
          />
          {selRange && (
            <div className="pwm-selrange">Showing {fmtRange(selRange.startMs, selRange.endMs)}</div>
          )}
        </>
      )}

      <div className="pwm-mapwrap">
        <GoogleMap
          apiKey={cfg.mapsApiKey}
          defaultCenter={{ lat: cfg.centreLat, lng: cfg.centreLon }}
          defaultZoom={zoomForRadius(cfg.centreLat, cfg.wettedRadiusM + cfg.endGunRadiusM)}
          mapMinHeight="55vh"
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
          <span>Select a period with flow to see the applied map.</span>
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
