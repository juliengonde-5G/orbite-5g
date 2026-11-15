/**
 * Clé Anthropic partagée : chaque famille consomme la clé « master » dans la
 * limite d'un plafond quotidien d'appels, pour qu'une famille ne puisse pas
 * épuiser la clé des autres.
 *
 * `MeteredCoach` enveloppe le conseiller d'une famille : chaque appel à Claude
 * passe par `UsageMeter.take()`, qui lève `QuotaError` (message lisible par
 * l'utilisateur) une fois le plafond atteint. Le plafond se remet à zéro chaque
 * jour à Paris. La famille ne voit ni ne change la clé.
 */
import type { Coach, KeyCheck } from './coach.ts';
import type { Child } from '../shared/types.ts';

export class QuotaError extends Error {}

export interface UsageMeter {
  /** Compte un appel ; lève `QuotaError` si le plafond du jour est atteint. */
  take(): void;
}

export class MeteredCoach implements Coach {
  private readonly inner: Coach;
  private readonly meter: UsageMeter;

  constructor(inner: Coach, meter: UsageMeter) {
    this.inner = inner;
    this.meter = meter;
  }

  get configured(): boolean {
    return this.inner.configured;
  }

  async advice(childId: string, child: Pick<Child, 'notes'>): Promise<string> {
    this.meter.take();
    return this.inner.advice(childId, child);
  }

  async complete(system: string, user: string, maxTokens: number): Promise<string> {
    this.meter.take();
    return this.inner.complete(system, user, maxTokens);
  }

  /** La clé est gérée par l'hébergeur : une famille ne la modifie pas. */
  setKey(_key: string | null): void {}

  async check(_key: string): Promise<KeyCheck> {
    throw new QuotaError('La clé Claude est fournie par Orbite.');
  }
}
