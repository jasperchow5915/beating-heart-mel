// The "city vitals" monitor: a patient-monitor-style readout of the city's
// live vital signs (pulse, pedestrians, trams, trains, aircraft), all moving
// on the same clock as the animation.

export interface VitalsPeaks {
  bpm: number;
  pedestrians: number;
  trams: number;
  trains: number;
  flights: number;
}

export interface VitalsState extends VitalsPeaks {
  beat: number;
}

type VitalKey = keyof VitalsPeaks;

interface RowDef {
  key: VitalKey;
  label: string;
  unit: string;
  cls: string;
  heart?: boolean;
}

const ROWS: RowDef[] = [
  { key: 'bpm', label: 'heart rate', unit: 'bpm', cls: 'bpm', heart: true },
  { key: 'pedestrians', label: 'pedestrians', unit: '/hr', cls: 'ped' },
  { key: 'trams', label: 'trams', unit: 'running', cls: 'tram' },
  { key: 'trains', label: 'trains', unit: 'running', cls: 'metro' },
  { key: 'flights', label: 'aircraft', unit: 'aloft', cls: 'flight' },
];

export class Vitals {
  private els: Record<string, { value: HTMLElement; bar: HTMLElement; dot: HTMLElement }> = {};

  constructor(container: HTMLElement, private peaks: VitalsPeaks) {
    container.innerHTML = '';
    for (const row of ROWS) {
      const chip = document.createElement('div');
      chip.className = `vital vital--${row.cls}`;

      const dot = document.createElement('span');
      dot.className = 'vital-dot';
      if (row.heart) dot.textContent = '\u2665'; // heart glyph, pulses with the beat

      const body = document.createElement('div');
      body.className = 'vital-body';

      const value = document.createElement('div');
      value.className = 'vital-value';
      value.dataset.unit = row.unit;

      const label = document.createElement('div');
      label.className = 'vital-label';
      label.textContent = row.label;

      body.append(value, label);

      const bar = document.createElement('div');
      bar.className = 'vital-bar';
      const fill = document.createElement('i');
      bar.append(fill);

      chip.append(dot, body, bar);
      container.append(chip);

      this.els[row.key] = { value, bar: fill, dot };
    }
  }

  update(state: VitalsState): void {
    this.setRow('bpm', state.bpm);
    this.setRow('pedestrians', state.pedestrians);
    this.setRow('trams', state.trams);
    this.setRow('trains', state.trains);
    this.setRow('flights', state.flights);

    // The heart glyph swells on each beat.
    const heart = this.els.bpm.dot;
    heart.style.transform = `scale(${(1 + 0.45 * state.beat).toFixed(3)})`;
    heart.style.opacity = (0.7 + 0.3 * state.beat).toFixed(3);
  }

  private setRow(key: VitalKey, value: number): void {
    const e = this.els[key];
    const rounded = Math.round(value);
    const unit = e.value.dataset.unit ?? '';
    const display = rounded >= 1000 ? rounded.toLocaleString() : String(rounded);
    e.value.innerHTML = `<b>${display}</b><small>${unit}</small>`;
    const peak = this.peaks[key] || 1;
    e.bar.style.width = `${Math.max(0, Math.min(1, value / peak)) * 100}%`;
  }
}
