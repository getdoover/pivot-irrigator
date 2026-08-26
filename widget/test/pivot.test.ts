import { test } from "node:test";
import assert from "node:assert/strict";

import {
  unwrapAngles,
  splitRuns,
  smoothTrack,
  flowToM3s,
  normaliseAngle,
  buildSamples,
  computeEvents,
  computeSectorDepths,
  destinationPoint,
  buildGeoJSON,
  depthColour,
  zoomForRadius,
  toCSV,
  downsample,
  type PivotConfig,
  type Sample,
} from "../src/lib/pivot.ts";

const DAY = 24 * 3600 * 1000;

function baseConfig(overrides: Partial<PivotConfig> = {}): PivotConfig {
  return {
    flow: { app_name: "sim", tag_name: "water_flow" },
    position: { app_name: "sim", tag_name: "pivot_position" },
    endGun: undefined,
    flowUnits: "L/s",
    centreLat: 0,
    centreLon: 0,
    wettedRadiusM: 100,
    endGunRadiusM: 0,
    sectorResolutionDeg: 10,
    trackResponsiveness: 0,
    reversalThresholdDeg: 5,
    positionOffsetDeg: 0,
    dormancyDays: 5,
    mapsApiKey: "",
    ...overrides,
  };
}

// --- units ------------------------------------------------------------------

test("flowToM3s converts each unit", () => {
  assert.equal(flowToM3s(1000, "L/s"), 1);
  assert.equal(flowToM3s(60000, "L/min"), 1);
  assert.equal(flowToM3s(3600, "m3/h"), 1);
  // 1 US gal = 0.003785411784 m3
  assert.ok(Math.abs(flowToM3s(60, "US gpm") - 0.003785411784) < 1e-12);
  assert.equal(flowToM3s(1000, "unknown"), 1); // falls back to L/s
});

test("normaliseAngle wraps into [0,360)", () => {
  assert.equal(normaliseAngle(0), 0);
  assert.equal(normaliseAngle(360), 0);
  assert.equal(normaliseAngle(-10), 350);
  assert.equal(normaliseAngle(370), 10);
});

// --- samples ----------------------------------------------------------------

test("buildSamples carries values forward and sorts by time", () => {
  const rows = [
    { t: 30, endGun: true },
    { t: 10, flow: 10 },
    { t: 20, angle: 90 },
  ];
  const s = buildSamples(rows);
  assert.deepEqual(
    s.map((x) => x.t),
    [10, 20, 30],
  );
  assert.equal(s[0].flow, 10);
  assert.equal(s[1].flow, 10); // carried forward
  assert.equal(s[1].angle, 90);
  assert.equal(s[2].endGun, true);
  assert.equal(s[2].angle, 90); // carried forward
});

// --- events -----------------------------------------------------------------

test("computeEvents splits on a dormant gap longer than dormancyDays", () => {
  const t0 = 1_000_000_000_000;
  const samples: Sample[] = [
    { t: t0, flow: 10, angle: 0, endGun: null },
    { t: t0 + 3600_000, flow: 10, angle: 30, endGun: null },
    // 6-day gap (> 5d dormancy) -> new event
    { t: t0 + 6 * DAY, flow: 10, angle: 60, endGun: null },
    { t: t0 + 6 * DAY + 3600_000, flow: 10, angle: 90, endGun: null },
  ];
  const events = computeEvents(samples, 5);
  assert.equal(events.length, 2);
});

test("computeEvents keeps one event when the gap is under dormancy", () => {
  const t0 = 1_000_000_000_000;
  const samples: Sample[] = [
    { t: t0, flow: 10, angle: 0, endGun: null },
    { t: t0 + 3 * DAY, flow: 10, angle: 90, endGun: null },
  ];
  assert.equal(computeEvents(samples, 5).length, 1);
});

// --- depth (analytic) -------------------------------------------------------

