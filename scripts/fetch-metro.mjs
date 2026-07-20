// Fetches the metropolitan train (heavy rail) network through the heart of
// Melbourne from OpenStreetMap - including the underground City Loop - and
// chains the ways into continuous polylines for animating trains along.
//
// Output: public/data/metro.json
//
// Source: OpenStreetMap via Overpass API (railway=rail).
// Licence: (c) OpenStreetMap contributors, ODbL.
//
// Run with:  npm run fetch-metro

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public', 'data');
const OUT_FILE = resolve(OUT_DIR, 'metro.json');

const UA = 'BeatingHeartOfMelbourne/0.1 (open-data art project; tribute to data.pour.paris)';

// Inner-city bbox: CBD + inner rail corridors (Richmond, South Yarra,
// Jolimont, North Melbourne/Kensington) so the lines visibly cross the heart.
// Order for Overpass: south, west, north, east.
const BBOX = { south: -37.86, west: 144.92, north: -37.79, east: 145.01 };

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// Service tracks we don't want to draw as through-lines.
const SKIP_SERVICE = new Set(['yard', 'siding', 'spur', 'crossover']);

async function overpass(query) {
  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': UA },
        body: `data=${encodeURIComponent(query)}`,
        signal: controller.signal,
      });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      console.warn(`   overpass endpoint failed (${endpoint}): ${err.message}`);
    }
  }
  throw lastErr ?? new Error('All Overpass endpoints failed');
}

const round = (n) => Math.round(n * 1e6) / 1e6;
const keyOf = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;

function segMeters(a, b) {
  const latMid = (((a[1] + b[1]) / 2) * Math.PI) / 180;
  const dx = (b[0] - a[0]) * Math.cos(latMid) * 111320;
  const dy = (b[1] - a[1]) * 110540;
  return Math.hypot(dx, dy);
}

function pathLength(coords) {
  let L = 0;
  for (let i = 1; i < coords.length; i++) L += segMeters(coords[i - 1], coords[i]);
  return L;
}

/** Greedily stitch ways that share endpoints into longer polylines. */
function chainWays(ways) {
  const used = new Array(ways.length).fill(false);
  const endpoints = new Map();
  const addEp = (k, wi) => {
    if (!endpoints.has(k)) endpoints.set(k, []);
    endpoints.get(k).push(wi);
  };
  ways.forEach((w, wi) => {
    addEp(keyOf(w[0]), wi);
    addEp(keyOf(w[w.length - 1]), wi);
  });

  const paths = [];
  for (let start = 0; start < ways.length; start++) {
    if (used[start]) continue;
    used[start] = true;
    let path = ways[start].slice();

    const extend = (side) => {
      for (;;) {
        const endCoord = side === 'end' ? path[path.length - 1] : path[0];
        const k = keyOf(endCoord);
        const next = (endpoints.get(k) || []).find((wi) => !used[wi]);
        if (next === undefined) break;
        used[next] = true;
        let seg = ways[next].slice();
        if (keyOf(seg[0]) !== k) seg.reverse();
        if (side === 'end') path = path.concat(seg.slice(1));
        else path = seg.slice(1).reverse().concat(path);
      }
    };
    extend('end');
    extend('start');

    const cleaned = path.filter((c, i) => i === 0 || keyOf(c) !== keyOf(path[i - 1]));
    if (cleaned.length >= 2) paths.push(cleaned);
  }
  return paths;
}

async function main() {
  console.log('The Beating Heart of Melbourne - metro network data prep');
  console.log('BBox:', BBOX);

  console.log('\n[1/3] Fetching heavy-rail tracks (Overpass)...');
  const query = `[out:json][timeout:60];(way["railway"="rail"](${BBOX.south},${BBOX.west},${BBOX.north},${BBOX.east}););out geom;`;
  const data = await overpass(query);

  const elements = data.elements ?? [];
  let skippedService = 0;
  const ways = [];
  for (const el of elements) {
    if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
    const t = el.tags ?? {};
    if (t.service && SKIP_SERVICE.has(t.service)) {
      skippedService++;
      continue; // skip sidings/yards/crossovers - keep through-running lines
    }
    ways.push(el.geometry.map((p) => [round(p.lon), round(p.lat)]));
  }
  console.log(`   -> ${ways.length} running-line ways (skipped ${skippedService} service tracks)`);

  console.log('[2/3] Chaining ways into continuous paths...');
  const chained = chainWays(ways);
  const paths = chained
    .map((coords) => ({ coords, length: pathLength(coords) }))
    .filter((p) => p.length >= 150)
    .sort((a, b) => b.length - a.length);

  const totalKm = paths.reduce((s, p) => s + p.length, 0) / 1000;
  console.log(`   -> ${paths.length} paths, ${totalKm.toFixed(1)} km of track`);

  console.log('[3/3] Writing output...');
  const features = paths.map((p) => ({
    type: 'Feature',
    properties: { lengthM: Math.round(p.length) },
    geometry: { type: 'LineString', coordinates: p.coords },
  }));

  const payload = {
    meta: {
      title: 'Melbourne metropolitan train network (inner city)',
      source: 'OpenStreetMap via Overpass API (railway=rail)',
      licence: 'ODbL - (c) OpenStreetMap contributors',
      generatedAt: new Date().toISOString(),
      bbox: BBOX,
      wayCount: ways.length,
      pathCount: paths.length,
      totalKm: Math.round(totalKm * 10) / 10,
    },
    paths: { type: 'FeatureCollection', features },
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(payload));

  console.log('\nDone.');
  console.log(`   longest path : ${Math.round(paths[0]?.length ?? 0)} m (${paths[0]?.coords.length ?? 0} points)`);
  console.log(`   output       : ${OUT_FILE}`);
}

main().catch((err) => {
  console.error('\nMetro data prep failed:', err.message);
  process.exit(1);
});
