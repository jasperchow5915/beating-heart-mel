import maplibregl, { type LngLatLike, type GeoJSONSource } from 'maplibre-gl';
import type { Sensor } from './data';
import { clamp, colorRamp, mixWhite, rgbCss } from './util';

// Free CARTO dark basemap - no API key required.
const STYLE = 'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const MELBOURNE_CBD: LngLatLike = [144.9631, -37.8136];

interface PointFeature {
  type: 'Feature';
  geometry: { type: 'Point'; coordinates: [number, number] };
  properties: {
    name: string;
    color: string;
    coreR: number;
    haloR: number;
    coreOpacity: number;
    haloOpacity: number;
    count: number;
  };
}

interface PointCollection {
  type: 'FeatureCollection';
  features: PointFeature[];
}

/**
 * Renders the pedestrian sensors as glowing, pulsing circles on a dark
 * map of Melbourne. Each frame the caller passes current per-sensor values
 * plus a shared "beat" scalar (0..1) that throbs the circles like a pulse.
 */
export class HeartMap {
  private map: maplibregl.Map;
  private fc: PointCollection = { type: 'FeatureCollection', features: [] };
  private ready = false;

  constructor(container: string) {
    this.map = new maplibregl.Map({
      container,
      style: STYLE,
      center: MELBOURNE_CBD,
      zoom: 13.2,
      pitch: 45,
      bearing: -17.6,
      attributionControl: false,
      antialias: true,
    });
    this.map.addControl(new maplibregl.AttributionControl({ compact: true }), 'top-right');
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: true }), 'top-right');
  }

  /** The underlying MapLibre map instance (for add-on layers like the focus view). */
  getMap(): maplibregl.Map {
    return this.map;
  }

  /** Resolves once the base style has loaded and layers can be added. */
  whenReady(): Promise<void> {
    return new Promise((resolve) => {
      if (this.map.isStyleLoaded()) {
        resolve();
      } else {
        this.map.once('load', () => resolve());
      }
    });
  }

  init(sensors: Sensor[]): void {
    this.fc = {
      type: 'FeatureCollection',
      features: sensors.map((s) => ({
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [s.lon, s.lat] },
        properties: {
          name: s.name,
          color: 'rgb(26, 18, 58)',
          coreR: 2,
          haloR: 6,
          coreOpacity: 0.7,
          haloOpacity: 0.2,
          count: 0,
        },
      })),
    };

    this.map.addSource('sensors', { type: 'geojson', data: this.fc as unknown as GeoJSON.FeatureCollection });

    this.map.addLayer({
      id: 'sensor-halo',
      type: 'circle',
      source: 'sensors',
      paint: {
        'circle-radius': ['get', 'haloR'],
        'circle-color': ['get', 'color'],
        'circle-blur': 1,
        'circle-opacity': ['get', 'haloOpacity'],
        'circle-pitch-alignment': 'map',
      },
    });

    this.map.addLayer({
      id: 'sensor-core',
      type: 'circle',
      source: 'sensors',
      paint: {
        'circle-radius': ['get', 'coreR'],
        'circle-color': ['get', 'color'],
        'circle-blur': 0.4,
        'circle-opacity': ['get', 'coreOpacity'],
        'circle-pitch-alignment': 'map',
      },
    });

    this.attachPopup();
    this.ready = true;
  }

  private attachPopup(): void {
    const popup = new maplibregl.Popup({
      closeButton: false,
      closeOnClick: false,
      className: 'sensor-popup',
    });
    this.map.on('mousemove', 'sensor-core', (e) => {
      const f = e.features?.[0];
      if (!f) return;
      this.map.getCanvas().style.cursor = 'pointer';
      const p = f.properties as PointFeature['properties'];
      const coords = (f.geometry as GeoJSON.Point).coordinates as [number, number];
      popup
        .setLngLat(coords)
        .setHTML(`<strong>${p.name}</strong><span>${Math.round(p.count).toLocaleString()} ped/hr</span>`)
        .addTo(this.map);
    });
    this.map.on('mouseleave', 'sensor-core', () => {
      this.map.getCanvas().style.cursor = '';
      popup.remove();
    });
  }

  /**
   * @param values  current pedestrian count per sensor (aligned to init order)
   * @param maxVal  scaling reference (max sensor hourly average)
   * @param beat    shared cardiac pulse, 0..1
   */
  render(values: number[], maxVal: number, beat: number): void {
    if (!this.ready) return;
    const feats = this.fc.features;
    for (let i = 0; i < feats.length; i++) {
      const v = values[i] ?? 0;
      const intensity = clamp(v / maxVal);
      const vis = Math.pow(intensity, 0.72); // perceptual boost for low counts
      const base = 2 + Math.sqrt(intensity) * 20;
      const throb = 1 + 0.18 * beat * (0.35 + 0.65 * intensity);
      const coreR = base * throb;

      const col = mixWhite(colorRamp(vis), 0.12 * beat * intensity + 0.05 * intensity);
      const p = feats[i].properties;
      p.color = rgbCss(col);
      p.coreR = coreR;
      p.haloR = coreR * 2.6;
      p.coreOpacity = 0.35 + 0.55 * vis;
      p.haloOpacity = (0.1 + 0.28 * vis) * (0.7 + 0.3 * beat);
      p.count = v;
    }
    const src = this.map.getSource('sensors') as GeoJSONSource | undefined;
    src?.setData(this.fc as unknown as GeoJSON.FeatureCollection);
  }
}
