// One-off script to fetch Southern Cross Station focus data.
// Separated out so it can be retried after Overpass rate-limit clears.
// Run with:  node scripts/fetch-focus-southern-cross.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public', 'data');

const UA = 'BeatingHeartOfMelbourne/0.1 (open-data art project; tribute to data.pour.paris)';

// Known accurate coordinates for Southern Cross Station (Spencer Street concourse)
const CENTER = { lat: -37.818498, lon: 144.952473 };
const LABEL = 'Southern Cross Station';
const RADIUS_M = 350;

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

async function overpass(query) {
  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45_000);
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

function round(n) {
  return Math.round(n * 1e6) / 1e6;
}

async function main() {
  console.log('Fetching Southern Cross Station focus data...');
  console.log(`  Center: ${CENTER.lat}, ${CENTER.lon}`);

  console.log(`  Fetching street network within ${RADIUS_M} m (Overpass)...`);
  const query = `[out:json][timeout:40];(way[highway](around:${RADIUS_M},${CENTER.lat},${CENTER.lon}););out geom;`;
  const data = await overpass(query);
  const elements = data.elements ?? [];

  const KEEP = new Set([
    'motorway', 'trunk', 'primary', 'secondary', 'tertiary',
    'unclassified', 'residential', 'living_street', 'pedestrian',
    'service', 'footway',
  ]);

  const features = [];
  const streetNames = new Set();
  for (const el of elements) {
    if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
    const highway = el.tags?.highway;
    if (!highway || !KEEP.has(highway)) continue;
    const coords = el.geometry.map((p) => [round(p.lon), round(p.lat)]);
    if (coords.length < 2) continue;
    const name = el.tags?.name ?? null;
    if (name) streetNames.add(name);
    features.push({
      type: 'Feature',
      properties: {
        name,
        highway,
        major: ['primary', 'secondary', 'tertiary', 'trunk', 'motorway'].includes(highway),
      },
      geometry: { type: 'LineString', coordinates: coords },
    });
  }

  console.log(`  -> ${features.length} street segments, ${streetNames.size} named streets`);

  const payload = {
    meta: {
      title: `Focus: ${LABEL}`,
      address: 'Southern Cross Station, Spencer Street, Melbourne VIC 3000, Australia',
      display: 'Southern Cross Station, Spencer Street, Melbourne VIC 3000, Australia',
      radiusMeters: RADIUS_M,
      source: 'OpenStreetMap (Overpass API)',
      licence: 'ODbL - (c) OpenStreetMap contributors',
      generatedAt: new Date().toISOString(),
      streetCount: features.length,
      namedStreets: [...streetNames].sort(),
    },
    center: { lat: CENTER.lat, lon: CENTER.lon, label: LABEL },
    streets: { type: 'FeatureCollection', features },
  };

  const outFile = resolve(OUT_DIR, 'focus-southern-cross.json');
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(outFile, JSON.stringify(payload));
  console.log(`  Output: ${outFile}`);
  console.log('Done.');
}

main().catch((err) => {
  console.error('Failed:', err.message);
  process.exit(1);
});
