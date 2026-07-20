// Builds procedural flight data for the Melbourne region: real airport
// positions and primary runway bearings from OpenStreetMap, plus derived
// arrival/departure corridors radiating from each airport. The flights
// themselves are simulated (a service-level model), but the airports and
// runway orientations are real.
//
// Output: public/data/flights.json
//
// Source: OpenStreetMap via Overpass API (aeroway=runway / aerodrome).
// Licence: (c) OpenStreetMap contributors, ODbL.
//
// Run with:  npm run fetch-flights

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public', 'data');
const OUT_FILE = resolve(OUT_DIR, 'flights.json');

const UA = 'BeatingHeartOfMelbourne/0.1 (open-data art project; tribute to data.pour.paris)';

// Region covering Melbourne's airports: Tullamarine, Essendon, Avalon,
// Moorabbin (+ smaller fields). Order: south, west, north, east.
const REGION = { south: -38.1, west: 144.35, north: -37.55, east: 145.25 };

const CORRIDOR_LEN_M = 55000; // how far corridors extend from each airport
const MAX_AIRPORTS = 6;
const MIN_RUNWAY_M = 900; // drop tiny airstrips / helipads

const OVERPASS_ENDPOINTS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

// Used if Overpass is unavailable, so the script always produces output.
const FALLBACK_AIRPORTS = [
  { name: 'Melbourne Airport', iata: 'MEL', icao: 'YMML', lat: -37.669, lon: 144.841, bearing: 163, runwayM: 3657 },
  { name: 'Essendon Fields Airport', iata: 'MEB', icao: 'YMEN', lat: -37.7281, lon: 144.902, bearing: 170, runwayM: 1921 },
  { name: 'Avalon Airport', iata: 'AVV', icao: 'YMAV', lat: -38.0394, lon: 144.4694, bearing: 180, runwayM: 3048 },
  { name: 'Moorabbin Airport', iata: 'MBW', icao: 'YMMB', lat: -37.9758, lon: 145.1022, bearing: 135, runwayM: 1335 },
];

const round = (n) => Math.round(n * 1e6) / 1e6;

async function overpass(query) {
  let lastErr;
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const controller = new AbortController();
      // Short timeout: airports are static and we have a solid fallback, so
      // fail fast rather than hang if Overpass is slow/unavailable.
      const timer = setTimeout(() => controller.abort(), 20_000);
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

function segMeters(a, b) {
  const latMid = (((a[1] + b[1]) / 2) * Math.PI) / 180;
  const dx = (b[0] - a[0]) * Math.cos(latMid) * 111320;
  const dy = (b[1] - a[1]) * 110540;
  return Math.hypot(dx, dy);
}

function bearingDeg(a, b) {
  const latMid = (((a[1] + b[1]) / 2) * Math.PI) / 180;
  const dE = (b[0] - a[0]) * Math.cos(latMid);
  const dN = b[1] - a[1];
  return (((Math.atan2(dE, dN) * 180) / Math.PI) + 360) % 360;
}

function dest(lat, lon, brDeg, distM) {
  const br = (brDeg * Math.PI) / 180;
  const dLat = (distM * Math.cos(br)) / 110540;
  const dLon = (distM * Math.sin(br)) / (111320 * Math.cos((lat * Math.PI) / 180));
  return [round(lon + dLon), round(lat + dLat)];
}

async function fetchAirports() {
  const bbox = `${REGION.south},${REGION.west},${REGION.north},${REGION.east}`;

  // Two simple queries avoid fragile set-assignment syntax.
  const runwayData = await overpass(
    `[out:json][timeout:20];way["aeroway"="runway"](${bbox});out geom;`,
  );
  const aerodromeData = await overpass(
    `[out:json][timeout:20];(node["aeroway"="aerodrome"](${bbox});way["aeroway"="aerodrome"](${bbox});relation["aeroway"="aerodrome"](${bbox}););out center;`,
  );

  const runways = [];
  for (const el of runwayData.elements ?? []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry) || el.geometry.length < 2) continue;
    const coords = el.geometry.map((p) => [p.lon, p.lat]);
    const a = coords[0];
    const b = coords[coords.length - 1];
    runways.push({ a, b, len: segMeters(a, b) });
  }

  const aerodromes = [];
  for (const el of aerodromeData.elements ?? []) {
    const t = el.tags ?? {};
    if (t.aeroway !== 'aerodrome') continue;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;
    aerodromes.push({
      name: t.name ?? t['name:en'] ?? null,
      iata: t.iata ?? null,
      icao: t.icao ?? null,
      lat,
      lon,
    });
  }

  // Attach the longest nearby runway (within 5 km) to each aerodrome.
  for (const ad of aerodromes) {
    let best = null;
    for (const rw of runways) {
      const mid = [(rw.a[0] + rw.b[0]) / 2, (rw.a[1] + rw.b[1]) / 2];
      if (segMeters([ad.lon, ad.lat], mid) > 5000) continue;
      if (!best || rw.len > best.len) best = rw;
    }
    if (best) {
      ad.runwayM = Math.round(best.len);
      ad.bearing = Math.round(bearingDeg(best.a, best.b));
    }
  }

  return aerodromes
    .filter((a) => a.runwayM && (a.runwayM >= MIN_RUNWAY_M || a.iata))
    .filter((a) => a.name || a.iata || a.icao)
    .sort((a, b) => b.runwayM - a.runwayM)
    .slice(0, MAX_AIRPORTS);
}

