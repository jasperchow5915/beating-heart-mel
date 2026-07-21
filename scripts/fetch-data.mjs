// Fetches City of Melbourne "Pedestrian Counting System" open data and
// precomputes:
//   1. a clean "typical day" hourly profile for every sensor  -> heartbeat.json
//   2. per-date hourly profiles for a trailing window          -> day/<date>.json
//      plus an index of available dates                        -> day/index.json
//
// Because historical counts are immutable, serving these as static files means
// the app never calls the API at runtime (no rate limits, scales on the CDN).
//
// Data source: City of Melbourne Open Data (OpenDataSoft portal)
//   - pedestrian-counting-system-sensor-locations
//   - pedestrian-counting-system-monthly-counts-per-hour
// Licence: Creative Commons Attribution 4.0 (City of Melbourne).
//
// Run with:  npm run fetch-data
// Optional env:
//   BHOM_WINDOW_DAYS   trailing days for the typical-day average (default 365)
//   BHOM_DAYS          trailing days of selectable per-date files (default 90; 0 to skip)

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public', 'data');
const OUT_FILE = resolve(OUT_DIR, 'heartbeat.json');
const DAY_DIR = resolve(OUT_DIR, 'day');

const PORTAL = 'https://melbournetestbed.opendatasoft.com';
const API = `${PORTAL}/api/explore/v2.1/catalog/datasets`;
const DS_COUNTS = 'pedestrian-counting-system-monthly-counts-per-hour';
const DS_SENSORS = 'pedestrian-counting-system-sensor-locations';

const WINDOW_DAYS = Number(process.env.BHOM_WINDOW_DAYS ?? 365);
const DAYS = Number(process.env.BHOM_DAYS ?? 90);
const CHUNK_DAYS = 30; // one export request per ~month
const PAGE = 100; // OpenDataSoft max page size for the records endpoint

const iso = (d) => d.toISOString().slice(0, 10);

function qs(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/** GET JSON with a timeout and a couple of retries. */
async function getJson(url, timeoutMs = 30_000, attempt = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } catch (err) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 700 * attempt));
      return getJson(url, timeoutMs, attempt + 1);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** Fetch every page of a records query, concatenating results. */
async function fetchAll(dataset, params) {
  const out = [];
  for (let offset = 0; ; offset += PAGE) {
    const url = `${API}/${dataset}/records?${qs({ ...params, limit: PAGE, offset })}`;
    const json = await getJson(url);
    const results = json.results ?? [];
    out.push(...results);
    if (results.length < PAGE) break;
    if (offset > 5000) break; // safety valve
  }
  return out;
}

/** Fetch all rows for a query in one call via the exports endpoint (no row cap). */
async function fetchExport(dataset, params) {
  const url = `${API}/${dataset}/exports/json?${qs(params)}`;
  const json = await getJson(url, 90_000);
  return Array.isArray(json) ? json : [];
}

async function loadSensors() {
  const sensorRows = await fetchAll(DS_SENSORS, {
    select: 'location_id, sensor_description, latitude, longitude, status',
  });
  const sensorMeta = new Map();
  for (const r of sensorRows) {
    if (r.location_id == null || r.latitude == null || r.longitude == null) continue;
    sensorMeta.set(r.location_id, {
      id: r.location_id,
      name: r.sensor_description ?? `Sensor ${r.location_id}`,
      lat: r.latitude,
      lon: r.longitude,
    });
  }
  return sensorMeta;
}

/** Phase 1: the averaged "typical day". */
async function buildTypicalDay(sensorMeta, latest) {
  const startDate = new Date(`${latest}T00:00:00Z`);
  startDate.setUTCDate(startDate.getUTCDate() - WINDOW_DAYS);
  const startStr = iso(startDate);
  console.log(`   averaging over last ${WINDOW_DAYS} days (from ${startStr})`);

  const hourly = new Map();
  for (let h = 0; h < 24; h++) {
    const rows = await fetchAll(DS_COUNTS, {
      select: 'location_id, avg(pedestriancount) as c',
      where: `hourday=${h} and sensing_date>=date'${startStr}'`,
      group_by: 'location_id',
    });
    for (const r of rows) {
      if (r.location_id == null) continue;
      if (!hourly.has(r.location_id)) hourly.set(r.location_id, new Array(24).fill(0));
      hourly.get(r.location_id)[h] = Math.round((r.c ?? 0) * 10) / 10;
    }
  }

  const sensors = [];
  for (const [id, series] of hourly) {
    const meta = sensorMeta.get(id);
    if (!meta) continue;
    sensors.push({ id, name: meta.name, lat: meta.lat, lon: meta.lon, hourly: series });
  }
  sensors.sort((a, b) => a.id - b.id);

  const cityTotals = new Array(24).fill(0);
  let maxSensorHourly = 0;
  for (const s of sensors) {
    for (let h = 0; h < 24; h++) {
      cityTotals[h] += s.hourly[h];
      if (s.hourly[h] > maxSensorHourly) maxSensorHourly = s.hourly[h];
    }
  }
  for (let h = 0; h < 24; h++) cityTotals[h] = Math.round(cityTotals[h]);
  const peakHour = cityTotals.indexOf(Math.max(...cityTotals));
  const quietHour = cityTotals.indexOf(Math.min(...cityTotals));

  return {
    meta: {
      title: 'The Beating Heart of Melbourne',
      source: 'City of Melbourne Open Data - Pedestrian Counting System',
      portal: PORTAL,
      datasets: [DS_SENSORS, DS_COUNTS],
      licence: 'CC BY 4.0 (City of Melbourne)',
      windowDays: WINDOW_DAYS,
      windowStart: startStr,
      windowEnd: latest,
      generatedAt: new Date().toISOString(),
      sensorCount: sensors.length,
      peakHour,
      quietHour,
      maxSensorHourly,
    },
    sensors,
    cityTotals,
  };
}

