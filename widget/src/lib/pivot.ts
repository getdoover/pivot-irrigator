// Pure computation for the pivot "as-applied water map".
//
// Everything here is framework-free so it can be unit-tested in isolation:
//   raw tag history  ->  samples  ->  irrigation events  ->  per-sector
//   applied depth (mm)  ->  GeoJSON annular-sector polygons.

export interface TagRef {
  app_name?: string;
  tag_name?: string;
}

export interface PivotConfig {
  flow: TagRef;
  position: TagRef;
  endGun?: TagRef;
  flowUnits: string; // "L/s" | "L/min" | "m3/h" | "US gpm"
  centreLat: number;
  centreLon: number;
  wettedRadiusM: number;
  endGunRadiusM: number;
  sectorResolutionDeg: number;
  /** Kalman velocity random-walk intensity for the track estimate. 0 = off. */
  trackResponsiveness: number;
  /** How far the pivot must reverse before it counts as a new pass, in degrees. */
  reversalThresholdDeg: number;
  positionOffsetDeg: number;
  dormancyDays: number;
  mapsApiKey: string;
}

/** A single point in time with whatever values were logged for it. */
export interface Sample {
  t: number; // epoch ms
  flow: number | null; // in configured flow units
  angle: number | null; // reported degrees, 0 = North, clockwise
  endGun: boolean | null;
}

export interface IrrigationEvent {
  startMs: number;
  endMs: number;
  samples: Sample[];
}

export interface SectorResult {
  /** applied depth per sector, mm; index 0 = [0, res) degrees reported. */
  depthMm: Float64Array;
  /** effective wetted radius per sector, m (accounts for end-gun). */
  radiusM: Float64Array;
  resolutionDeg: number;
  nSectors: number;
  maxDepthMm: number;
  /** depth used as the top of the colour scale — a percentile, so a single
   * dwell/parked spike doesn't wash the whole map to the low end. */
  colourMaxMm: number;
  meanDepthMm: number;
  totalVolumeM3: number;
}

/** value at the given percentile (0..1) of a numeric array; 0 if empty. */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[idx];
}

const FLOW_EPS = 0.01; // below this we treat the pivot as not applying water
const EARTH_RADIUS_M = 6378137;

// --- units ------------------------------------------------------------------

/** Convert a flow value in the configured units to cubic metres per second. */
export function flowToM3s(value: number, units: string): number {
  switch (units) {
    case "L/s":
      return value / 1000;
    case "L/min":
      return value / 1000 / 60;
    case "m3/h":
      return value / 3600;
    case "US gpm":
      return (value * 0.003785411784) / 60;
    default:
      return value / 1000; // assume L/s
  }
}

export function normaliseAngle(deg: number): number {
  return ((deg % 360) + 360) % 360;
}

/** Signed shortest angular delta from a to b, in (-180, 180]. */
function shortestDelta(a: number, b: number): number {
  return ((b - a + 540) % 360) - 180;
}

// --- samples & events -------------------------------------------------------

/**
 * Merge a flat list of partial readings into time-sorted samples. Each input
 * row carries whatever of flow/angle/endGun was present in that logged
 * message; missing fields are carried forward from the previous sample so each
 * emitted sample has the best-known value at that instant.
 */
export function buildSamples(
  rows: Array<{ t: number; flow?: number | null; angle?: number | null; endGun?: boolean | null }>,
): Sample[] {
  const sorted = [...rows].sort((a, b) => a.t - b.t);
  const out: Sample[] = [];
  let lastFlow: number | null = null;
  let lastAngle: number | null = null;
  let lastEndGun: boolean | null = null;
  for (const r of sorted) {
    if (r.flow !== undefined && r.flow !== null && Number.isFinite(r.flow)) lastFlow = r.flow;
    if (r.angle !== undefined && r.angle !== null && Number.isFinite(r.angle)) lastAngle = normaliseAngle(r.angle);
    if (r.endGun !== undefined && r.endGun !== null) lastEndGun = Boolean(r.endGun);
    out.push({ t: r.t, flow: lastFlow, angle: lastAngle, endGun: lastEndGun });
  }
  return out;
}

/**
 * Split samples into irrigation events. A new event begins when flow resumes
 * after a dormant gap of at least `dormancyDays`. Each event keeps every sample
 * inside its time span (including any brief zero-flow stretches) so the depth
 * integration reflects the actual flow.
 */
