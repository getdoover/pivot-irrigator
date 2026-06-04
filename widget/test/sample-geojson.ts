// Render synthetic pivot data to a GeoJSON file you can preview (e.g. paste
// into geojson.io) to sanity-check the as-applied map geometry & colours
// before deploying. Run: npm run sample-geojson
import { writeFileSync } from "node:fs";

import {
  buildSamples,
  computeEvents,
  computeSectorDepths,
  buildGeoJSON,
  type PivotConfig,
} from "../src/lib/pivot.ts";

// A pivot on the Darling Downs (QLD irrigation country).
const cfg: PivotConfig = {
  flow: { app_name: "pivot_sim", tag_name: "water_flow" },
  position: { app_name: "pivot_sim", tag_name: "pivot_position" },
  endGun: { app_name: "pivot_sim", tag_name: "end_gun_on" },
  flowUnits: "L/s",
  centreLat: -27.55,
  centreLon: 151.95,
  wettedRadiusM: 400,
  endGunRadiusM: 40,
  sectorResolutionDeg: 2,
  positionOffsetDeg: 0,
  dormancyDays: 5,
  mapsApiKey: "",
};

// One ~20 h rotation: steady-ish flow, end-gun on between 200 and 260 deg.
const ROTATION_HOURS = 20;
const STEP_MIN = 2;
const FLOW_LPS = 60;

const t0 = Date.UTC(2026, 4, 20, 6, 0, 0); // 20 May 2026 06:00 UTC
const stepMs = STEP_MIN * 60_000;
const degPerStep = 360 / ((ROTATION_HOURS * 60) / STEP_MIN);

const rows: Array<{ t: number; flow: number; angle: number; endGun: boolean }> = [];
let angle = 0;
let i = 0;
while (angle <= 360) {
  const a = angle % 360;
  // a touch of flow variation so the colour ramp is visible
  const flow = FLOW_LPS + 6 * Math.sin((angle * Math.PI) / 45);
  rows.push({
    t: t0 + i * stepMs,
    flow: Math.max(0, flow),
    angle: a,
    endGun: a >= 200 && a <= 260,
  });
  angle += degPerStep;
  i++;
}

const samples = buildSamples(rows);
const events = computeEvents(samples, cfg.dormancyDays);
const event = events[events.length - 1] ?? { samples };
const result = computeSectorDepths(event.samples, cfg);
const fc = buildGeoJSON(result, cfg);

const out = new URL("../as-applied.sample.geojson", import.meta.url);
writeFileSync(out, JSON.stringify(fc, null, 2));

console.log(`events detected: ${events.length}`);
console.log(`sectors watered: ${fc.features.length}/${result.nSectors}`);
console.log(`max depth:  ${result.maxDepthMm.toFixed(1)} mm`);
console.log(`mean depth: ${result.meanDepthMm.toFixed(1)} mm`);
console.log(`total applied: ${(result.totalVolumeM3 / 1000).toFixed(2)} ML`);
console.log(`wrote ${out.pathname}`);