test("a full rotation at constant flow gives uniform depth = V / (pi*R^2)", () => {
  const cfg = baseConfig({ sectorResolutionDeg: 10, wettedRadiusM: 100 });
  const F = 25; // L/s
  const dt = 60_000; // 60 s per step
  const samples: Sample[] = [];
  const t0 = 1_000_000_000_000;
  for (let deg = 0; deg <= 360; deg++) {
    samples.push({ t: t0 + deg * dt, flow: F, angle: deg, endGun: null });
  }
  const res = computeSectorDepths(samples, cfg);

  const totalSeconds = 360 * 60;
  const expectedVol = (F / 1000) * totalSeconds; // m3
  const expectedDepth = (expectedVol / (Math.PI * 100 * 100)) * 1000; // mm

  assert.ok(Math.abs(res.totalVolumeM3 - expectedVol) < 1e-6, `vol ${res.totalVolumeM3}`);
  assert.ok(Math.abs(res.meanDepthMm - expectedDepth) < 1e-6, `mean ${res.meanDepthMm}`);
  for (let s = 0; s < res.nSectors; s++) {
    assert.ok(
      Math.abs(res.depthMm[s] - expectedDepth) < 1e-6,
      `sector ${s} depth ${res.depthMm[s]} != ${expectedDepth}`,
    );
  }
});

test("colourMaxMm clamps to a percentile so a dwell spike doesn't dominate", () => {
  const cfg = baseConfig({ sectorResolutionDeg: 10, wettedRadiusM: 100 });
  const t0 = 1_000_000_000_000;
  const dt = 60_000;
  const samples: Sample[] = [];
  // uniform full rotation
  for (let deg = 0; deg <= 360; deg++) {
    samples.push({ t: t0 + deg * dt, flow: 25, angle: deg, endGun: null });
  }
  // then a long park at 45 deg (sector 4) -> one huge sector
  let t = t0 + 361 * dt;
  for (let k = 0; k < 200; k++) {
    samples.push({ t: t + k * dt, flow: 25, angle: 45, endGun: null });
  }
  const res = computeSectorDepths(samples, cfg);
  assert.ok(res.maxDepthMm > res.colourMaxMm, "spike should exceed the clamp");
  // the clamp should sit near the uniform background depth, not the spike
  assert.ok(res.colourMaxMm < res.maxDepthMm * 0.5);
});

test("a stationary pivot dumps all volume into one sector", () => {
  const cfg = baseConfig({ sectorResolutionDeg: 10 });
  const t0 = 1_000_000_000_000;
  const samples: Sample[] = [
    { t: t0, flow: 25, angle: 45, endGun: null },
    { t: t0 + 600_000, flow: 25, angle: 45, endGun: null },
  ];
  const res = computeSectorDepths(samples, cfg);
  const nonZero = Array.from(res.depthMm).filter((d) => d > 0);
  assert.equal(nonZero.length, 1);
  // sector index for 45 deg at 10 deg resolution = 4
  assert.ok(res.depthMm[4] > 0);
});

test("end-gun extends the wetted radius only for swept sectors", () => {
  const cfg = baseConfig({ endGunRadiusM: 50, sectorResolutionDeg: 10 });
  const t0 = 1_000_000_000_000;
  const samples: Sample[] = [
    { t: t0, flow: 25, angle: 0, endGun: true },
    { t: t0 + 600_000, flow: 25, angle: 20, endGun: true },
  ];
  const res = computeSectorDepths(samples, cfg);
  // sectors 0 and 1 were swept with end-gun on -> radius 150
  assert.equal(res.radiusM[0], 150);
  assert.equal(res.radiusM[1], 150);
  // an unswept sector keeps the base radius
  assert.equal(res.radiusM[18], 100);
});

// --- geometry ---------------------------------------------------------------

test("destinationPoint travels the right way and distance", () => {
  const oneDeg = 6378137 * (Math.PI / 180); // metres per degree at equator
  const [lonN, latN] = destinationPoint(0, 0, 0, oneDeg); // due north
  assert.ok(Math.abs(lonN) < 1e-6);
  assert.ok(Math.abs(latN - 1) < 1e-3);

  const [lonE, latE] = destinationPoint(0, 0, 90, oneDeg); // due east
  assert.ok(Math.abs(lonE - 1) < 1e-3);
  assert.ok(Math.abs(latE) < 1e-3);
});

