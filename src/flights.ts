import maplibregl, { type GeoJSONSource } from 'maplibre-gl';

interface Airport {
  name: string;
  iata: string | null;
  icao: string | null;
  lat: number;
  lon: number;
  bearing: number;
}

interface Corridor {
  coords: [[number, number], [number, number]]; // [airport, far]
}

interface FlightData {
  meta: { source: string; licence: string; airportCount: number };
  airports: Airport[];
  corridors: Corridor[];
}

interface Leg {
  a: [number, number];
  f: [number, number];
  length: number;
  bearing: number; // degrees, airport -> far
  phase: number; // per-corridor offset to desync vehicles
}

interface VehicleFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: { bearing: number; r: number };
}

const ICON_ID = 'bhm-aircraft';
const GLOW_COLOR = '#dbeafe';
const SPACING = 8000; // metres between aircraft along a corridor at full service
const MAX_AIRCRAFT = 130;
const VISUAL_M_PER_HOUR = 420; // aircraft glide faster than ground transit
const LABEL_FONT = ['Montserrat Regular', 'Open Sans Regular', 'Noto Sans Regular'];

// Air-traffic movements across the day (0..1). Melbourne Airport runs 24/7,
// so it never fully drops to zero, but overnight is much quieter.
const SERVICE: Array<[number, number]> = [
  [0, 0.06], [1, 0.03], [2, 0.02], [5, 0.15], [6, 0.5], [7, 0.85], [8, 1.0], [9, 0.95],
  [11, 0.8], [13, 0.8], [15, 0.85], [17, 1.0], [18, 0.95], [20, 0.7], [22, 0.4], [23, 0.2], [24, 0.06],
];

function segMeters(a: [number, number], b: [number, number]): number {
  const latMid = (((a[1] + b[1]) / 2) * Math.PI) / 180;
  const dx = (b[0] - a[0]) * Math.cos(latMid) * 111320;
  const dy = (b[1] - a[1]) * 110540;
  return Math.hypot(dx, dy);
}

function bearingDeg(a: [number, number], b: [number, number]): number {
  const latMid = (((a[1] + b[1]) / 2) * Math.PI) / 180;
  const dE = (b[0] - a[0]) * Math.cos(latMid);
  const dN = b[1] - a[1];
  return (((Math.atan2(dE, dN) * 180) / Math.PI) + 360) % 360;
}

/**
 * A procedural flight layer: real airports (from OpenStreetMap) with aircraft
 * animated along arrival/departure corridors. Traffic volume follows a
 * movements-per-hour curve on the same clock as the pedestrian pulse, so the
 * sky fills at peak and empties overnight. Aircraft freeze when paused.
 */
export class FlightLayer {
  private data: FlightData | null = null;
  private legs: Leg[] = [];
  private built = false;
  private visible = true;
  private travel = 0;
  private vehicles: { type: 'FeatureCollection'; features: VehicleFeature[] } = {
    type: 'FeatureCollection',
    features: [],
  };

  constructor(private map: maplibregl.Map) {}

  async load(url: string): Promise<boolean> {
    try {
      const res = await fetch(url);
      if (!res.ok) return false;
      this.data = (await res.json()) as FlightData;
      this.prepare();
      return true;
    } catch {
      return false;
    }
  }

  private prepare(): void {
    if (!this.data) return;
    this.legs = this.data.corridors.map((c, i) => {
      const a = c.coords[0];
      const f = c.coords[1];
      return {
        a,
        f,
        length: segMeters(a, f),
        bearing: bearingDeg(a, f),
        phase: (i * 2777) % SPACING,
      };
    });
  }

  private ensureIcon(): void {
    if (this.map.hasImage(ICON_ID)) return;
    const size = 28;
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    // Top-view aircraft silhouette pointing up (north = bearing 0).
    const pts: Array<[number, number]> = [
      [14, 3], [16, 12], [25, 18], [25, 20], [16, 17], [16, 22],
      [19, 25], [19, 26.5], [14, 24.5], [9, 26.5], [9, 25], [12, 22],
      [12, 17], [3, 20], [3, 18], [12, 12],
    ];
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.fill();
    const img = ctx.getImageData(0, 0, size, size);
    this.map.addImage(ICON_ID, img, { pixelRatio: 2 });
  }

