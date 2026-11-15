/**
 * Serveur multi-familles : aiguille chaque requête vers la bonne famille.
 *
 * - `/…` : la famille « maison » (celle de l'administrateur de la plateforme), qui
 *   garde ses données à la racine du dossier de données ;
 * - `/f/<nom>-<suffixe>/…` : une autre famille, dans son propre coffre chiffré
 *   (`families/<nom>-<suffixe>`). Chaque famille est une application complète et
 *   indépendante ; seul le préfixe est retiré avant de lui passer la requête.
 *
 * Les familles actives sont démarrées dès le lancement (leurs tâches de fond :
 * notifications, rafraîchissement ÉcoleDirecte) ; une famille suspendue est
 * arrêtée, une famille rétablie ou nouvelle est démarrée au plus tard une
 * minute plus tard (ou à sa première requête).
 */
import http from 'node:http';
import { createApp, type AppOptions } from './server.ts';
import { Hub, type FamilyRecord, type HubOptions } from './hub.ts';
import { Vault } from './vault.ts';

export interface HubServerOptions extends AppOptions {
  /** Options propres à chaque famille (tests, démonstration) : coffre et fiche de la famille en entrée. */
  familyOptions?: (vault: Vault, record: FamilyRecord) => Partial<AppOptions>;
  hubOptions?: Partial<HubOptions>;
}

export function createHubServer(options: HubServerOptions): http.Server & { hub: Hub } {
  const { familyOptions, hubOptions, ...appOptions } = options;
  const hub = new Hub(options.vault, { directory: options.vault.directory, ...hubOptions });
  const home = createApp({ ...appOptions, hub, onKey: (key) => hub.setMasterKey(key) });
  const apps = new Map<string, http.Server>();
  hub.onRemoved = (slug) => {
    apps.get(slug)?.close();
    apps.delete(slug);
  };

  const open = (record: FamilyRecord): http.Server => {
    let app = apps.get(record.slug);
    if (!app) {
      const vault = new Vault(hub.familyDir(record.slug));
      const { hub: _hub, onKey: _onKey, ...shared } = appOptions;
      app = createApp({
        ...shared,
        vault,
        familySeed: record.seed,
        basePath: `/f/${record.slug}`,
        familyName: record.name,
        keyManaged: true,
        coach: hub.coachFor(record.slug),
        ...familyOptions?.(vault, record),
      });
      apps.set(record.slug, app);
    }
    return app;
  };

  /** Démarre les familles actives, arrête les suspendues. */
  const sync = () => {
    for (const record of hub.all()) {
      if (record.disabled) {
        apps.get(record.slug)?.close();
        apps.delete(record.slug);
      } else if (options.background) open(record);
    }
  };
  sync();
  const timer = setInterval(sync, 60000);
  timer.unref();

  const refuse = (
    res: http.ServerResponse,
    status: number,
    message: string,
    headers: http.OutgoingHttpHeaders = {},
  ) => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
    res.end(JSON.stringify({ error: message }));
  };

  const server = http.createServer((req, res) => {
    const m = /^\/f\/([a-z0-9-]+)(\/[^?#]*)?(\?[^#]*)?$/.exec(req.url ?? '/');
    if (!m) {
      home.emit('request', req, res);
      return;
    }
    const slug = m[1] ?? '';
    const record = hub.get(slug);
    if (!record) return refuse(res, 404, 'Famille introuvable.');
    if (!m[2]) {
      res.writeHead(301, { Location: `/f/${slug}/${m[3] ?? ''}`, 'Cache-Control': 'no-store' });
      res.end();
      return;
    }
    if (record.disabled) return refuse(res, 403, 'Cette famille est suspendue. Contacte l’administrateur d’Orbite.');
    req.url = m[2] + (m[3] ?? '');
    open(record).emit('request', req, res);
  }) as http.Server & { hub: Hub };

  server.hub = hub;
  server.on('close', () => {
    clearInterval(timer);
    home.close();
    for (const app of apps.values()) app.close();
    apps.clear();
  });
  return server;
}
