// Builds "focus view" data for multiple CBD locations.
//
// Output: public/data/focus-*.json
//
// Sources:
//   - Geocoding: Nominatim (OpenStreetMap)
//   - Street network: Overpass API (OpenStreetMap)
// Licence: OpenStreetMap data is (c) OpenStreetMap contributors, ODbL.
//
// Run with:  node scripts/fetch-focus-multi.mjs

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public', 'data');

const UA = 'BeatingHeartOfMelbourne/0.1 (open-data art project; tribute to data.pour.paris)';

// Locations to generate focus data for
const LOCATIONS = [
  {
    id: 'flinders-street',
    address: 'Flinders Street Station, Melbourne VIC 3000, Australia',
    label: 'Flinders Street Station',
    fallback: { lat: -37.817903, lon: 144.967102 },
  },
  {
    id: 'federation-square',
    address: 'Federation Square, Flinders Street, Melbourne VIC 3000, Australia',
    label: 'Federation Square',
    fallback: { lat: -37.823695, lon: 144.968765 },
  },
  {
    id: 'southern-cross',
    address: 'Southern Cross Station, Spencer Street, Melbourne VIC 3000, Australia',
    label: 'Southern Cross Station',
    fallback: { lat: -37.821204, lon: 144.952377 },
  },
  {
    id: 'flagstaff',
    address: 'Flagstaff Station, Melbourne VIC 3000, Australia',
    label: 'Flagstaff Station',
    fallback: { lat: -37.810225, lon: 144.946391 },
  },
];

// Bounding box around the Melbourne CBD to constrain geocoding.
// Order: lon_min, lat_min, lon_max, lat_max
const CBD_VIEWBOX = '144.945,-37.822,144.975,-37.806';
function inCbd(lat, lon) {
  return lat >= -37.822 && lat <= -37.806 && lon >= 144.945 && lon <= 144.975;
}

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

function qs(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

async function getJson(url, opts = {}, attempt = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } catch (err) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 700 * attempt));
      return getJson(url, opts, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function geocode(address) {
  try {
    const url = `https://nominatim.openstreetmap.org/search?${qs({
      q: address,
      format: 'json',
      limit: 5,
      addressdetails: 1,
      viewbox: CBD_VIEWBOX,
      bounded: 1,
    })}`;
    const rows = await getJson(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (Array.isArray(rows) && rows.length) {
      const hit =
        rows.find((r) => inCbd(Number(r.lat), Number(r.lon))) ?? rows[0];
      if (hit) {
        return {
          lat: Number(hit.lat),
          lon: Number(hit.lon),
          display: hit.display_name ?? address,
          source: 'nominatim',
        };
      }
      console.warn('   no CBD match in geocoder results, using fallback coordinates');
    }
  } catch (err) {
    console.warn('   geocoding failed, using fallback coordinates:', err.message);
  }
  return { lat: 0, lon: 0, display: address, source: 'fallback' };
}

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

async function generateFocus(location, radiusM = 350) {
  const { id, address, label, fallback } = location;
  console.log(`\nGenerating focus data for: ${label}`);

  console.log('  [1/3] Geocoding address...');
  let center = await geocode(address);
  if (center.source === 'fallback') {
    center = { ...center, ...fallback, source: 'fallback' };
  }
  console.log(`    -> ${round(center.lat)}, ${round(center.lon)} (${center.source})`);

  console.log(`  [2/3] Fetching street network within ${radiusM} m (Overpass)...`);
  const query = `[out:json][timeout:40];(way[highway](around:${radiusM},${center.lat},${center.lon}););out geom;`;
  const data = await overpass(query);
  const elements = data.elements ?? [];

  // Highway types we treat as "streets" worth highlighting
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

  console.log(`    -> ${features.length} street segments, ${streetNames.size} named streets`);

  console.log('  [3/3] Writing output...');
  const payload = {
    meta: {
      title: `Focus: ${label}`,
      address,
      display: center.display,
      radiusMeters: radiusM,
      source: 'OpenStreetMap (Nominatim + Overpass API)',
      licence: 'ODbL - (c) OpenStreetMap contributors',
      generatedAt: new Date().toISOString(),
      streetCount: features.length,
      namedStreets: [...streetNames].sort(),
    },
    center: { lat: round(center.lat), lon: round(center.lon), label },
    streets: { type: 'FeatureCollection', features },
  };

  const outFile = resolve(OUT_DIR, `focus-${id}.json`);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(outFile, JSON.stringify(payload));

  console.log(`    output: focus-${id}.json`);
  return { id, label, file: outFile, streetCount: features.length, namedStreets: [...streetNames].sort() };
}

async function main() {
  console.log('The Beating Heart of Melbourne - multi-location focus view data prep');

  const results = [];
  for (const location of LOCATIONS) {
    try {
      const result = await generateFocus(location);
      results.push(result);
    } catch (err) {
      console.error(`\nFailed to generate ${location.id}:`, err.message);
    }
  }

  console.log('\n\n=== Summary ===');
  for (const r of results) {
    console.log(`\n${r.label} (${r.id})`);
    console.log(`  Streets: ${r.streetCount}`);
    console.log(`  Top streets: ${r.namedStreets.slice(0, 8).join(', ')}`);
  }
  console.log('\nDone.');
}

main().catch((err) => {
  console.error('\nFocus data prep failed:', err.message);
  process.exit(1);
});
