import maplibregl, { type LngLat } from 'maplibre-gl';

interface FocusData {
  meta: {
    address: string;
    radiusMeters: number;
    streetCount: number;
    namedStreets: string[];
    source: string;
    licence: string;
  };
  center: { lat: number; lon: number; label: string };
  streets: GeoJSON.FeatureCollection;
}

export interface FocusInfo {
  center: { lat: number; lon: number; label: string };
  radiusMeters: number;
  streetCount: number;
}

const ACCENT = '#ff3d6b';
const LABEL_FONT = ['Montserrat Regular', 'Open Sans Regular', 'Noto Sans Regular'];

/**
 * A "focus view" that spotlights the streets immediately around a single
 * address: it dims the rest of the city, highlights and labels the local
 * street network (from OpenStreetMap), drops a marker on the building, and
 * flies the camera in. Coexists with the running heartbeat animation.
 */
export class FocusView {
  private data: FocusData | null = null;
  private active = false;
  private built = false;
  private marker: maplibregl.Marker | null = null;
  private saved: { center: LngLat; zoom: number; pitch: number; bearing: number } | null = null;

  constructor(private map: maplibregl.Map) {}

  async load(url: string): Promise<boolean> {
    try {
      const res = await fetch(url);
      if (!res.ok) return false;
      this.data = (await res.json()) as FocusData;
      return true;
    } catch {
      return false;
    }
  }

  get info(): FocusInfo | null {
    if (!this.data) return null;
    return {
      center: this.data.center,
      radiusMeters: this.data.meta.radiusMeters,
      streetCount: this.data.meta.streetCount,
    };
  }

  isActive(): boolean {
    return this.active;
  }

  /** Add all sources/layers up front (transparent until activated). */
  setup(beforeId?: string): void {
    if (!this.data || this.built) return;
    const { center } = this.data;
    const holeR = this.data.meta.radiusMeters * 0.62;

    this.map.addSource('focus-mask', {
      type: 'geojson',
      data: this.buildMask(center.lat, center.lon, holeR) as unknown as GeoJSON.Feature,
    });
    this.map.addSource('focus-ring', {
      type: 'geojson',
      data: this.buildRing(center.lat, center.lon, holeR) as unknown as GeoJSON.Feature,
    });
    this.map.addSource('focus-streets', {
      type: 'geojson',
      data: this.data.streets,
    });

    this.map.addLayer(
      {
        id: 'focus-mask',
        type: 'fill',
        source: 'focus-mask',
        paint: {
          'fill-color': '#03020a',
          'fill-opacity': 0,
        },
      },
      beforeId,
    );

    this.map.addLayer(
      {
        id: 'focus-street-glow',
        type: 'line',
        source: 'focus-streets',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ACCENT,
          'line-width': ['case', ['get', 'major'], 9, 5],
          'line-blur': 3,
          'line-opacity': 0,
        },
      },
      beforeId,
    );

    this.map.addLayer(
      {
        id: 'focus-street-core',
        type: 'line',
        source: 'focus-streets',
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['case', ['get', 'major'], '#ffd27f', '#ff9db0'],
          'line-width': ['case', ['get', 'major'], 2.4, 1.2],
          'line-opacity': 0,
        },
      },
      beforeId,
    );

    this.map.addLayer(
      {
        id: 'focus-ring',
        type: 'line',
        source: 'focus-ring',
        paint: {
          'line-color': ACCENT,
          'line-width': 2,
          'line-blur': 1.5,
          'line-opacity': 0,
        },
      },
      beforeId,
    );

    // Street-name labels sit on top of everything.
    this.map.addLayer({
      id: 'focus-street-labels',
      type: 'symbol',
      source: 'focus-streets',
      filter: ['has', 'name'],
      layout: {
        'symbol-placement': 'line',
        'text-field': ['get', 'name'],
        'text-font': LABEL_FONT,
        'text-size': 11,
        'text-letter-spacing': 0.02,
        'text-max-angle': 40,
      },
      paint: {
        'text-color': '#ffffff',
        'text-halo-color': '#05040c',
        'text-halo-width': 1.4,
        'text-opacity': 0,
      },
    });

    this.built = true;
  }

  toggle(): void {
    if (this.active) this.exit();
    else this.enter();
  }

  enter(): void {
    if (!this.data || !this.built || this.active) return;
    this.active = true;
    this.saved = {
      center: this.map.getCenter(),
      zoom: this.map.getZoom(),
      pitch: this.map.getPitch(),
      bearing: this.map.getBearing(),
    };
    this.setOpacities(true);
    this.addMarker();
    const { center } = this.data;
    this.map.flyTo({
      center: [center.lon, center.lat],
      zoom: 16,
      pitch: 55,
      bearing: this.map.getBearing(),
      duration: 1600,
      essential: true,
    });
  }

  exit(): void {
    if (!this.active) return;
    this.active = false;
    this.setOpacities(false);
    this.removeMarker();
    if (this.saved) {
      this.map.flyTo({
        center: this.saved.center,
        zoom: this.saved.zoom,
        pitch: this.saved.pitch,
        bearing: this.saved.bearing,
        duration: 1400,
        essential: true,
      });
    }
  }

  private setOpacities(on: boolean): void {
    const set = (id: string, prop: string, val: number) => {
      if (this.map.getLayer(id)) this.map.setPaintProperty(id, prop, on ? val : 0);
    };
    set('focus-mask', 'fill-opacity', 0.72);
    set('focus-street-glow', 'line-opacity', 0.55);
    set('focus-street-core', 'line-opacity', 0.95);
    set('focus-ring', 'line-opacity', 0.85);
    set('focus-street-labels', 'text-opacity', 1);
  }

  private addMarker(): void {
    if (this.marker || !this.data) return;
    const el = document.createElement('div');
    el.className = 'focus-marker';
    const dot = document.createElement('span');
    dot.className = 'focus-marker-dot';
    const label = document.createElement('span');
    label.className = 'focus-marker-label';
    label.textContent = this.data.center.label;
    el.append(dot, label);
    this.marker = new maplibregl.Marker({ element: el, anchor: 'bottom' })
      .setLngLat([this.data.center.lon, this.data.center.lat])
      .addTo(this.map);
  }

  private removeMarker(): void {
    this.marker?.remove();
    this.marker = null;
  }

  private circleRing(lat: number, lon: number, radiusM: number, steps = 96): Array<[number, number]> {
    const dLat = radiusM / 111320;
    const dLon = radiusM / (111320 * Math.cos((lat * Math.PI) / 180));
    const ring: Array<[number, number]> = [];
    for (let i = 0; i <= steps; i++) {
      const a = (i / steps) * 2 * Math.PI;
      ring.push([lon + dLon * Math.cos(a), lat + dLat * Math.sin(a)]);
    }
    return ring;
  }

  private buildMask(lat: number, lon: number, radiusM: number) {
    const big = 0.5; // degrees - large enough to cover the viewport at any zoom
    const outer: Array<[number, number]> = [
      [lon - big, lat - big],
      [lon + big, lat - big],
      [lon + big, lat + big],
      [lon - big, lat + big],
      [lon - big, lat - big],
    ];
    const hole = this.circleRing(lat, lon, radiusM).reverse();
    return {
      type: 'Feature',
      properties: {},
      geometry: { type: 'Polygon', coordinates: [outer, hole] },
    };
  }

  private buildRing(lat: number, lon: number, radiusM: number) {
    return {
      type: 'Feature',
      properties: {},
      geometry: { type: 'LineString', coordinates: this.circleRing(lat, lon, radiusM) },
    };
  }
}
