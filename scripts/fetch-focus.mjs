// Builds the "focus view" data for a single address: geocodes it and pulls the
// surrounding street network from OpenStreetMap.
//
// Output: public/data/focus-william-st.json
//
// Sources:
//   - Geocoding: Nominatim (OpenStreetMap)
//   - Street network: Overpass API (OpenStreetMap)
// Licence: OpenStreetMap data is (c) OpenStreetMap contributors, ODbL.
//
// Run with:  npm run fetch-focus

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public', 'data');
const OUT_FILE = resolve(OUT_DIR, 'focus-william-st.json');

const ADDRESS = '188 William Street, Melbourne VIC 3000, Australia';
const LABEL = '188 William Street';
const RADIUS_M = 350; // streets within this many metres of the address
const UA = 'BeatingHeartOfMelbourne/0.1 (open-data art project; tribute to data.pour.paris)';

// Known coordinates of the CBD tower (OSM), used as a fallback and to reject
// the unrelated "188 William Street" in the suburb of St Albans (postcode 3021).
const FALLBACK = { lat: -37.8147564, lon: 144.9580902 };

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

async function geocode() {
  try {
    // Structured query, restricted to the CBD viewbox so we don't match the
    // "188 William Street" in the St Albans suburb.
    const url = `https://nominatim.openstreetmap.org/search?${qs({
      street: '188 William Street',
      city: 'Melbourne',
      state: 'Victoria',
      postalcode: '3000',
      country: 'Australia',
      format: 'json',
      limit: 5,
      addressdetails: 1,
      viewbox: CBD_VIEWBOX,
      bounded: 1,
    })}`;
    const rows = await getJson(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } });
    if (Array.isArray(rows) && rows.length) {
      const hit =
        rows.find((r) => inCbd(Number(r.lat), Number(r.lon))) ??
        rows.find((r) => r.address?.postcode === '3000');
      if (hit) {
        return {
          lat: Number(hit.lat),
          lon: Number(hit.lon),
          display: hit.display_name ?? ADDRESS,
          source: 'nominatim',
        };
      }
      console.warn('   no CBD match in geocoder results, using fallback coordinates');
    }
  } catch (err) {
    console.warn('   geocoding failed, using fallback coordinates:', err.message);
  }
  return { ...FALLBACK, display: `${ADDRESS} (fallback coordinates)`, source: 'fallback' };
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

async function main() {
  console.log('The Beating Heart of Melbourne - focus view data prep');
  console.log('Address:', ADDRESS);

  console.log('\n[1/3] Geocoding address...');
  const center = await geocode();
  console.log(`   -> ${center.lat}, ${center.lon} (${center.source})`);

  console.log(`[2/3] Fetching street network within ${RADIUS_M} m (Overpass)...`);
  const query = `[out:json][timeout:40];(way[highway](around:${RADIUS_M},${center.lat},${center.lon}););out geom;`;
  const data = await overpass(query);
  const elements = data.elements ?? [];

  // Highway types we treat as "streets" worth highlighting (includes Melbourne laneways).
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

  console.log(`   -> ${features.length} street segments, ${streetNames.size} named streets`);

  console.log('[3/3] Writing output...');
  const payload = {
    meta: {
      title: 'Focus: 188 William Street',
      address: ADDRESS,
      display: center.display,
      radiusMeters: RADIUS_M,
      source: 'OpenStreetMap (Nominatim + Overpass API)',
      licence: 'ODbL - (c) OpenStreetMap contributors',
      generatedAt: new Date().toISOString(),
      streetCount: features.length,
      namedStreets: [...streetNames].sort(),
    },
    center: { lat: round(center.lat), lon: round(center.lon), label: LABEL },
    streets: { type: 'FeatureCollection', features },
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(payload));

  console.log('\nDone.');
  console.log(`   named streets : ${[...streetNames].sort().slice(0, 12).join(', ')}${streetNames.size > 12 ? ' ...' : ''}`);
  console.log(`   output        : ${OUT_FILE}`);
}

main().catch((err) => {
  console.error('\nFocus data prep failed:', err.message);
  process.exit(1);
});
