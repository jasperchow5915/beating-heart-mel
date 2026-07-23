import './style.css';
import 'maplibre-gl/dist/maplibre-gl.css';

import { loadHeartbeat, loadDay, loadDayIndex, type DayData, type HeartbeatData } from './data';
import { HeartMap } from './map';
import { HeartChart } from './heartbeat';
import { FocusView } from './focus';
import { TransitLayer, type TransitConfig } from './transit';
import { FlightLayer } from './flights';
import { Vitals } from './vitals';
import { cardiac, clamp, formatClock, haversine, sampleSeries } from './util';

// The city's pulse rate: quiet nights beat slow, busy peaks beat fast.
const BPM_MIN = 48;
const BPM_MAX = 116;

// Melbourne trams: frequent, dense, running ~5am-midnight.
const TRAM_CONFIG: TransitConfig = {
  id: 'tram',
  lineGlow: '#1f9d57',
  lineCore: '#37d67f',
  vehicleGlow: '#8dffbc',
  lineWidthGlow: 4,
  lineWidthCore: 1.1,
  spacingPeak: 650,
  maxVehicles: 600,
  visualMetersPerHour: 120,
  vehicleRadius: 2.4,
  service: [
    [0, 0.05], [1, 0.03], [4, 0.0], [5, 0.15], [6, 0.5], [7, 1.0], [9, 0.92],
    [12, 0.82], [15, 0.9], [17, 1.0], [19, 0.82], [21, 0.5], [23, 0.22], [24, 0.05],
  ],
};

// Metropolitan trains: sparser and faster, with sharper commuter peaks.
const METRO_CONFIG: TransitConfig = {
  id: 'metro',
  lineGlow: '#1c5fb0',
  lineCore: '#4aa3ff',
  vehicleGlow: '#8ec8ff',
  lineWidthGlow: 5,
  lineWidthCore: 1.4,
  spacingPeak: 1600,
  maxVehicles: 250,
  visualMetersPerHour: 240,
  vehicleRadius: 3,
  service: [
    [0, 0.04], [1, 0.02], [4, 0.0], [5, 0.2], [6, 0.6], [7, 1.0], [8, 1.0], [9, 0.78],
    [11, 0.5], [13, 0.5], [15, 0.72], [17, 1.0], [18, 1.0], [19, 0.68], [21, 0.42], [23, 0.18], [24, 0.04],
  ],
};

function el<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing #${id} in the DOM`);
  return node as T;
}

async function loadOrReportError(loading: HTMLElement): Promise<HeartbeatData | null> {
  try {
    return await loadHeartbeat();
  } catch (err) {
    loading.textContent = err instanceof Error ? err.message : 'Failed to load data.';
    loading.classList.add('error');
    return null;
  }
}

