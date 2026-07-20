// Fetches City of Melbourne "Pedestrian Counting System" open data and
// precomputes a clean "typical day" hourly profile for every sensor.
//
// Output: public/data/heartbeat.json
//
// Data source: City of Melbourne Open Data (OpenDataSoft portal)
//   - pedestrian-counting-system-sensor-locations   (134 geo-located sensors)
//   - pedestrian-counting-system-monthly-counts-per-hour  (hourly counts)
// Licence: Creative Commons Attribution 4.0 (City of Melbourne).
//
// Run with:  npm run fetch-data
// Optional env:
//   BHOM_WINDOW_DAYS   number of trailing days to average over (default 365)

import { writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = resolve(__dirname, '..', 'public', 'data');
const OUT_FILE = resolve(OUT_DIR, 'heartbeat.json');

const PORTAL = 'https://melbournetestbed.opendatasoft.com';
const API = `${PORTAL}/api/explore/v2.1/catalog/datasets`;
const DS_COUNTS = 'pedestrian-counting-system-monthly-counts-per-hour';
const DS_SENSORS = 'pedestrian-counting-system-sensor-locations';

const WINDOW_DAYS = Number(process.env.BHOM_WINDOW_DAYS ?? 365);
const PAGE = 100; // OpenDataSoft max page size

/** Build a query string, percent-encoding values (spaces -> %20). */
function qs(params) {
  return Object.entries(params)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join('&');
}

/** GET JSON with a timeout and a couple of retries. */
async function getJson(url, attempt = 1) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.json();
  } catch (err) {
    if (attempt < 3) {
      await new Promise((r) => setTimeout(r, 500 * attempt));
      return getJson(url, attempt + 1);
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

async function main() {
  console.log('The Beating Heart of Melbourne - data prep');
  console.log('Portal:', PORTAL);

  // 1. Sensor locations (name + coordinates).
  console.log('\n[1/4] Fetching sensor locations...');
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
      status: r.status ?? null,
    });
  }
  console.log(`   -> ${sensorMeta.size} located sensors`);

  // 2. Latest available date, to anchor the averaging window.
  console.log('[2/4] Finding latest available date...');
  const latestRes = await getJson(
    `${API}/${DS_COUNTS}/records?${qs({ select: 'sensing_date', order_by: 'sensing_date desc', limit: 1 })}`,
  );
  const latest = latestRes.results?.[0]?.sensing_date;
  if (!latest) throw new Error('Could not determine latest sensing_date');
  const latestDate = new Date(`${latest}T00:00:00Z`);
  const startDate = new Date(latestDate);
  startDate.setUTCDate(startDate.getUTCDate() - WINDOW_DAYS);
  const startStr = startDate.toISOString().slice(0, 10);
  console.log(`   -> latest ${latest}; averaging over last ${WINDOW_DAYS} days (from ${startStr})`);

  // 3. Average pedestrian count per sensor, per hour of day, over the window.
  console.log('[3/4] Aggregating typical-day profile (24 hours)...');
  // hourly.get(locationId) -> number[24]
  const hourly = new Map();
  for (let h = 0; h < 24; h++) {
    const rows = await fetchAll(DS_COUNTS, {
      select: 'location_id, avg(pedestriancount) as c',
      where: `hourday=${h} and sensing_date>=date'${startStr}'`,
      group_by: 'location_id',
    });
    for (const r of rows) {
      const id = r.location_id;
      if (id == null) continue;
      if (!hourly.has(id)) hourly.set(id, new Array(24).fill(0));
      hourly.get(id)[h] = Math.round((r.c ?? 0) * 10) / 10;
    }
    process.stdout.write(`   hour ${String(h).padStart(2, '0')} `);
    if ((h + 1) % 6 === 0) process.stdout.write('\n');
  }

  // 4. Join coordinates + hourly profile, compute city totals.
  console.log('[4/4] Assembling output...');
  const sensors = [];
  let skipped = 0;
  for (const [id, series] of hourly) {
    const meta = sensorMeta.get(id);
    if (!meta) {
      skipped++;
      continue; // no coordinates available for this sensor
    }
    sensors.push({
      id,
      name: meta.name,
      lat: meta.lat,
      lon: meta.lon,
      hourly: series,
    });
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

  const payload = {
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

  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(OUT_FILE, JSON.stringify(payload));

  console.log('\nDone.');
  console.log(`   sensors written : ${sensors.length}${skipped ? ` (skipped ${skipped} without coords)` : ''}`);
  console.log(`   peak hour       : ${String(peakHour).padStart(2, '0')}:00  (${cityTotals[peakHour].toLocaleString()} ped/hr citywide)`);
  console.log(`   quiet hour      : ${String(quietHour).padStart(2, '0')}:00  (${cityTotals[quietHour].toLocaleString()} ped/hr citywide)`);
  console.log(`   output          : ${OUT_FILE}`);
}

main().catch((err) => {
  console.error('\nData prep failed:', err.message);
  process.exit(1);
});