export function computeEvents(samples: Sample[], dormancyDays: number): IrrigationEvent[] {
  const dormancyMs = dormancyDays * 24 * 3600 * 1000;
  const boundaries: Array<{ startMs: number; endMs: number }> = [];
  let curStart: number | null = null;
  let lastFlowT: number | null = null;

  for (const s of samples) {
    const flowing = s.flow !== null && s.flow > FLOW_EPS;
    if (!flowing) continue;
    if (curStart === null || (lastFlowT !== null && s.t - lastFlowT > dormancyMs)) {
      if (curStart !== null && lastFlowT !== null) boundaries.push({ startMs: curStart, endMs: lastFlowT });
      curStart = s.t;
    }
    lastFlowT = s.t;
  }
  if (curStart !== null && lastFlowT !== null) boundaries.push({ startMs: curStart, endMs: lastFlowT });

  return boundaries.map((b) => ({
    startMs: b.startMs,
    endMs: b.endMs,
    samples: samples.filter((s) => s.t >= b.startMs && s.t <= b.endMs),
  }));
}

// --- travel track -----------------------------------------------------------

export interface TrackFix {
  t: number; // epoch ms
  /** UNWRAPPED bearing in degrees: continuous across the 0/360 seam, so it can
   *  exceed 360 or go negative after several revolutions. Wrap with
   *  normaliseAngle() before using it to pick a sector. */
  a: number;
  /** Estimated angular speed, deg/min. Present once the track has been
   *  filtered; the speed chart reads this rather than differencing `a`. */
  v?: number;
}

/** A reversal has to exceed plausible position error before we call it a turn.
 * 5 deg is ~20 m of arc on a 225 m machine, comfortably clear of the reading
 * error while far shorter than any real pass. */
export const DEFAULT_REVERSAL_DEG = 5;

/** Default position measurement variance, deg^2. A pivot reporting to ~1 deg
 * (about 4 m of arc at 225 m) gives 1^2 = 1. Raise it for a coarser resolver. */
export const DEFAULT_POSITION_VARIANCE_DEG2 = 1;

function reversalDegrees(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? (value as number) : DEFAULT_REVERSAL_DEG;
}

/** Accumulate wrapped bearings into a continuous signal.
 *
 * A pivot crossing north steps 359 -> 1, which as raw numbers is a 358 deg
 * jump backwards. Everything downstream -- the filter, the run splitter, the
 * sweep -- has to see the 2 deg forward step that actually happened, so the
 * seam is removed once here and re-applied only when picking a sector.
 */
export function unwrapAngles(fixes: Array<{ t: number; angle: number }>): TrackFix[] {
  const out: TrackFix[] = [];
  let acc = 0;
  for (let i = 0; i < fixes.length; i++) {
    if (i === 0) acc = fixes[0].angle;
    else acc += shortestDelta(fixes[i - 1].angle, fixes[i].angle);
    out.push({ t: fixes[i].t, a: acc });
  }
  return out;
}

/** Split a track into monotonic runs.
 *
 * A pivot usually turns one way, but it can be reversed to re-water a sector,
 * and a bare filter rounds a turnaround off by several degrees. Each leg is
 * filtered on its own; the turn fix belongs to both.
 */
export function splitRuns(fixes: TrackFix[], reversalDeg: number = DEFAULT_REVERSAL_DEG): TrackFix[][] {
  const minTurn = reversalDegrees(reversalDeg);
  if (fixes.length < 2) return fixes.length ? [fixes.slice()] : [];
  const runs: TrackFix[][] = [];
  let startIdx = 0;
  let extremeIdx = 0;
  let dir = 0;
  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i].a;
    if (dir === 0) {
      if (Math.abs(a - fixes[startIdx].a) >= minTurn) dir = Math.sign(a - fixes[startIdx].a);
      if (dir === 0 || (dir > 0 ? a > fixes[extremeIdx].a : a < fixes[extremeIdx].a)) extremeIdx = i;
      continue;
    }
    if (dir > 0 ? a > fixes[extremeIdx].a : a < fixes[extremeIdx].a) {
      extremeIdx = i;
      continue;
    }
    const retreat = dir > 0 ? fixes[extremeIdx].a - a : a - fixes[extremeIdx].a;
    if (retreat >= minTurn) {
      runs.push(fixes.slice(startIdx, extremeIdx + 1));
      startIdx = extremeIdx;
      extremeIdx = i;
      dir = -dir;
    }
  }
  runs.push(fixes.slice(startIdx));
  return runs.filter((r) => r.length > 0);
}

