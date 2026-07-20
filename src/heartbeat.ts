import { clamp, colorRamp, rgbCss, sampleSeries } from './util';

/**
 * Draws the citywide pedestrian activity across a day as a glowing curve -
 * the "beat" trace - with a moving playhead and a pulsing marker locked to
 * the current time of day.
 */
export class HeartChart {
  private ctx: CanvasRenderingContext2D;
  private totals: number[] = [];
  private max = 1;
  private w = 0;
  private h = 0;

  constructor(private canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas context unavailable');
    this.ctx = ctx;
    this.resize();
  }

  setData(totals: number[]): void {
    this.totals = totals;
    this.max = Math.max(1, ...totals);
  }

  resize(): void {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = this.canvas.getBoundingClientRect();
    this.w = rect.width;
    this.h = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  private xAt(hour: number): number {
    const pad = 10;
    return pad + (hour / 24) * (this.w - 2 * pad);
  }

  private yAt(v: number): number {
    const padTop = 12;
    const padBottom = 16;
    const t = clamp(v / this.max);
    return this.h - padBottom - t * (this.h - padTop - padBottom);
  }

  render(timeHours: number, beat: number): void {
    const ctx = this.ctx;
    const { w, h } = this;
    ctx.clearRect(0, 0, w, h);
    if (this.totals.length === 0) return;

    // Hour gridlines + labels.
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.06)';
    ctx.fillStyle = 'rgba(255, 255, 255, 0.4)';
    ctx.lineWidth = 1;
    ctx.font = '10px system-ui, -apple-system, sans-serif';
    ctx.textAlign = 'center';
    for (const hh of [0, 6, 12, 18, 24]) {
      const px = this.xAt(hh);
      ctx.beginPath();
      ctx.moveTo(px, 8);
      ctx.lineTo(px, h - 16);
      ctx.stroke();
      ctx.fillText(hh === 24 ? '24:00' : `${String(hh).padStart(2, '0')}:00`, px, h - 4);
    }

    // Build the closed-loop trace (hour 0..24, where 24 == hour 0).
    const pts: Array<[number, number]> = [];
    for (let hh = 0; hh <= 24; hh++) {
      pts.push([this.xAt(hh), this.yAt(this.totals[hh % 24])]);
    }

    // Gradient area fill under the curve.
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(255, 74, 92, 0.45)');
    grad.addColorStop(1, 'rgba(255, 74, 92, 0.02)');
    ctx.beginPath();
    ctx.moveTo(pts[0][0], h - 16);
    for (const [px, py] of pts) ctx.lineTo(px, py);
    ctx.lineTo(pts[pts.length - 1][0], h - 16);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();

    // Glowing curve.
    ctx.beginPath();
    pts.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.strokeStyle = 'rgba(255, 125, 145, 0.95)';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(255, 60, 90, 0.9)';
    ctx.shadowBlur = 8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Playhead.
    const px = this.xAt(timeHours);
    const curV = sampleSeries(this.totals, timeHours);
    const py = this.yAt(curV);
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.45)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, 8);
    ctx.lineTo(px, h - 16);
    ctx.stroke();

    // Pulsing marker.
    const r = 3.5 + beat * 4.5;
    const col = colorRamp(clamp(curV / this.max));
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fillStyle = rgbCss(col);
    ctx.shadowColor = rgbCss(col);
    ctx.shadowBlur = 12 + beat * 16;
    ctx.fill();
    ctx.shadowBlur = 0;
  }
}