function buildCorridors(airports) {
  const corridors = [];
  for (const ap of airports) {
    const b = ap.bearing ?? 0;
    const bearings = [b - 30, b, b + 30, b + 150, b + 180, b + 210].map((x) => ((x % 360) + 360) % 360);
    for (const brg of bearings) {
      corridors.push({
        airport: ap.iata ?? ap.icao ?? ap.name,
        coords: [[round(ap.lon), round(ap.lat)], dest(ap.lat, ap.lon, brg, CORRIDOR_LEN_M)],
      });
    }
  }
  return corridors;
}

async function main() {
  console.log('The Beating Heart of Melbourne - flights data prep');
  console.log('Region:', REGION);

  console.log('\n[1/3] Fetching airports + runways (Overpass)...');
  let airports;
  try {
    airports = await fetchAirports();
    if (airports.length < 2) throw new Error(`only ${airports.length} airports found`);
    console.log(`   -> ${airports.length} airports from OSM`);
  } catch (err) {
    console.warn(`   using fallback airports: ${err.message}`);
    airports = FALLBACK_AIRPORTS.slice();
  }
  airports = airports.map((a) => ({
    name: a.name ?? a.iata ?? a.icao,
    iata: a.iata ?? null,
    icao: a.icao ?? null,
    lat: round(a.lat),
    lon: round(a.lon),
    bearing: a.bearing ?? 0,
    runwayM: a.runwayM ?? null,
  }));

  console.log('[2/3] Building arrival/departure corridors...');
  const corridors = buildCorridors(airports);
  console.log(`   -> ${corridors.length} corridors`);

  console.log('[3/3] Writing output...');
  const payload = {
    meta: {
      title: 'Melbourne region flights (procedural)',
      source: 'OpenStreetMap via Overpass API (aeroway); flight movements simulated',
      licence: 'ODbL - (c) OpenStreetMap contributors (airport/runway geometry)',
      generatedAt: new Date().toISOString(),
      region: REGION,
      corridorLengthM: CORRIDOR_LEN_M,
      airportCount: airports.length,
    },
    airports,
    corridors,
  };

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(payload));

  console.log('\nDone.');
  for (const a of airports) {
    console.log(`   ${(a.iata ?? '----').padEnd(4)} ${a.name} - runway ${a.runwayM ?? '?'} m, bearing ${a.bearing}deg`);
  }
  console.log(`   output: ${OUT_FILE}`);
}

main().catch((err) => {
  console.error('\nFlights data prep failed:', err.message);
  process.exit(1);
});