/** Constant-velocity Kalman filter with an RTS backward smoother, over one run.
 *
 * Velocity is part of the STATE rather than a derivative of a smoothed angle:
 * differencing a smoothed track forces you to over-smooth position just to get
 * a presentable speed trace, which turns every genuine stop/start into a long
 * ramp. Reading `v` straight out of the filter keeps the map and the speed
 * chart on one track without that cost, and the effective bandwidth adapts
 * through the covariance as fix spacing varies.
 *
 * State is [angle (deg), angular velocity (deg/min)]; time is in minutes so the
 * covariance arithmetic stays well conditioned.
 */
function kalmanRun(run: TrackFix[], q: number, r: number): TrackFix[] {
  const n = run.length;
  if (n < 2) return run.map((p) => ({ ...p, v: 0 }));
  const tm = run.map((p) => p.t / 60_000);

  const xf: number[][] = [];
  const Pf: number[][][] = [];
  const xp: number[][] = [];
  const Pp: number[][][] = [];

  // Seed velocity from the whole run's average under a diffuse prior: this is a
  // retrospective smoother, so the run average beats the first gap (the single
  // noisiest estimate available). Seeding at v=0 makes the filter believe the
  // machine is parked and is the one starting point that actually hurts.
  const span = Math.max(1e-6, tm[n - 1] - tm[0]);
  let x = [run[0].a, (run[n - 1].a - run[0].a) / span];
  let P = [
    [r, 0],
    [0, 1e4],
  ];
  const snap = () => [
    [P[0][0], P[0][1]],
    [P[1][0], P[1][1]],
  ];
  xf.push([...x]);
  Pf.push(snap());
  xp.push([...x]);
  Pp.push(snap());

  for (let k = 1; k < n; k++) {
    const dt = Math.max(1e-6, tm[k] - tm[k - 1]);
    const xpk = [x[0] + x[1] * dt, x[1]];
    const Ppk = [
      [
        P[0][0] + dt * (P[1][0] + P[0][1]) + dt * dt * P[1][1] + (q * dt * dt * dt) / 3,
        P[0][1] + dt * P[1][1] + (q * dt * dt) / 2,
      ],
      [P[1][0] + dt * P[1][1] + (q * dt * dt) / 2, P[1][1] + q * dt],
    ];
    xp.push([...xpk]);
    Pp.push([
      [Ppk[0][0], Ppk[0][1]],
      [Ppk[1][0], Ppk[1][1]],
    ]);
    const y = run[k].a - xpk[0];
    const S = Ppk[0][0] + r;
    const K = [Ppk[0][0] / S, Ppk[1][0] / S];
    x = [xpk[0] + K[0] * y, xpk[1] + K[1] * y];
    P = [
      [(1 - K[0]) * Ppk[0][0], (1 - K[0]) * Ppk[0][1]],
      [Ppk[1][0] - K[1] * Ppk[0][0], Ppk[1][1] - K[1] * Ppk[0][1]],
    ];
    xf.push([...x]);
    Pf.push(snap());
  }

  const xs = xf.map((v) => [...v]);
  for (let k = n - 2; k >= 0; k--) {
    const dt = Math.max(1e-6, tm[k + 1] - tm[k]);
    const Ppk = Pp[k + 1];
    const Pfk = Pf[k];
    const det = Ppk[0][0] * Ppk[1][1] - Ppk[0][1] * Ppk[1][0];
    if (!Number.isFinite(det) || Math.abs(det) < 1e-18) continue;
    const inv = [
      [Ppk[1][1] / det, -Ppk[0][1] / det],
      [-Ppk[1][0] / det, Ppk[0][0] / det],
    ];
    const FP = [
      [Pfk[0][0] + dt * Pfk[0][1], Pfk[0][1]],
      [Pfk[1][0] + dt * Pfk[1][1], Pfk[1][1]],
    ];
    const A = [
      [FP[0][0] * inv[0][0] + FP[0][1] * inv[1][0], FP[0][0] * inv[0][1] + FP[0][1] * inv[1][1]],
      [FP[1][0] * inv[0][0] + FP[1][1] * inv[1][0], FP[1][0] * inv[0][1] + FP[1][1] * inv[1][1]],
    ];
    const dx = [xs[k + 1][0] - xp[k + 1][0], xs[k + 1][1] - xp[k + 1][1]];
    xs[k] = [
      xf[k][0] + A[0][0] * dx[0] + A[0][1] * dx[1],
      xf[k][1] + A[1][0] * dx[0] + A[1][1] * dx[1],
    ];
  }
  return run.map((p, k) => ({ t: p.t, a: xs[k][0], v: xs[k][1] }));
}

