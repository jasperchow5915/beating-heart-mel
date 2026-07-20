import maplibregl, { type GeoJSONSource } from 'maplibre-gl';
import { clamp } from './util';

/** Visual + behavioural configuration for one transit network (tram, metro, ...). */
export interface TransitConfig {
  /** Unique prefix used for source/layer ids, e.g. 'tram' or 'metro'. */
  id: string;
  lineGlow: string;
  lineCore: string;
  vehicleGlow: string;
  lineWidthGlow: number;
  lineWidthCore: number;
  /** Metres between vehicles at full service. */
  spacingPeak: number;
  /** Global cap on animated vehicles for this network. */
  maxVehicles: number;
  /** Ground metres a vehicle glides per simulated hour (visual only). */
  visualMetersPerHour: number;
  vehicleRadius: number;
  /** Service level across the day as [hour, level(0..1)] control points. */
  service: Array<[number, number]>;
}

interface TransitData {
  meta: { totalKm: number; pathCount: number; source: string; licence: string };
  paths: GeoJSON.FeatureCollection;
}

interface NetPath {
  coords: Array<[number, number]>;
  cum: number[];
  length: number;
  capacity: number;
}

interface VehicleFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { r: number };
}

function segMeters(a: [number, number], b: [number, number]): number {
  const latMid = (((a[1] + b[1]) / 2) * Math.PI) / 180;
  const dx = (b[0] - a[0]) * Math.cos(latMid) * 111320;
  const dy = (b[1] - a[1]) * 110540;
  return Math.hypot(dx, dy);
}

/**
 * Draws a transit network's tracks and animates vehicles running along them.
 * The number of vehicles and their brightness follow a time-of-day service
 * curve on the same clock as the pedestrian pulse: busy at peak, near-empty
 * overnight. Vehicles freeze when playback is paused.
 *
 * Generic over tram / metro / any line network via {@link TransitConfig}.
 */
export class TransitLayer {
  private data: TransitData | null = null;
  private paths: NetPath[] = [];
  private built = false;
  private visible = true;
  private travel = 0;
  private vehicles: { type: 'FeatureCollection'; features: VehicleFeature[] } = {
    type: 'FeatureCollection',
    features: [],
  };

  private readonly srcLines: string;
  private readonly srcVehicles: string;
  private readonly lyrLineGlow: string;
  private readonly lyrLineCore: string;
  private readonly lyrVehGlow: string;
  private readonly lyrVehCore: string;

  constructor(
    private map: maplibregl.Map,
    private cfg: TransitConfig,
  ) {
    this.srcLines = `${cfg.id}-lines`;
    this.srcVehicles = `${cfg.id}-vehicles`;
    this.lyrLineGlow = `${cfg.id}-line-glow`;
    this.lyrLineCore = `${cfg.id}-line-core`;
    this.lyrVehGlow = `${cfg.id}-veh-glow`;
    this.lyrVehCore = `${cfg.id}-veh-core`;
  }

  async load(url: string): Promise<boolean> {
    try {
      const res = await fetch(url);
      if (!res.ok) return false;
      this.data = (await res.json()) as TransitData;
      this.prepare();
      return true;
    } catch {
      return false;
    }
  }