  setup(): void {
    if (!this.data || this.built) return;
    this.ensureIcon();

    // Airports (static).
    const airportFc = {
      type: 'FeatureCollection',
      features: this.data.airports.map((a) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [a.lon, a.lat] },
        properties: { label: a.iata ?? a.name },
      })),
    };
    this.map.addSource('airport-points', { type: 'geojson', data: airportFc as unknown as GeoJSON.FeatureCollection });
    this.map.addSource('flight-vehicles', {
      type: 'geojson',
      data: this.vehicles as unknown as GeoJSON.FeatureCollection,
    });

    this.map.addLayer({
      id: 'airport-ring',
      type: 'circle',
      source: 'airport-points',
      paint: {
        'circle-radius': 5,
        'circle-color': 'rgba(200, 220, 255, 0.15)',
        'circle-stroke-color': '#cfe0ff',
        'circle-stroke-width': 1.5,
        'circle-pitch-alignment': 'map',
      },
    });
    this.map.addLayer({
      id: 'airport-label',
      type: 'symbol',
      source: 'airport-points',
      layout: {
        'text-field': ['get', 'label'],
        'text-font': LABEL_FONT,
        'text-size': 11,
        'text-offset': [0, 1.1],
        'text-anchor': 'top',
        'text-allow-overlap': false,
      },
      paint: {
        'text-color': '#dbeafe',
        'text-halo-color': '#05040c',
        'text-halo-width': 1.4,
      },
    });

    this.map.addLayer({
      id: 'flight-glow',
      type: 'circle',
      source: 'flight-vehicles',
      paint: {
        'circle-radius': ['get', 'r'],
        'circle-color': GLOW_COLOR,
        'circle-blur': 1,
        'circle-opacity': 0.4,
        'circle-pitch-alignment': 'map',
      },
    });
    this.map.addLayer({
      id: 'flights',
      type: 'symbol',
      source: 'flight-vehicles',
      layout: {
        'icon-image': ICON_ID,
        'icon-size': 0.6,
        'icon-rotate': ['get', 'bearing'],
        'icon-rotation-alignment': 'map',
        'icon-allow-overlap': true,
        'icon-ignore-placement': true,
      },
      paint: { 'icon-opacity': 0.95 },
    });

    this.built = true;
  }

  isVisible(): boolean {
    return this.visible;
  }

  setVisible(on: boolean): void {
    this.visible = on;
    const v = on ? 'visible' : 'none';
    for (const id of ['airport-ring', 'airport-label', 'flight-glow', 'flights']) {
      if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', v);
    }
  }

  /** Modelled number of aircraft aloft at a given time (independent of visibility). */
  countAt(timeHours: number): number {
    if (!this.built) return 0;
    const service = this.service(timeHours);
    let n = 0;
    for (const leg of this.legs) n += Math.round(Math.max(1, Math.floor(leg.length / SPACING)) * service);
    return Math.min(MAX_AIRCRAFT, n);
  }

  private service(hour: number): number {
    const x = ((hour % 24) + 24) % 24;
    for (let i = 1; i < SERVICE.length; i++) {
      if (x <= SERVICE[i][0]) {
        const [x0, y0] = SERVICE[i - 1];
        const [x1, y1] = SERVICE[i];
        const f = (x - x0) / (x1 - x0 || 1);
        return y0 + (y1 - y0) * f;
      }
    }
    return SERVICE[SERVICE.length - 1][1];
  }

  render(advanceHours: number, timeHours: number, beat: number): void {
    if (!this.built || !this.visible) return;
    this.travel += advanceHours * VISUAL_M_PER_HOUR;
    const service = this.service(timeHours);
    const r = 4 + beat * 3;

    const feats = this.vehicles.features;
    let n = 0;
    for (const leg of this.legs) {
      const capacity = Math.max(1, Math.floor(leg.length / SPACING));
      const active = Math.round(capacity * service);
      const spacing = leg.length / capacity;
      for (let i = 0; i < active; i++) {
        if (n >= MAX_AIRCRAFT) break;
        const base = i * spacing + leg.phase;
        const arriving = i % 2 === 1;
        const d = (((base + this.travel) % leg.length) + leg.length) % leg.length;
        const frac = arriving ? 1 - d / leg.length : d / leg.length;
        const lon = leg.a[0] + (leg.f[0] - leg.a[0]) * frac;
        const lat = leg.a[1] + (leg.f[1] - leg.a[1]) * frac;
        const bearing = arriving ? (leg.bearing + 180) % 360 : leg.bearing;
        const feat = feats[n];
        if (feat) {
          feat.geometry.coordinates = [lon, lat];
          feat.properties.bearing = bearing;
          feat.properties.r = r;
        } else {
          feats.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: { bearing, r },
          });
        }
        n++;
      }
      if (n >= MAX_AIRCRAFT) break;
    }
    feats.length = n;

    const src = this.map.getSource('flight-vehicles') as GeoJSONSource | undefined;
    src?.setData(this.vehicles as unknown as GeoJSON.FeatureCollection);
  }
}
