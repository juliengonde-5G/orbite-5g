/**
 * L'orbite : signature visuelle d'Orbite.
 *
 * La moyenne s'affiche au centre d'un anneau gradué de 0 à 20 (270°, ouvert en
 * bas). L'arc coloré va jusqu'à la moyenne ; chaque note des 30 derniers jours
 * gravite autour comme un satellite, placé selon sa valeur sur 20 et coloré selon
 * le barème (vert ≥ 14, orange ≥ 10, rouge en dessous). Un repère discret marque
 * la moyenne de la classe. On lit d'un coup d'œil le niveau et la dispersion.
 */
import { h, icon, s } from './dom.ts';
import { average, signed } from './format.ts';
import { gradeBand, metrics, noteKey, score, valid } from '../shared/metrics.ts';
import type { Child } from '../shared/types.ts';

const START = 135;
const SWEEP = 270;

const angle = (value: number) => START + (Math.max(0, Math.min(20, value)) / 20) * SWEEP;
const point = (cx: number, cy: number, r: number, deg: number) => {
  const rad = (deg * Math.PI) / 180;
  return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)] as const;
};

function arc(cx: number, cy: number, r: number, from: number, to: number): string {
  const [x1, y1] = point(cx, cy, r, from);
  const [x2, y2] = point(cx, cy, r, to);
  const large = to - from > 180 ? 1 : 0;
  return `M${x1.toFixed(2)} ${y1.toFixed(2)}A${r} ${r} 0 ${large} 1 ${x2.toFixed(2)} ${y2.toFixed(2)}`;
}

export interface OrbitOptions {
  size?: 'hero' | 'mini';
  fresh?: ReadonlySet<string>;
  /** Moyenne officielle de période à afficher à la place de la moyenne calculée. */
  official?: number | null;
}

export function orbit(child: Child, options: OrbitOptions = {}): HTMLElement {
  const mini = options.size === 'mini';
  const box = 260;
  const c = box / 2;
  const R = 80;
  const m = metrics(child.notes);
  const avg = options.official ?? m.average;
  const now = Date.now();
  const recent = child.notes
    .filter(valid)
    .filter((n) => now - Date.parse(n.date ?? '') <= 30 * 86400000)
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
    .slice(0, mini ? 10 : 18);

  const svg = s(
    'svg',
    { viewBox: `0 0 ${box} ${box}`, class: 'orbit-svg', 'aria-hidden': 'true' },
    s('path', { d: arc(c, c, R, START, START + SWEEP), class: 'orbit-track' }),
    // Repères des seuils 10 et 14 sur 20.
    [10, 14].map((v) => {
      const [x1, y1] = point(c, c, R - 6, angle(v));
      const [x2, y2] = point(c, c, R + 6, angle(v));
      return s('line', { x1, y1, x2, y2, class: 'orbit-tick' });
    }),
    avg !== null && s('path', { d: arc(c, c, R, START, angle(avg) + 0.01), class: 'orbit-progress' }),
    m.classAverage !== null &&
      (() => {
        const deg = angle(m.classAverage);
        const [x, y] = point(c, c, R - 13, deg);
        return s('circle', { cx: x, cy: y, r: 3.2, class: 'orbit-class' });
      })(),
    (() => {
      // Notes de même valeur (à 0,5 près) empilées vers l'extérieur : un histogramme circulaire.
      const stacks = new Map<number, number>();
      return recent.map((n, i) => {
        const bucket = Math.round(score(n) * 2) / 2;
        const level = stacks.get(bucket) ?? 0;
        stacks.set(bucket, level + 1);
        return { n, i, bucket, level };
      });
    })()
      .filter((x) => x.level < 4)
      .map(({ n, i, bucket, level }) => {
        const r = R + 15 + level * 10;
        const [x, y] = point(c, c, r, angle(bucket));
        const fresh = options.fresh?.has(noteKey(child.id, n));
        return s('circle', {
          cx: x.toFixed(2),
          cy: y.toFixed(2),
          r: mini ? 6 : 5.5,
          class: `orbit-sat band-${gradeBand(n)}${fresh ? ' is-fresh' : ''}`,
          style: { '--i': String(i) },
        });
      }),
  );

  const trend = m.trend;
  const direction = trend === null ? 'none' : Math.abs(trend) < 0.05 ? 'flat' : trend > 0 ? 'up' : 'down';
  const label =
    avg === null
      ? 'Pas encore de moyenne'
      : `Moyenne ${average(avg)} sur 20` +
        (trend === null
          ? ''
          : direction === 'flat'
            ? ', stable sur 30 jours'
            : `, ${direction === 'up' ? 'en hausse' : 'en baisse'} de ${average(Math.abs(trend))} point sur 30 jours`) +
        `, ${recent.length} note${recent.length > 1 ? 's' : ''} récente${recent.length > 1 ? 's' : ''}`;

  return h(
    `figure.orbit.orbit-${mini ? 'mini' : 'hero'}`,
    { role: 'img', 'aria-label': label },
    svg,
    h(
      'figcaption.orbit-center',
      h('span.orbit-value', avg === null ? '–' : average(avg)),
      !mini && h('span.orbit-scale', '/20'),
      !mini &&
        trend !== null &&
        h(
          `span.orbit-trend.trend-${direction}`,
          icon(direction === 'up' ? 'up' : direction === 'down' ? 'down' : 'flat', 14),
          direction === 'flat' ? 'stable' : signed(trend),
        ),
    ),
  );
}
