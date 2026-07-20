// Small math / colour helpers shared across the visualisation.

export type RGB = [number, number, number];

export function clamp(x: number, lo = 0, hi = 1): number {
  return x < lo ? lo : x > hi ? hi : x;
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/**
 * Sample a looping 24-value series at a fractional hour in [0, 24),
 * linearly interpolating between hours (wrapping across midnight).
 */
export function sampleSeries(series: number[], hours: number): number {
  const n = series.length;
  if (n === 0) return 0;
  const t = ((hours % n) + n) % n;
  const h0 = Math.floor(t) % n;
  const h1 = (h0 + 1) % n;
  return lerp(series[h0], series[h1], t - Math.floor(t));
}

// Calm indigo (night) -> magenta -> crimson -> hot amber (peak).
const RAMP: Array<[number, RGB]> = [
  [0.0, [26, 18, 58]],
  [0.3, [124, 32, 120]],
  [0.55, [214, 41, 97]],
  [0.78, [255, 74, 92]],
  [1.0, [255, 210, 138]],
];

export function colorRamp(t: number): RGB {
  const x = clamp(t);
  for (let i = 1; i < RAMP.length; i++) {
    const [t1, c1] = RAMP[i];
    if (x <= t1) {
      const [t0, c0] = RAMP[i - 1];
      const f = (x - t0) / (t1 - t0 || 1);
      return [lerp(c0[0], c1[0], f), lerp(c0[1], c1[1], f), lerp(c0[2], c1[2], f)];
    }
  }
  const last = RAMP[RAMP.length - 1][1];
  return [last[0], last[1], last[2]];
}

export function mixWhite(c: RGB, amt: number): RGB {
  return [lerp(c[0], 255, amt), lerp(c[1], 255, amt), lerp(c[2], 255, amt)];
}

export function rgbCss(c: RGB): string {
  return `rgb(${c[0] | 0}, ${c[1] | 0}, ${c[2] | 0})`;
}

/**
 * A stylised cardiac pulse over phase [0, 1): a sharp systolic spike
 * followed by a smaller dicrotic bump, otherwise resting near 0.
 * Returns roughly 0..1.
 */
export function cardiac(p: number): number {
  const systole = Math.exp(-Math.pow((p - 0.14) / 0.05, 2));
  const dicrotic = 0.45 * Math.exp(-Math.pow((p - 0.34) / 0.07, 2));
  return Math.min(1, systole + dicrotic);
}

/** Format a fractional hour (0..24) as HH:MM. */
export function formatClock(hours: number): string {
  const t = ((hours % 24) + 24) % 24;
  const h = Math.floor(t);
  const m = Math.floor((t - h) * 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** Great-circle distance between two lat/lon points, in metres. */
export function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * toRad) * Math.cos(lat2 * toRad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
