/** Contrat de l'API de la plateforme multi-familles (`/api/hub/*`). */

export interface FamilyView {
  slug: string;
  name: string;
  createdAt: number;
  disabled: boolean;
  dailyLimit: number;
  usedToday: number;
}

export interface InviteView {
  label: string;
  createdAt: number;
  expiresAt: number;
  used: boolean;
}

export interface HubOverview {
  families: FamilyView[];
  invites: InviteView[];
}

export interface HubCreated {
  slug: string;
  name: string;
  /** Lien de la famille, relatif à la racine du serveur (`/f/dupont-k7x2/`). */
  url: string;
  setupCode: string;
  adminName: string;
}