/** Filter the track, one monotonic run at a time. 0 responsiveness = raw. */
export function smoothTrack(
  fixes: TrackFix[],
  responsiveness: number,
  reversalDeg: number = DEFAULT_REVERSAL_DEG,
  positionVarianceDeg2: number = DEFAULT_POSITION_VARIANCE_DEG2,
): TrackFix[] {
  if (!(responsiveness > 0) || fixes.length < 3) return fixes;
  const out: TrackFix[] = [];
  for (const run of splitRuns(fixes, reversalDeg)) {
    for (const p of kalmanRun(run, responsiveness, positionVarianceDeg2)) {
      if (out.length && p.t === out[out.length - 1].t) continue;
      out.push(p);
    }
  }
  return out;
}

/** Distinct position readings, unwrapped and filtered per config.
 *
 * Shared by the depth computation and the speed chart so the two cannot disagree.
 */
export function buildTrack(samples: Sample[], cfg: PivotConfig): TrackFix[] {
  // The position tag is sample-and-hold: buildSamples carries the last reading
  // forward, so most consecutive samples repeat an angle. Integrating against
  // those held values dumps a whole interval into one sector, so recover the
  // distinct readings and interpolate between them instead.
  const raw: Array<{ t: number; angle: number }> = [];
  for (const s of samples) {
    if (s.angle === null) continue;
    const prev = raw[raw.length - 1];
    if (prev && s.angle === prev.angle) continue;
    if (prev && s.t === prev.t) {
      prev.angle = s.angle;
      continue;
    }
    raw.push({ t: s.t, angle: s.angle });
  }
  return smoothTrack(
    unwrapAngles(raw),
    cfg.trackResponsiveness ?? 0,
    cfg.reversalThresholdDeg,
    DEFAULT_POSITION_VARIANCE_DEG2,
  );
}

// --- depth ------------------------------------------------------------------

/** Distribute a swept arc across sectors, calling back with each sector's fraction. */
function distributeSweep(
  startAngle: number,
  delta: number,
  res: number,
  nSectors: number,
  cb: (sector: number, fraction: number) => void,
): void {
  const total = Math.abs(delta);
  if (total < 1e-9) {
    cb(Math.floor(normaliseAngle(startAngle) / res) % nSectors, 1);
    return;
  }
  const dir = Math.sign(delta);
  let remaining = total;
  let cursor = startAngle;
  let guard = 0;
  while (remaining > 1e-9 && guard < nSectors * 2 + 2) {
    guard++;
    const norm = normaliseAngle(cursor);
    const sector = Math.floor(norm / res) % nSectors;
    // distance to the next sector boundary in the direction of travel
    const within = dir > 0 ? res - (norm - sector * res) : norm - sector * res || res;
    const step = Math.min(remaining, within);
    cb(sector, step / total);
    cursor += dir * step;
    remaining -= step;
  }
}

