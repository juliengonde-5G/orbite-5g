/**
 * Construction du DOM sans innerHTML.
 *
 * `h('div.card', { onclick }, enfants…)` crée un élément ; les chaînes deviennent
 * des nœuds texte, donc aucune donnée venue d'ÉcoleDirecte n'est interprétée
 * comme du HTML. `s()` fait de même pour le SVG.
 */
type Child = Node | string | number | false | null | undefined | Child[];
type Attrs = Record<string, unknown>;

function apply(el: Element, attrs: Attrs): void {
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      el.addEventListener(key.slice(2), value as EventListener);
    } else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value as Record<string, string>))
        (el as HTMLElement).style.setProperty(prop, v);
    } else if (key === 'dataset' && typeof value === 'object') {
      for (const [k, v] of Object.entries(value as Record<string, string>)) (el as HTMLElement).dataset[k] = v;
    } else if (value === true) {
      el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }
}

function append(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    if (Array.isArray(child)) append(el, child);
    else el.append(child instanceof Node ? child : String(child));
  }
}

/** `tag.classe.autre#id` puis attributs facultatifs, puis enfants. */
export function h<K extends keyof HTMLElementTagNameMap>(
  spec: K | `${K}.${string}` | `${K}#${string}`,
  attrs?: Attrs | Child,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const [tagPart = 'div', ...rest] = spec.split(/(?=[.#])/);
  const el = document.createElement(tagPart) as HTMLElementTagNameMap[K];
  for (const part of rest) {
    if (part.startsWith('.')) el.classList.add(part.slice(1));
    else if (part.startsWith('#')) el.id = part.slice(1);
  }
  if (attrs && typeof attrs === 'object' && !(attrs instanceof Node) && !Array.isArray(attrs)) apply(el, attrs);
  else children.unshift(attrs as Child);
  append(el, children);
  return el;
}

const SVG = 'http://www.w3.org/2000/svg';

export function s(tag: string, attrs: Attrs = {}, ...children: Child[]): SVGElement {
  const el = document.createElementNS(SVG, tag);
  apply(el, attrs);
  append(el, children);
  return el;
}

/** Icônes au trait, dessinées pour Orbite (24 × 24). */
const ICONS: Record<string, string> = {
  home: 'M4 11.5 12 5l8 6.5V19a1 1 0 0 1-1 1h-4.5v-5h-5v5H5a1 1 0 0 1-1-1z',
  tasks: 'M8 7h11M8 12h11M8 17h11M4 7h.01M4 12h.01M4 17h.01',
  grades: 'M5 19V9m7 10V5m7 14v-7',
  chart: 'M4 18l5-6 4 3 7-9',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 8a7 7 0 0 1 14 0',
  family:
    'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm7.5 1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 20a6 6 0 0 1 12 0m1-5.5a5 5 0 0 1 5 5.5',
  check: 'M5 12.5 10 17l9-10',
  clip: 'M15.5 7.5 9 14a2 2 0 0 0 2.8 2.8l7-7a4 4 0 0 0-5.6-5.6l-7 7a6 6 0 0 0 8.5 8.5L20 14',
  refresh: 'M20 11a8 8 0 0 0-14.6-4.5L4 8m0-4v4h4m-4 5a8 8 0 0 0 14.6 4.5L20 16m0 4v-4h-4',
  back: 'M15 5 8 12l7 7',
  erase: 'M9 5h11v14H9l-6-7zM12.5 9.5l5 5m0-5-5 5',
  close: 'M6 6l12 12M18 6 6 18',
  plus: 'M12 5v14M5 12h14',
  key: 'M14.5 9.5a4.5 4.5 0 1 1-1.3-3.2M14.5 9.5 21 16v3h-3v-2h-2v-2h-2l-1.6-1.6',
  link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L11.5 7m1 10-1.5 1.7A4 4 0 0 1 5.3 13l3-3a4 4 0 0 1 5.7 0',
  share: 'M12 3v12m0-12-4 4m4-4 4 4M6 11H5v9h14v-9h-1',
  bolt: 'M13 3 5 13h6l-1 8 8-10h-6z',
  up: 'M7 14l5-5 5 5',
  down: 'M7 10l5 5 5-5',
  flat: 'M6 12h12',
  copy: 'M9 9h10v10H9zM5 15V5h10',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
};

export function icon(name: keyof typeof ICONS | string, size = 22): SVGElement {
  return s(
    'svg',
    {
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      'aria-hidden': 'true',
      class: 'icon',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 2,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    },
    s('path', { d: ICONS[name] ?? '' }),
  );
}

export function clear(el: Element): void {
  while (el.firstChild) el.firstChild.remove();
}

/** Petite vibration de confirmation (Android ; ignorée ailleurs). */
export function tap(ms = 8): void {
  try {
    navigator.vibrate?.(ms);
  } catch {}
}
