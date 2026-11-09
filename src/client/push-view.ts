/**
 * Réglage des notifications de cet appareil (onglet Moi).
 *
 * Sur iPhone, les notifications web n'existent que pour Orbite ajoutée à l'écran
 * d'accueil (iOS 16.4 et plus) : la carte l'explique au lieu d'un bouton inutile.
 */
import { api, ApiError } from './api.ts';
import { h } from './dom.ts';
import { state } from './state.ts';
import type { PushPrefs, PushStatus } from '../shared/types.ts';

let status: PushStatus | null = null;
let loading = false;
let busy = false;
let message = '';

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
const standalone = () =>
  matchMedia('(display-mode: standalone)').matches || !!(navigator as Navigator & { standalone?: boolean }).standalone;
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent);

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const b64 = base64url.replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

async function enable(): Promise<void> {
  if (!status) return;
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    message =
      permission === 'denied'
        ? 'Les notifications sont bloquées pour Orbite. Autorise-les dans les réglages du téléphone ou du navigateur.'
        : 'Autorisation non accordée.';
    return;
  }
  const registration = await navigator.serviceWorker.ready;
  const old = await registration.pushManager.getSubscription();
  // Clé du serveur changée (réinstallation) : l'ancien abonnement ne marcherait plus.
  if (old) await old.unsubscribe().catch(() => undefined);
  const sub = await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: keyBytes(status.publicKey),
  });
  status = await api.push.subscribe(sub.toJSON());
  message = 'Notifications activées sur cet appareil.';
}

async function disable(): Promise<void> {
  const registration = await navigator.serviceWorker.ready;
  const sub = await registration.pushManager.getSubscription();
  if (sub) await sub.unsubscribe().catch(() => undefined);
  status = await api.push.unsubscribe();
  message = 'Notifications désactivées sur cet appareil.';
}

const LABELS: Record<keyof PushPrefs, [string, string]> = {
  notes: ['Nouvelles notes', 'La matière et le devoir, jamais la note sur l’écran verrouillé.'],
  mail: ['Messages du collège', 'Dès qu’un message arrive sur ÉcoleDirecte.'],
  life: ['Vie scolaire', 'Absences, retards, sanctions et encouragements.'],
  bag: ['Cartable à 19 h', 'La veille d’un jour de classe : prépare ton sac.'],
  recap: ['Récap du dimanche', 'Le dimanche soir : la semaine de chaque enfant.'],
};

export function notificationsCard(rerender: () => void): HTMLElement | null {
  const me = state.session?.me;
  if (!me) return null;
  if (!status && !loading) {
    loading = true;
    api.push
      .status()
      .then((s) => {
        status = s;
        rerender();
      })
      .catch(() => undefined)
      .finally(() => {
        loading = false;
      });
  }
  const run = async (task: () => Promise<void>) => {
    if (busy) return;
    busy = true;
    message = '';
    rerender();
    try {
      await task();
    } catch (err) {
      message = err instanceof ApiError ? err.message : 'Action impossible sur ce navigateur.';
    } finally {
      busy = false;
      rerender();
    }
  };
  const keys = (Object.keys(LABELS) as (keyof PushPrefs)[]).filter((k) =>
    me.role === 'parent' ? k !== 'bag' : k !== 'recap',
  );
  const blockedHere = !supported() ? (ios() && !standalone() ? 'ios' : 'unsupported') : null;
  return h(
    'section.block.notify',
    h('header.section-head', h('h2', 'Notifications')),
    blockedHere === 'ios'
      ? h(
          'p.install',
          'Sur iPhone, ajoute d’abord Orbite à l’écran d’accueil (Partager puis « Sur l’écran d’accueil »), puis ouvre-la depuis son icône pour activer les notifications.',
        )
      : blockedHere
        ? h('p.inline-note', 'Ce navigateur ne sait pas recevoir de notifications.')
        : h(
            `div.notify-main${status?.subscribed ? '.is-on' : ''}`,
            h(
              'p.notify-state',
              h('span.dot'),
              !status
                ? 'Chargement…'
                : status.subscribed
                  ? 'Activées sur cet appareil'
                  : 'Désactivées sur cet appareil',
            ),
            h(
              'div.row-actions',
              status &&
                h(
                  `button.button${status.subscribed ? '' : '.button-primary'}`,
                  {
                    type: 'button',
                    disabled: busy,
                    onclick: () => void run(status?.subscribed ? disable : enable),
                  },
                  status.subscribed ? 'Désactiver' : 'Activer',
                ),
              status?.subscribed &&
                h(
                  'button.button',
                  {
                    type: 'button',
                    disabled: busy,
                    onclick: () =>
                      void run(async () => {
                        await api.push.test();
                        message = 'Notification envoyée : elle arrive dans quelques secondes.';
                      }),
                  },
                  'Tester',
                ),
            ),
          ),
    message && h('p.hint', { role: 'status' }, message),
    status &&
      !blockedHere &&
      h(
        'div.notify-prefs',
        keys.map((k) => {
          const [title, detail] = LABELS[k];
          return h(
            'label.toggle',
            h('input', {
              type: 'checkbox',
              checked: status?.prefs[k] ?? true,
              disabled: busy,
              onchange: (e: Event) => {
                const checked = (e.target as HTMLInputElement).checked;
                void run(async () => {
                  status = await api.push.prefs({ [k]: checked });
                });
              },
            }),
            h('span', h('b', title), h('small', detail)),
          );
        }),
      ),
  );
}

/** Après un changement de profil, l'état de l'appareil est relu. */
export function resetNotifications(): void {
  status = null;
  message = '';
}
