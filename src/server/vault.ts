/**
 * Coffre chiffré du serveur.
 *
 * Rôle : seul endroit où Orbite écrit sur disque. Chaque document (`family`,
 * `ecoledirecte`, `cache`…) est un JSON chiffré en AES-256-GCM dans le dossier
 * de données (volume Docker `/data` sur le NAS).
 *
 * Format d'un fichier `<nom>.enc` :
 *
 *   "O5G1" (4 octets) | IV (12) | tag GCM (16) | JSON chiffré
 *
 * La donnée authentifiée (AAD) contient le nom du document : un fichier renommé
 * ou échangé avec un autre devient illisible au lieu d'être mal interprété.
 *
 * Points d'attention :
 * - Clé aléatoire de 32 octets (`key`, droits 0600) créée au premier démarrage.
 *   Elle doit rester avec les fichiers : sans elle, rien n'est récupérable.
 *   Si un coffre existe sans clé, le démarrage échoue au lieu d'en créer une.
 * - Écriture atomique (temporaire synchronisé puis renommage) : une coupure laisse
 *   l'ancienne ou la nouvelle version, jamais un fichier tronqué.
 * - Ce chiffrement protège une copie du disque ou d'une sauvegarde sans la clé ;
 *   il ne protège pas contre un accès administrateur au NAS.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const MAGIC = 'O5G1';
const NAME = /^[a-z][a-z0-9-]{0,40}$/;

export class Vault {
  readonly directory: string;
  private readonly key: Buffer;

  constructor(directory: string) {
    this.directory = directory;
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      chmodSync(directory, 0o700);
    } catch {
      // Certains volumes montés refusent chmod : les fichiers restent créés en 0600.
    }
    const keyFile = join(directory, 'key');
    if (!existsSync(keyFile)) {
      if (readdirSync(directory).some((f) => f.endsWith('.enc')))
        throw new Error('Clé du coffre absente alors que des données chiffrées existent. Restaurez le fichier key.');
      try {
        writeFileSync(keyFile, randomBytes(32), { flag: 'wx', mode: 0o600 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }
    }
    this.key = readFileSync(keyFile);
    if (this.key.length !== 32) throw new Error('Clé du coffre invalide.');
  }

  private file(name: string): string {
    if (!NAME.test(name)) throw new Error('Nom de document invalide.');
    return join(this.directory, name + '.enc');
  }

  /** Document déchiffré, ou `fallback` s'il n'existe pas encore. */
  load<T>(name: string, fallback: T): T {
    let bytes: Buffer;
    try {
      bytes = readFileSync(this.file(name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return fallback;
      throw e;
    }
    try {
      if (bytes.length < 32 || bytes.subarray(0, 4).toString() !== MAGIC) throw new Error();
      const decipher = createDecipheriv('aes-256-gcm', this.key, bytes.subarray(4, 16));
      decipher.setAAD(Buffer.from(MAGIC + ':' + name));
      decipher.setAuthTag(bytes.subarray(16, 32));
      return JSON.parse(Buffer.concat([decipher.update(bytes.subarray(32)), decipher.final()]).toString('utf8')) as T;
    } catch {
      throw new Error(`Le document chiffré « ${name} » est illisible. Aucun fichier n’a été remplacé.`);
    }
  }

  save(name: string, value: unknown): void {
    const target = this.file(name);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(Buffer.from(MAGIC + ':' + name));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    const bytes = Buffer.concat([Buffer.from(MAGIC), iv, cipher.getAuthTag(), encrypted]);
    const temp = join(this.directory, `.${name}-${randomBytes(8).toString('hex')}.tmp`);
    try {
      const fd = openSync(temp, 'wx', 0o600);
      try {
        writeFileSync(fd, bytes);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, target);
      const dir = openSync(this.directory, 'r');
      try {
        fsyncSync(dir);
      } finally {
        closeSync(dir);
      }
    } finally {
      if (existsSync(temp)) unlinkSync(temp);
    }
  }

  remove(name: string): void {
    try {
      unlinkSync(this.file(name));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
}
