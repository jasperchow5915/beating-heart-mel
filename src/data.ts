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