async function main(): Promise<void> {
  const loading = el('loading');
  const data = await loadOrReportError(loading);
  if (!data) return;

  const { sensors, cityTotals, meta } = data;
  // Typical-day values double as stable scaling references, so a busier or
  // quieter selected date reads as bigger/faster or smaller/slower.
  const maxCity = Math.max(...cityTotals);
  const maxSensor = meta.maxSensorHourly;
  const typicalHourly = sensors.map((s) => s.hourly);
  const typicalCityTotals = cityTotals;
  let activeCityTotals: number[] = cityTotals;

  el<HTMLAnchorElement>('srcLink').href = meta.portal;

  const map = new HeartMap('map');
  const chart = new HeartChart(el<HTMLCanvasElement>('chart'));
  chart.setData(activeCityTotals);

  await map.whenReady();
  map.init(sensors);
  loading.classList.add('hidden');

  // --- Focus view (CBD landmark picker) ---
  const FOCUS_LOCATIONS: { id: string; label: string }[] = [
    { id: 'flinders-street', label: 'Flinders Street Station' },
    { id: 'federation-square', label: 'Federation Square' },
    { id: 'southern-cross', label: 'Southern Cross Station' },
    { id: 'flagstaff', label: 'Flagstaff Station' },
  ];

  const focus = new FocusView(map.getMap());
  const focusToggle = el<HTMLButtonElement>('focusToggle');
  const focusPicker = el('focusPicker');
  const focusMenu = el('focusMenu');
  const focusInfo = el('focusInfo');
  const focusExit = el<HTMLButtonElement>('focusExit');
  const focusLabel = el('focusLabel');
  const focusPedEl = el('focusPed');
  const focusStreetsEl = el('focusStreets');

  // Pre-load all focus data files and index nearby sensors per location.
  const focusDataMap = new Map<string, { ready: boolean; nearbyIndices: number[] }>();
  await Promise.all(
    FOCUS_LOCATIONS.map(async ({ id }) => {
      const ok = await focus.loadById(id, `${import.meta.env.BASE_URL}data/focus-${id}.json`);
      let nearbyIdxs: number[] = [];
      if (ok) {
        const info = focus.infoById(id);
        if (info) {
          nearbyIdxs = sensors
            .map((s, i) => ({ i, d: haversine(info.center.lat, info.center.lon, s.lat, s.lon) }))
            .filter((o) => o.d <= info.radiusMeters)
            .map((o) => o.i);
        }
      }
      focusDataMap.set(id, { ready: ok, nearbyIndices: nearbyIdxs });
    }),
  );

  let nearbyIndices: number[] = [];
  const anyReady = [...focusDataMap.values()].some((v) => v.ready);

  const syncFocusUI = () => {
    const on = focus.isActive();
    focusInfo.classList.toggle('hidden', !on);
    focusToggle.classList.toggle('active', on);
    if (!on) {
      focusToggle.textContent = 'Focus on\u2026';
      focusToggle.setAttribute('aria-expanded', 'false');
    }
  };

  const activateLocation = (id: string) => {
    const loc = FOCUS_LOCATIONS.find((l) => l.id === id);
    const entry = focusDataMap.get(id);
    if (!loc || !entry?.ready) return;

    // Build/swap focus layer for this location.
    focus.activateById(id, 'sensor-halo');

    nearbyIndices = entry.nearbyIndices;
    const info = focus.infoById(id);
    focusStreetsEl.textContent = String(info?.streetCount ?? 0);
    focusLabel.textContent = loc.label;
    focusToggle.textContent = loc.label;
    focusToggle.classList.add('active');
    focusToggle.setAttribute('aria-expanded', 'false');
    focusMenu.classList.remove('open');
    focusInfo.classList.remove('hidden');
  };

  if (anyReady) {
    // Dropdown toggle.
    focusToggle.addEventListener('click', (e) => {
      e.stopPropagation();
      if (focus.isActive()) {
        focus.exit();
        nearbyIndices = [];
        syncFocusUI();
      } else {
        const open = focusMenu.classList.toggle('open');
        focusToggle.setAttribute('aria-expanded', String(open));
      }
    });

    // Menu item clicks.
    focusMenu.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-focus]');
      if (btn?.dataset.focus) activateLocation(btn.dataset.focus);
    });

    // Close menu on outside click.
    document.addEventListener('click', (e) => {
      if (focusPicker.contains(e.target as Node)) return;
      if (focusMenu.classList.contains('open')) {
        focusMenu.classList.remove('open');
        focusToggle.setAttribute('aria-expanded', 'false');
      }
    });

    document.addEventListener('keydown', (e) => {
      if (e.key !== 'Escape') return;
      if (focusMenu.classList.contains('open')) {
        focusMenu.classList.remove('open');
        focusToggle.setAttribute('aria-expanded', 'false');
      }
    });

    focusExit.addEventListener('click', () => {
      focus.exit();
      nearbyIndices = [];
      syncFocusUI();
    });
  } else {
    focusToggle.disabled = true;
    focusToggle.title = 'Run "npm run fetch-focus" to enable the focus view';
  }

  // --- Transit networks (trams + metro), synced to the same clock ---
  const transitLayers: TransitLayer[] = [];
  const wireTransit = async (
    cfg: TransitConfig,
    dataFile: string,
    toggleId: string,
    noun: string,
    fetchCmd: string,
  ): Promise<TransitLayer | null> => {
    const layer = new TransitLayer(map.getMap(), cfg);
    const toggle = el<HTMLButtonElement>(toggleId);
    const ready = await layer.load(`${import.meta.env.BASE_URL}data/${dataFile}`);
    if (ready) {
      // Insert beneath the focus spotlight so focus mode dims the networks too.
      const beforeId = map.getMap().getLayer('focus-mask') ? 'focus-mask' : 'sensor-halo';
      layer.setup(beforeId);
      toggle.classList.add('active');
      toggle.addEventListener('click', () => {
        const on = !layer.isVisible();
        layer.setVisible(on);
        toggle.classList.toggle('active', on);
        toggle.textContent = on ? `Hide ${noun}` : `Show ${noun}`;
      });
      transitLayers.push(layer);
      return layer;
    }
    toggle.disabled = true;
    toggle.title = `Run "npm run ${fetchCmd}" to enable the ${noun} layer`;
    return null;
  };

  // Wire metro first so trams render above it.
  const metroLayer = await wireTransit(METRO_CONFIG, 'metro.json', 'metroToggle', 'metro', 'fetch-metro');
  const tramLayer = await wireTransit(TRAM_CONFIG, 'trams.json', 'tramToggle', 'trams', 'fetch-trams');

  // --- Flights (procedural, rendered over the sky, synced to the clock) ---
  const flights = new FlightLayer(map.getMap());
  const flightToggle = el<HTMLButtonElement>('flightToggle');
  const flightsReady = await flights.load(`${import.meta.env.BASE_URL}data/flights.json`);
  if (flightsReady) {
    flights.setup(); // added last, so aircraft fly above every other layer
    // Opt-in: the airports sit 11-50 km out, so enabling flights eases the
    // camera back to a regional view where the sky actually fills in.
    flights.setVisible(false);
    flightToggle.textContent = 'Show flights';
    flightToggle.addEventListener('click', () => {
      const on = !flights.isVisible();
      flights.setVisible(on);
      flightToggle.classList.toggle('active', on);
      flightToggle.textContent = on ? 'Hide flights' : 'Show flights';
      if (on && map.getMap().getZoom() > 12.2) {
        map.getMap().easeTo({ zoom: 11, duration: 1200, essential: true });
      }
    });
  } else {
    flightToggle.disabled = true;
    flightToggle.title = 'Run "npm run fetch-flights" to enable the flight layer';
  }

  // --- City vitals monitor ---
  // Peak values (for the level bars) sampled across a full day.
  const peakOf = (fn: (h: number) => number): number => {
    let m = 0;
    for (let h = 0; h < 24; h += 0.5) m = Math.max(m, fn(h));
    return m || 1;
  };
  const vitalsRow = el('vitals');
  const vitals = new Vitals(vitalsRow, {
    bpm: BPM_MAX,
    pedestrians: maxCity,
    trams: peakOf((h) => tramLayer?.countAt(h) ?? 0),
    trains: peakOf((h) => metroLayer?.countAt(h) ?? 0),
    flights: peakOf((h) => flights.countAt(h)),
  });

  // Mobile: hint that the vitals scroll sideways (trains + aircraft are to the
  // right). The cue fades out once the user reaches the end.
  const vitalsWrap = vitalsRow.parentElement;
  const updateVitalsNav = (): void => {
    if (!vitalsWrap) return;
    const overflow = vitalsRow.scrollWidth - vitalsRow.clientWidth;
    const hasOverflow = overflow > 8;
    vitalsWrap.classList.toggle('can-prev', hasOverflow && vitalsRow.scrollLeft > 8);
    vitalsWrap.classList.toggle('can-next', hasOverflow && vitalsRow.scrollLeft < overflow - 8);
  };
  vitalsRow.addEventListener('scroll', updateVitalsNav, { passive: true });
  window.addEventListener('resize', updateVitalsNav);
  requestAnimationFrame(updateVitalsNav);

  // Prev/next buttons scroll the vitals row by ~one screen-width.
  const scrollVitals = (dir: number): void => {
    vitalsRow.scrollBy({ left: dir * Math.round(vitalsRow.clientWidth * 0.8), behavior: 'smooth' });
  };
  el<HTMLButtonElement>('vitalsMore').addEventListener('click', () => scrollVitals(1));
  el<HTMLButtonElement>('vitalsPrev').addEventListener('click', () => scrollVitals(-1));

  // --- Date selection (lazy-loaded per-date files; typical day is default) ---
  const applyDay = (day: DayData | null): void => {
    if (day) {
      for (const s of sensors) s.hourly = day.hourlyById[String(s.id)] ?? new Array(24).fill(0);
      activeCityTotals = day.cityTotals;
    } else {
      sensors.forEach((s, i) => {
        s.hourly = typicalHourly[i];
      });
      activeCityTotals = typicalCityTotals;
    }
    chart.setData(activeCityTotals);
  };

  const datePicker = el<HTMLInputElement>('datePicker');
  const typicalBtn = el<HTMLButtonElement>('typicalDay');
  const setTypical = (on: boolean, note?: string): void => {
    typicalBtn.classList.toggle('active', on);
    datePicker.title = note ?? (on ? 'Showing the typical day' : `Showing ${datePicker.value}`);
  };

  const dayIndex = await loadDayIndex();
  if (dayIndex?.earliest && dayIndex.latest) {
    datePicker.min = dayIndex.earliest;
    datePicker.max = dayIndex.latest;
    datePicker.addEventListener('change', async () => {
      const date = datePicker.value;
      if (!date) {
        applyDay(null);
        setTypical(true);
        return;
      }
      const day = await loadDay(date);
      if (day) {
        applyDay(day);
        setTypical(false);
      } else {
        datePicker.value = '';
        applyDay(null);
        setTypical(true, 'No data for that date - showing the typical day');
      }
    });
    typicalBtn.addEventListener('click', () => {
      datePicker.value = '';
      applyDay(null);
      setTypical(true);
    });
  } else {
    datePicker.disabled = true;
    typicalBtn.disabled = true;
    typicalBtn.title = 'Run "npm run fetch-data" to enable date selection';
  }

  // --- Playback state ---
  const speedEl = el<HTMLInputElement>('speed');
  let timeHours = 8; // open on the morning build-up
  let playing = true;
  let speed = Number(speedEl.value); // simulated hours per real second
  let phase = 0; // cardiac phase 0..1
  let scrubbing = false;
  let last = performance.now();

  // --- UI refs ---
  const clockEl = el('clock');
  const scrub = el<HTMLInputElement>('scrub');
  const playBtn = el<HTMLButtonElement>('playPause');

  playBtn.addEventListener('click', () => {
    playing = !playing;
    playBtn.textContent = playing ? 'Pause' : 'Play';
    playBtn.classList.toggle('paused', !playing);
  });
  speedEl.addEventListener('input', () => {
    speed = Number(speedEl.value);
  });

  const stopScrub = () => {
    scrubbing = false;
  };
  scrub.addEventListener('pointerdown', () => {
    scrubbing = true;
  });
  scrub.addEventListener('pointerup', stopScrub);
  scrub.addEventListener('pointercancel', stopScrub);
  scrub.addEventListener('input', () => {
    timeHours = Number(scrub.value) / 60;
  });

  window.addEventListener('resize', () => chart.resize());

  function frame(now: number): void {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;

    const advanceHours = playing && !scrubbing ? dt * speed : 0;
    timeHours = (timeHours + advanceHours) % 24;

    const curCity = sampleSeries(activeCityTotals, timeHours);
    const norm = clamp(curCity / maxCity);
    const bpm = BPM_MIN + (BPM_MAX - BPM_MIN) * Math.pow(norm, 0.6);
    phase = (phase + dt * (bpm / 60)) % 1;
    const beat = cardiac(phase);

    const values = sensors.map((s) => sampleSeries(s.hourly, timeHours));
    map.render(values, maxSensor, beat);
    chart.render(timeHours, beat);
    for (const layer of transitLayers) layer.render(advanceHours, timeHours, beat);
    flights.render(advanceHours, timeHours, beat);

    if (focus.isActive() && nearbyIndices.length) {
      let sum = 0;
      for (const i of nearbyIndices) sum += values[i];
      focusPedEl.textContent = Math.round(sum).toLocaleString();
    }

    vitals.update({
      bpm,
      pedestrians: curCity,
      trams: tramLayer?.countAt(timeHours) ?? 0,
      trains: metroLayer?.countAt(timeHours) ?? 0,
      flights: flights.countAt(timeHours),
      beat,
    });

    clockEl.textContent = formatClock(timeHours);
    if (!scrubbing) {
      scrub.value = String(Math.round(timeHours * 60) % 1440);
    }

    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

void main();