/** Phase 2: one file per date for the trailing window, fetched month by month. */
async function buildPerDate(sensorMeta, latest) {
  await mkdir(DAY_DIR, { recursive: true });
  const latestDate = new Date(`${latest}T00:00:00Z`);
  const windowStart = new Date(latestDate);
  windowStart.setUTCDate(windowStart.getUTCDate() - (DAYS - 1));

  const written = [];
  let cursor = new Date(windowStart);
  while (cursor <= latestDate) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + CHUNK_DAYS - 1);
    if (chunkEnd > latestDate) chunkEnd.setTime(latestDate.getTime());

    const from = iso(cursor);
    const to = iso(chunkEnd);
    process.stdout.write(`   ${from} -> ${to} `);
    const rows = await fetchExport(DS_COUNTS, {
      select: 'location_id,sensing_date,hourday,pedestriancount',
      where: `sensing_date>=date'${from}' and sensing_date<=date'${to}'`,
    });
    process.stdout.write(`(${rows.length} rows)\n`);

    // Bucket rows: date -> (locationId -> number[24]).
    const byDate = new Map();
    for (const r of rows) {
      const d = r.sensing_date;
      const id = r.location_id;
      const h = r.hourday;
      if (d == null || id == null || h == null || !sensorMeta.has(id)) continue;
      if (!byDate.has(d)) byDate.set(d, new Map());
      const m = byDate.get(d);
      if (!m.has(id)) m.set(id, new Array(24).fill(0));
      m.get(id)[h] = r.pedestriancount ?? 0;
    }

    for (const [date, perSensor] of byDate) {
      const hourlyById = {};
      const cityTotals = new Array(24).fill(0);
      for (const [id, arr] of perSensor) {
        hourlyById[id] = arr;
        for (let h = 0; h < 24; h++) cityTotals[h] += arr[h];
      }
      await writeFile(
        resolve(DAY_DIR, `${date}.json`),
        JSON.stringify({ date, hourlyById, cityTotals }),
      );
      written.push(date);
    }

    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  written.sort();
  const index = {
    generatedAt: new Date().toISOString(),
    source: 'City of Melbourne Open Data - Pedestrian Counting System',
    licence: 'CC BY 4.0 (City of Melbourne)',
    earliest: written[0] ?? null,
    latest: written[written.length - 1] ?? null,
    count: written.length,
    dates: written,
  };
  await writeFile(resolve(DAY_DIR, 'index.json'), JSON.stringify(index));
  return index;
}

async function main() {
  console.log('The Beating Heart of Melbourne - data prep');
  console.log('Portal:', PORTAL);

  console.log('\n[1/4] Fetching sensor locations...');
  const sensorMeta = await loadSensors();
  console.log(`   -> ${sensorMeta.size} located sensors`);

  console.log('[2/4] Finding latest available date...');
  const latestRes = await getJson(
    `${API}/${DS_COUNTS}/records?${qs({ select: 'sensing_date', order_by: 'sensing_date desc', limit: 1 })}`,
  );
  const latest = latestRes.results?.[0]?.sensing_date;
  if (!latest) throw new Error('Could not determine latest sensing_date');
  console.log(`   -> latest ${latest}`);

  console.log('[3/4] Building typical-day profile...');
  const typical = await buildTypicalDay(sensorMeta, latest);
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(typical));
  console.log(
    `   -> ${typical.sensors.length} sensors; peak ${String(typical.meta.peakHour).padStart(2, '0')}:00 (${typical.cityTotals[typical.meta.peakHour].toLocaleString()} ped/hr)`,
  );

  if (DAYS > 0) {
    console.log(`[4/4] Building per-date files (last ${DAYS} days)...`);
    const index = await buildPerDate(sensorMeta, latest);
    console.log(`   -> ${index.count} day files (${index.earliest} .. ${index.latest})`);
  } else {
    console.log('[4/4] Skipping per-date files (BHOM_DAYS=0)');
  }

  console.log('\nDone.');
  console.log(`   typical day : ${OUT_FILE}`);
  console.log(`   per-date    : ${DAY_DIR}/<date>.json + index.json`);
}

main().catch((err) => {
  console.error('\nData prep failed:', err.message);
  process.exit(1);
});
