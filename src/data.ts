// Types and loader for the precomputed "typical day" pedestrian profile.
// Generate the data file with:  npm run fetch-data

export interface Sensor {
  id: number;
  name: string;
  lat: number;
  lon: number;
  /** Average pedestrians per hour, indexed 0..23. */
  hourly: number[];
}

export interface HeartbeatMeta {
  title: string;
  source: string;
  portal: string;
  datasets: string[];
  licence: string;
  windowDays: number;
  windowStart: string;
  windowEnd: string;
  generatedAt: string;
  sensorCount: number;
  peakHour: number;
  quietHour: number;
  maxSensorHourly: number;
}

export interface HeartbeatData {
  meta: HeartbeatMeta;
  sensors: Sensor[];
  /** Citywide total pedestrians per hour, indexed 0..23. */
  cityTotals: number[];
}

export async function loadHeartbeat(): Promise<HeartbeatData> {
  const url = `${import.meta.env.BASE_URL}data/heartbeat.json`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Could not load ${url} (HTTP ${res.status}). Run "npm run fetch-data" to generate it.`,
    );
  }
  return (await res.json()) as HeartbeatData;
}


/** Index of the available per-date files (public/data/day/index.json). */
export interface DayIndex {
  earliest: string | null;
  latest: string | null;
  count: number;
  dates: string[];
}

/** A single date's hourly profile (public/data/day/<date>.json). */
export interface DayData {
  date: string;
  /** location_id -> 24 hourly counts. */
  hourlyById: Record<string, number[]>;
  cityTotals: number[];
}

export async function loadDayIndex(): Promise<DayIndex | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/day/index.json`);
    if (!res.ok) return null;
    return (await res.json()) as DayIndex;
  } catch {
    return null;
  }
}

export async function loadDay(date: string): Promise<DayData | null> {
  try {
    const res = await fetch(`${import.meta.env.BASE_URL}data/day/${date}.json`);
    if (!res.ok) return null;
    return (await res.json()) as DayData;
  } catch {
    return null;
  }
}