/** Compute per-sector applied depth (mm) for one event's samples. */
export function computeSectorDepths(samples: Sample[], cfg: PivotConfig): SectorResult {
  const res = cfg.sectorResolutionDeg > 0 ? cfg.sectorResolutionDeg : 1;
  const nSectors = Math.max(1, Math.round(360 / res));
  const effRes = 360 / nSectors;
  const volume = new Float64Array(nSectors);
  const endGunUsed = new Array<boolean>(nSectors).fill(false);

  // Shared with the speed chart so the two views can never disagree.
  const track = buildTrack(samples, cfg);

  // The position tag only moves in steps, so integrating against the held value
  // dumps a whole interval into one sector. Interpolate the filtered track in
  // time instead. It is unwrapped, so the difference between two instants is
  // already a signed sweep and needs no shortest-path guess.
  const angleAt = (t: number): number | null => {
    if (track.length === 0) return null;
    if (t <= track[0].t) return track[0].a;
    const last = track[track.length - 1];
    if (t >= last.t) return last.a;
    let lo = 0;
    let hi = track.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (track[mid].t <= t) lo = mid;
      else hi = mid;
    }
    const fa = track[lo];
    const fb = track[hi];
    return fa.a + ((t - fa.t) / (fb.t - fa.t)) * (fb.a - fa.a);
  };

  for (let i = 0; i < samples.length - 1; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    const dtSec = (b.t - a.t) / 1000;
    if (dtSec <= 0) continue;
    const flowAvg = ((a.flow ?? 0) + (b.flow ?? 0)) / 2;
    if (flowAvg <= FLOW_EPS) continue;
    const angA = angleAt(a.t);
    const angB = angleAt(b.t);
    if (angA === null || angB === null) continue;
    const vol = flowToM3s(flowAvg, cfg.flowUnits) * dtSec; // m3 over this interval
    const endGun = Boolean(a.endGun || b.endGun);
    const delta = angB - angA;
    distributeSweep(normaliseAngle(angA), delta, effRes, nSectors, (sector, frac) => {
      volume[sector] += vol * frac;
      if (endGun) endGunUsed[sector] = true;
    });
  }

  const depthMm = new Float64Array(nSectors);
  const radiusM = new Float64Array(nSectors);
  const dTheta = (effRes * Math.PI) / 180;
  let maxDepth = 0;
  let sumDepth = 0;
  let counted = 0;
  let totalVol = 0;
  const nonZero: number[] = [];
  for (let s = 0; s < nSectors; s++) {
    const R = cfg.wettedRadiusM + (endGunUsed[s] ? cfg.endGunRadiusM : 0);
    radiusM[s] = R;
    const area = 0.5 * dTheta * R * R; // m2, pie wedge from r=0 to R
    const d = area > 0 ? (volume[s] / area) * 1000 : 0;
    depthMm[s] = d;
    totalVol += volume[s];
    if (d > 0) {
      maxDepth = Math.max(maxDepth, d);
      sumDepth += d;
      counted++;
      nonZero.push(d);
    }
  }

  // Clamp the colour scale to the 95th percentile so an outlier sector (e.g. a
  // parked pivot still flowing) doesn't compress everything else to one colour.
  const colourMax = percentile(nonZero, 0.95) || maxDepth;

  return {
    depthMm,
    radiusM,
    resolutionDeg: effRes,
    nSectors,
    maxDepthMm: maxDepth,
    colourMaxMm: colourMax,
    meanDepthMm: counted > 0 ? sumDepth / counted : 0,
    totalVolumeM3: totalVol,
  };
}

// --- geometry & GeoJSON -----------------------------------------------------

/** Forward geodesic: from (lat,lon) travel `distM` along `bearingDeg` (0=N, CW). */
export function destinationPoint(
  lat: number,
  lon: number,
  bearingDeg: number,
  distM: number,
): [number, number] {
  const d = distM / EARTH_RADIUS_M;
  const th = (bearingDeg * Math.PI) / 180;
  const p1 = (lat * Math.PI) / 180;
  const l1 = (lon * Math.PI) / 180;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(th));
  const l2 =
    l1 + Math.atan2(Math.sin(th) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return [(l2 * 180) / Math.PI, (p2 * 180) / Math.PI]; // GeoJSON order: [lon, lat]
}

export type GeoJSONFeatureCollection = {
  type: "FeatureCollection";
  metadata?: Record<string, unknown>;
  features: Array<{
    type: "Feature";
    geometry: { type: "Polygon"; coordinates: number[][][] };
    properties: {
      sector: number;
      depthMm: number;
      bearingFromDeg: number;
      bearingToDeg: number;
      radiusM: number;
      fill: string;
    };
  }>;
};

const ARC_STEP_DEG = 2; // polyline resolution along the outer arc

/** Build GeoJSON pie-wedge polygons for every sector that received water.
 * `metadata` is attached as a (RFC 7946 foreign member) top-level field. */
