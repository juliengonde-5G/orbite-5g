/**
 * Courbe de progression : moyenne cumulée de l'élève, moyenne cumulée de la
 * classe (pointillés) et tendance glissante sur 30 jours (trait léger).
 */
import { h, s } from './dom.ts';
import { average, shortDay } from './format.ts';
import { gradeTimeline } from '../shared/metrics.ts';
import type { Note } from '../shared/types.ts';

export function progressChart(notes: readonly Note[]): HTMLElement {
  const points = gradeTimeline(notes, 30);
  if (points.length < 2) return h('p.empty-line', 'La courbe apparaîtra après quelques notes de plus.');

  const W = 340;
  const H = 170;
  const pad = { l: 28, r: 14, t: 14, b: 24 };
  const values = points.flatMap((p) => [p.average, p.classAverage, p.trend]).filter((v): v is number => v !== null);
  const lo = Math.max(0, Math.floor(Math.min(...values) - 1));
  const top = Math.min(20, Math.ceil(Math.max(...values) + 1));
  const hi = top > lo + 4 ? top : Math.min(20, lo + 5);
  const t0 = points[0]?.time ?? 0;
  const t1 = points.at(-1)?.time ?? t0 + 1;
  const x = (t: number) => pad.l + ((t - t0) / Math.max(1, t1 - t0)) * (W - pad.l - pad.r);
  const y = (v: number) => pad.t + (1 - (v - lo) / Math.max(1, hi - lo)) * (H - pad.t - pad.b);
  const line = (key: 'average' | 'classAverage' | 'trend') => {
    let d = '';
    let pen = false;
    for (const p of points) {
      const v = p[key];
      if (v === null) {
        pen = false;
        continue;
      }
      d += `${pen ? 'L' : 'M'}${x(p.time).toFixed(1)} ${y(v).toFixed(1)}`;
      pen = true;
    }
    return d;
  };
  const last = points.at(-1);
  const grid = [10, 14].filter((v) => v > lo && v < hi);
  const months: { t: number; label: string }[] = [];
  const seenMonths = new Set<string>();
  for (const p of points) {
    const key = p.date.slice(0, 7);
    if (!seenMonths.has(key)) {
      seenMonths.add(key);
      months.push({
        t: p.time,
        label: new Intl.DateTimeFormat('fr-FR', { month: 'short', timeZone: 'UTC' }).format(new Date(p.time)),
      });
    }
  }

  return h(
    'figure.chart',
    {
      role: 'img',
      'aria-label': `Moyenne cumulée : ${average(last?.average)} sur 20 au ${last ? shortDay(last.date) : ''}.`,
    },
    s(
      'svg',
      { viewBox: `0 0 ${W} ${H}`, class: 'chart-svg' },
      grid.map((v) =>
        s('g', {}, [
          s('line', { x1: pad.l, x2: W - pad.r, y1: y(v), y2: y(v), class: 'chart-grid' }),
          s('text', { x: pad.l - 6, y: y(v) + 4, class: 'chart-label', 'text-anchor': 'end' }, String(v)),
        ]),
      ),
      months.map((m) => s('text', { x: x(m.t), y: H - 6, class: 'chart-label' }, m.label)),
      s('path', { d: line('classAverage'), class: 'chart-class' }),
      s('path', { d: line('trend'), class: 'chart-trend' }),
      s('path', { d: line('average'), class: 'chart-avg' }),
      last?.average != null && s('circle', { cx: x(last.time), cy: y(last.average), r: 4.5, class: 'chart-dot' }),
    ),
    h(
      'figcaption.chart-legend',
      h('span.legend-avg', 'Moyenne'),
      h('span.legend-class', 'Classe'),
      h('span.legend-trend', 'Tendance 30 j'),
    ),
  );
}