  private prepare(): void {
    if (!this.data) return;
    for (const f of this.data.paths.features) {
      if (f.geometry.type !== 'LineString') continue;
      const coords = f.geometry.coordinates as Array<[number, number]>;
      const cum = [0];
      for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + segMeters(coords[i - 1], coords[i]));
      const length = cum[cum.length - 1];
      this.paths.push({
        coords,
        cum,
        length,
        capacity: Math.max(1, Math.floor(length / this.cfg.spacingPeak)),
      });
    }
  }

  setup(beforeId?: string): void {
    if (!this.data || this.built) return;
    const { cfg } = this;

    this.map.addSource(this.srcLines, { type: 'geojson', data: this.data.paths });
    this.map.addSource(this.srcVehicles, {
      type: 'geojson',
      data: this.vehicles as unknown as GeoJSON.FeatureCollection,
    });

    this.map.addLayer(
      {
        id: this.lyrLineGlow,
        type: 'line',
        source: this.srcLines,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': cfg.lineGlow, 'line-width': cfg.lineWidthGlow, 'line-blur': 2.5, 'line-opacity': 0.32 },
      },
      beforeId,
    );
    this.map.addLayer(
      {
        id: this.lyrLineCore,
        type: 'line',
        source: this.srcLines,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: { 'line-color': cfg.lineCore, 'line-width': cfg.lineWidthCore, 'line-opacity': 0.62 },
      },
      beforeId,
    );
    this.map.addLayer(
      {
        id: this.lyrVehGlow,
        type: 'circle',
        source: this.srcVehicles,
        paint: {
          'circle-radius': ['*', ['get', 'r'], 2.6],
          'circle-color': cfg.vehicleGlow,
          'circle-blur': 1,
          'circle-opacity': 0.5,
          'circle-pitch-alignment': 'map',
        },
      },
      beforeId,
    );
    this.map.addLayer(
      {
        id: this.lyrVehCore,
        type: 'circle',
        source: this.srcVehicles,
        paint: {
          'circle-radius': ['get', 'r'],
          'circle-color': '#ffffff',
          'circle-blur': 0.3,
          'circle-opacity': 0.95,
          'circle-pitch-alignment': 'map',
        },
      },
      beforeId,
    );

    this.built = true;
  }

  isVisible(): boolean {
    return this.visible;
  }

  setVisible(on: boolean): void {
    this.visible = on;
    const v = on ? 'visible' : 'none';
    for (const id of [this.lyrLineGlow, this.lyrLineCore, this.lyrVehGlow, this.lyrVehCore]) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', v);
    }
  }

  /** Modelled number of active vehicles at a given time (independent of visibility). */
  countAt(timeHours: number): number {
    if (!this.built) return 0;
    const service = this.service(timeHours);
    let n = 0;
    for (const path of this.paths) n += Math.round(path.capacity * service);
    return Math.min(this.cfg.maxVehicles, n);
  }

  private service(hour: number): number {
    const pts = this.cfg.service;
    const x = ((hour % 24) + 24) % 24;
    for (let i = 1; i < pts.length; i++) {
      if (x <= pts[i][0]) {
        const [x0, y0] = pts[i - 1];
        const [x1, y1] = pts[i];
        const f = (x - x0) / (x1 - x0 || 1);
        return y0 + (y1 - y0) * f;
      }
    }
    return pts[pts.length - 1][1];
  }

  /** Locate the [lon,lat] at distance d (metres) along a path. */
  private locate(path: NetPath, d: number): [number, number] {
    const { cum, coords } = path;
    let lo = 0;
    let hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] < d) lo = mid + 1;
      else hi = mid;
    }
    const j = Math.max(1, lo);
    const segLen = cum[j] - cum[j - 1] || 1;
    const f = (d - cum[j - 1]) / segLen;
    const a = coords[j - 1];
    const b = coords[j];
    return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f];
  }

  /**
   * @param advanceHours simulated hours elapsed this frame (0 when paused)
   * @param timeHours    current time of day (0..24)
   * @param beat         shared cardiac pulse (0..1)
   */
  render(advanceHours: number, timeHours: number, beat: number): void {
    if (!this.built || !this.visible) return;
    this.travel += advanceHours * this.cfg.visualMetersPerHour;
    const service = this.service(timeHours);
    const radius = this.cfg.vehicleRadius * (1 + 0.18 * beat);

    const feats = this.vehicles.features;
    let n = 0;
    for (const path of this.paths) {
      const active = Math.round(path.capacity * service);
      if (active <= 0) continue;
      const spacing = path.length / path.capacity;
      for (let i = 0; i < active; i++) {
        if (n >= this.cfg.maxVehicles) break;
        const base = i * spacing;
        const dir = i % 2 === 0 ? 1 : -1;
        const raw = (((base + this.travel * dir) % path.length) + path.length) % path.length;
        const pos = this.locate(path, raw);
        const feat = feats[n];
        if (feat) {
          feat.geometry.coordinates = pos;
          feat.properties.r = radius;
        } else {
          feats.push({ type: 'Feature', geometry: { type: 'Point', coordinates: pos }, properties: { r: radius } });
        }
        n++;
      }
      if (n >= this.cfg.maxVehicles) break;
    }
    feats.length = n;

    const opacity = clamp(0.35 + 0.65 * service);
    if (this.map.getLayer(this.lyrVehCore)) this.map.setPaintProperty(this.lyrVehCore, 'circle-opacity', opacity);

    const src = this.map.getSource(this.srcVehicles) as GeoJSONSource | undefined;
    src?.setData(this.vehicles as unknown as GeoJSON.FeatureCollection);
  }
}