export function buildGeoJSON(
  result: SectorResult,
  cfg: PivotConfig,
  metadata?: Record<string, unknown>,
): GeoJSONFeatureCollection {
  const features: GeoJSONFeatureCollection["features"] = [];
  for (let s = 0; s < result.nSectors; s++) {
    const depth = result.depthMm[s];
    if (depth <= 0) continue;
    const R = result.radiusM[s];
    const startBearing = s * result.resolutionDeg + cfg.positionOffsetDeg;
    const endBearing = (s + 1) * result.resolutionDeg + cfg.positionOffsetDeg;

    const ring: number[][] = [[cfg.centreLon, cfg.centreLat]];
    for (let bAbs = startBearing; bAbs < endBearing; bAbs += ARC_STEP_DEG) {
      ring.push(destinationPoint(cfg.centreLat, cfg.centreLon, bAbs, R));
    }
    ring.push(destinationPoint(cfg.centreLat, cfg.centreLon, endBearing, R));
    ring.push([cfg.centreLon, cfg.centreLat]);

    features.push({
      type: "Feature",
      geometry: { type: "Polygon", coordinates: [ring] },
      properties: {
        sector: s,
        depthMm: Number(depth.toFixed(3)),
        bearingFromDeg: Number(startBearing.toFixed(2)),
        bearingToDeg: Number(endBearing.toFixed(2)),
        radiusM: R,
        fill: depthColour(depth, result.colourMaxMm),
      },
    });
  }
  const fc: GeoJSONFeatureCollection = { type: "FeatureCollection", features };
  if (metadata) fc.metadata = metadata;
  return fc;
}

/** Per-sector applied depth as CSV (only sectors that received water). */
export function toCSV(result: SectorResult, cfg: PivotConfig): string {
  const lines = ["sector,bearing_from_deg,bearing_to_deg,radius_m,depth_mm"];
  for (let s = 0; s < result.nSectors; s++) {
    if (result.depthMm[s] <= 0) continue;
    const from = s * result.resolutionDeg + cfg.positionOffsetDeg;
    const to = (s + 1) * result.resolutionDeg + cfg.positionOffsetDeg;
    lines.push(
      `${s},${from.toFixed(2)},${to.toFixed(2)},${result.radiusM[s].toFixed(1)},${result.depthMm[s].toFixed(2)}`,
    );
  }
  return lines.join("\n");
}

/** Evenly thin an array down to at most `max` items, keeping first and last. */
export function downsample<T>(arr: T[], max: number): T[] {
  if (arr.length <= max) return arr;
  const stride = Math.ceil(arr.length / max);
  const out: T[] = [];
  for (let i = 0; i < arr.length; i += stride) out.push(arr[i]);
  const last = arr[arr.length - 1];
  if (out[out.length - 1] !== last) out.push(last);
  return out;
}

// --- colour scale -----------------------------------------------------------

// Sequential scale, light -> deep, suited to "applied depth" (low to high).
const SCALE: Array<[number, number, number]> = [
  [255, 255, 204],
  [161, 218, 180],
  [65, 182, 196],
  [44, 127, 184],
  [37, 52, 148],
];

export function depthColour(depthMm: number, maxDepthMm: number): string {
  if (maxDepthMm <= 0) return "rgb(44,127,184)";
  const t = Math.max(0, Math.min(1, depthMm / maxDepthMm));
  const seg = t * (SCALE.length - 1);
  const i = Math.min(SCALE.length - 2, Math.floor(seg));
  const f = seg - i;
  const [r1, g1, b1] = SCALE[i];
  const [r2, g2, b2] = SCALE[i + 1];
  const r = Math.round(r1 + (r2 - r1) * f);
  const g = Math.round(g1 + (g2 - g1) * f);
  const b = Math.round(b1 + (b2 - b1) * f);
  return `rgb(${r},${g},${b})`;
}

/** Discrete legend stops for the depth colour scale. */
export function legendStops(maxDepthMm: number, n = 5): Array<{ depth: number; colour: string }> {
  const stops: Array<{ depth: number; colour: string }> = [];
  for (let i = 0; i < n; i++) {
    const depth = (maxDepthMm * i) / (n - 1);
    stops.push({ depth, colour: depthColour(depth, maxDepthMm) });
  }
  return stops;
}

/** Pick a Google Maps zoom level so the watered circle roughly fills the view. */
export function zoomForRadius(lat: number, radiusM: number, viewportPx = 480): number {
  const diameter = 2 * radiusM * 1.25; // a little margin
  const mpp = diameter / viewportPx;
  const z = Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180)) / mpp);
  return Math.max(5, Math.min(20, Math.round(z)));
}