test("buildGeoJSON yields closed polygons only for watered sectors", () => {
  const cfg = baseConfig({ sectorResolutionDeg: 10, centreLat: -27.5, centreLon: 151.9 });
  const t0 = 1_000_000_000_000;
  const samples: Sample[] = [
    { t: t0, flow: 25, angle: 0, endGun: null },
    { t: t0 + 600_000, flow: 25, angle: 30, endGun: null },
  ];
  const res = computeSectorDepths(samples, cfg);
  const fc = buildGeoJSON(res, cfg);
  const watered = Array.from(res.depthMm).filter((d) => d > 0).length;
  assert.equal(fc.features.length, watered);
  for (const f of fc.features) {
    const ring = f.geometry.coordinates[0];
    assert.deepEqual(ring[0], ring[ring.length - 1]); // closed
    assert.ok(f.properties.depthMm > 0);
    assert.match(f.properties.fill, /^rgb\(/);
  }
});

// --- colour & zoom ----------------------------------------------------------

test("buildGeoJSON enriches properties and attaches metadata", () => {
  const cfg = baseConfig({ sectorResolutionDeg: 10, centreLat: -27.5, centreLon: 151.9 });
  const t0 = 1_000_000_000_000;
  const samples: Sample[] = [
    { t: t0, flow: 25, angle: 0, endGun: null },
    { t: t0 + 600_000, flow: 25, angle: 30, endGun: null },
  ];
  const res = computeSectorDepths(samples, cfg);
  const fc = buildGeoJSON(res, cfg, { foo: "bar" });
  assert.equal(fc.metadata?.foo, "bar");
  const f = fc.features[0];
  assert.ok(typeof f.properties.bearingFromDeg === "number");
  assert.ok(typeof f.properties.bearingToDeg === "number");
  assert.ok(f.properties.radiusM > 0);
});

test("toCSV emits a header and one row per watered sector", () => {
  const cfg = baseConfig({ sectorResolutionDeg: 10 });
  const t0 = 1_000_000_000_000;
  const samples: Sample[] = [
    { t: t0, flow: 25, angle: 0, endGun: null },
    { t: t0 + 600_000, flow: 25, angle: 20, endGun: null },
  ];
  const res = computeSectorDepths(samples, cfg);
  const csv = toCSV(res, cfg);
  const lines = csv.split("\n");
  assert.equal(lines[0], "sector,bearing_from_deg,bearing_to_deg,radius_m,depth_mm");
  const watered = Array.from(res.depthMm).filter((d) => d > 0).length;
  assert.equal(lines.length - 1, watered);
});

test("downsample keeps first and last and caps length", () => {
  const arr = Array.from({ length: 1000 }, (_, i) => i);
  const out = downsample(arr, 100);
  assert.ok(out.length <= 101);
  assert.equal(out[0], 0);
  assert.equal(out[out.length - 1], 999);
  assert.deepEqual(downsample([1, 2, 3], 100), [1, 2, 3]);
});

test("depthColour endpoints and zoom range", () => {
  assert.match(depthColour(0, 10), /^rgb\(/);
  assert.match(depthColour(10, 10), /^rgb\(/);
  assert.equal(depthColour(5, 0), "rgb(44,127,184)"); // maxDepth 0 guard
  const z = zoomForRadius(-27.5, 400);
  assert.ok(z >= 5 && z <= 20);
});


// --- track: unwrapping, runs, filtering -------------------------------------

const MIN = 60_000;

test("unwrapAngles removes the 0/360 seam", () => {
  // 2 deg per step across north: 356, 358, 0, 2, 4
  const raw = [356, 358, 0, 2, 4].map((angle, i) => ({ t: i * MIN, angle }));
  const out = unwrapAngles(raw);
  const steps = out.slice(1).map((p, i) => p.a - out[i].a);
  for (const s of steps) assert.ok(Math.abs(s - 2) < 1e-9, `expected +2 deg, got ${s}`);
  assert.equal(out[0].a, 356);
  assert.equal(out[out.length - 1].a, 364, "must run past 360, not wrap back");
});

test("unwrapAngles handles reverse rotation across the seam", () => {
  const raw = [4, 2, 0, 358, 356].map((angle, i) => ({ t: i * MIN, angle }));
  const steps = unwrapAngles(raw).slice(1).map((p, i, arr) => p.a - unwrapAngles(raw)[i].a);
  for (const s of steps) assert.ok(Math.abs(s + 2) < 1e-9, `expected -2 deg, got ${s}`);
});

test("a full revolution accumulates, it does not fold back to zero", () => {
  const raw = Array.from({ length: 37 }, (_, i) => ({ t: i * MIN, angle: (i * 10) % 360 }));
  const out = unwrapAngles(raw);
  assert.ok(Math.abs(out[out.length - 1].a - 360) < 1e-6, `got ${out[out.length - 1].a}`);
});

test("splitRuns separates a reversal but ignores reading noise", () => {
  const jitter = Array.from({ length: 20 }, (_, i) => ({ t: i * MIN, a: i * 2 + (i % 2 ? 1 : -1) }));
  assert.equal(splitRuns(jitter, 5).length, 1, "2 deg wobble is not a turn");

  const turn: Array<{ t: number; a: number }> = [];
  for (let i = 0; i <= 30; i++) turn.push({ t: i * MIN, a: i * 2 });   // out to 60
  for (let i = 1; i <= 30; i++) turn.push({ t: (30 + i) * MIN, a: 60 - i * 2 }); // back
  const runs = splitRuns(turn, 5);
  assert.equal(runs.length, 2);
  assert.equal(runs[0][runs[0].length - 1].a, 60, "first leg runs to the turn");
});

test("filtering preserves a reversal instead of collapsing it", () => {
  const turn: Array<{ t: number; a: number }> = [];
  for (let i = 0; i <= 30; i++) turn.push({ t: i * MIN, a: i * 2 });
  for (let i = 1; i <= 30; i++) turn.push({ t: (30 + i) * MIN, a: 60 - i * 2 });
  const sm = smoothTrack(turn, 0.001, 5, 1);
  const peak = Math.max(...sm.map((p) => p.a));
  assert.ok(peak > 55, `turnaround should survive, peaked at ${peak.toFixed(1)}`);
  assert.ok(sm[sm.length - 1].a < 10, `should return near the start, ended at ${sm[sm.length - 1].a.toFixed(1)}`);
});

test("filtering reports a velocity and zero responsiveness does not", () => {
  const fx = Array.from({ length: 20 }, (_, i) => ({ t: i * MIN, a: i * 0.25 }));
  const on = smoothTrack(fx, 0.001, 5, 1);
  assert.ok(on.every((p) => p.v != null), "filtered track must carry v");
  const near = on.slice(5, 15).map((p) => p.v as number);
  for (const v of near) assert.ok(Math.abs(v - 0.25) < 0.05, `expected ~0.25 deg/min, got ${v}`);
  assert.equal(smoothTrack(fx, 0), fx, "0 returns the raw fixes");
});

test("sector depths are unchanged by the seam", () => {
  // identical sweeps, one crossing north and one not
  const mk = (from: number) => {
    const rows: Array<{ t: number; flow: number; angle: number }> = [];
    for (let i = 0; i <= 60; i++) rows.push({ t: i * MIN, flow: 100, angle: (from + i) % 360 });
    return buildSamples(rows);
  };
  const cfg = baseConfig({ sectorResolutionDeg: 10, trackResponsiveness: 0.001 });
  const across = computeSectorDepths(mk(340), cfg);
  const clear = computeSectorDepths(mk(100), cfg);
  const tot = (r: { depthMm: Float64Array }) =>
    Array.from(r.depthMm).reduce((a, b) => a + b, 0);
  assert.ok(
    Math.abs(tot(across) - tot(clear)) / tot(clear) < 0.02,
    `crossing north must not change the total: ${tot(across).toFixed(2)} vs ${tot(clear).toFixed(2)}`,
  );
});
