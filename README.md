<p align="center"><img src="public/favicon.svg" alt="" width="88" height="88"></p>

# Orbite 5G

Notes, devoirs et progrès des enfants depuis ÉcoleDirecte, dans une appli mobile installable, hébergée sur le NAS de la famille.

Version familiale d'[Orbite](https://github.com/thomasfaure/orbite-ed) (Thomas Fauré, licence MIT) : on garde son moteur ÉcoleDirecte (question de sécurité, code TOTP, plusieurs établissements, rotation des jetons) et on change tout le reste.

- **Un compte par membre** de la famille, déverrouillé par un code PIN à six chiffres. Les enfants ne voient que leurs propres résultats ; les parents voient tout.
- **Une seule connexion ÉcoleDirecte**, celle du compte parent, gardée chiffrée sur le NAS avec reconnexion automatique. Personne d'autre n'en connaît les identifiants.
- **Interface pensée pour le téléphone** : chaque écran s'ouvre sur un ciel à la couleur de l'élève, où brille l'orbite (moyenne au centre, chaque note récente en satellite) ; dock d'onglets flottant, rail vertical sur tablette et ordinateur. Devoirs à cocher, notes, progression, compétences.
- **Mon cartable** : le matin, l'élève voit ses cours du jour, les devoirs à rendre, les infos du collège et la liste du sac à préparer.
- **Messagerie de l'établissement, en lecture seule** : les parents lisent la messagerie famille et celle de chaque enfant, et peuvent partager un message (sortie, réunion) avec un enfant ; chaque élève lit sa propre messagerie. Pièces jointes par lien signé de 15 minutes. Ouvrir un message le marque comme lu sur ÉcoleDirecte, comme sur le site.
- **Vie scolaire** : absences, retards, punitions, sanctions et encouragements. Chaque élève voit les siens, les parents tout ; les réglages de l'établissement (sanctions masquées, auteur, commentaires) sont respectés.
- **Notes détaillées** : moyennes officielles par matière (avec la moyenne de la classe et la fourchette quand le collège les publie), appréciation du professeur sur chaque devoir, date du conseil de classe et professeur principal. Le rang n'est jamais affiché.
- **Devoirs** : la semaine d'un coup d'œil (devoirs restants et contrôles, jour par jour) et **En classe**, ce que les professeurs ont noté avoir fait pendant les six derniers jours de classe.
- **Documents** (parents) : bulletins, documents de vie scolaire, administratifs et factures publiés sur ÉcoleDirecte, par lien signé.
- **Récap de la semaine** (parents) : enfant par enfant, notes, devoirs et contrôles à venir, vie scolaire, sans classement entre enfants.
- **Notifications** sur le téléphone : nouvelle note (la matière, jamais la valeur), message du collège, message partagé par un parent, vie scolaire (absences et sanctions aux parents seulement, encouragements aussi à l'élève), rappel « prépare ton sac » à 19 h la veille d'un jour de classe, récap du dimanche soir. Rien entre 22 h et 7 h. Chaque profil choisit ce qu'il reçoit dans Moi → Notifications. Sur iPhone, Orbite doit d'abord être ajoutée à l'écran d'accueil (iOS 16.4 ou plus).
- Mode lecture OpenDyslexic ou grands caractères, thème clair ou sombre, couleur personnelle.
- Conseil du jour rédigé par Claude, facultatif (statistiques anonymes uniquement).

Lecture seule : Orbite n'écrit rien sur ÉcoleDirecte (seule l'ouverture d'un message le marque comme lu). Les cases cochées et les partages restent dans Orbite.

## Installer sur le Synology (Container Manager)

1. Créer le dossier `/volume1/docker/orbite/data` (File Station).
2. Container Manager → **Projet** → **Créer** : nom `orbite`, chemin `/docker/orbite`, source « Créer docker-compose.yml », coller [`docker-compose.yml`](docker-compose.yml) et adapter `ORBITE_FAMILY`.
3. Ouvrir Orbite : le parent administrateur choisit son PIN. Depuis le Wi-Fi de la maison (`http://<adresse-du-NAS>:3210`), rien d'autre n'est demandé ; depuis Internet, il faut le code d'installation à usage unique affiché dans le journal du conteneur « orbite » (Container Manager).
4. Réglages → ÉcoleDirecte → Connecter, puis répondre à la question de sécurité.
5. Réglages → Famille : créer un code d'activation pour chaque membre. Chacun l'entre sur son téléphone et choisit son PIN. Les enfants sont reliés à leur fiche ÉcoleDirecte automatiquement par le prénom.

### Accès depuis l'extérieur (4G)

Panneau de configuration → Portail de connexion → Avancé → **Proxy inversé** → Créer :

| Source | Destination |
| --- | --- |
| HTTPS, nom d'hôte `orbite.<votre-ddns>.synology.me`, port 443 | HTTP, `localhost`, port 3210 |

Puis Sécurité → Certificat : ajouter ce nom d'hôte au certificat Let's Encrypt, et renseigner `ORBITE_PUBLIC_URL` dans le projet (`https://orbite.…`). Ne jamais ouvrir le port 3210 sur la box : seul le 443 du proxy doit être exposé.

### Installer l'appli sur les téléphones

iPhone : Safari → Partager → « Sur l'écran d'accueil ». Android : menu de Chrome → « Installer l'application ».

### Mettre à jour

Chaque modification poussée sur `main` publie une nouvelle image `ghcr.io/juliengonde-5g/orbite-5g:latest`. Dans Container Manager : Projet `orbite` → Action → **Construire** (retélécharge l'image). Les données restent dans `/volume1/docker/orbite/data`.

## Configuration

| Variable | Rôle |
| --- | --- |
| `ORBITE_FAMILY` | Profils du premier démarrage : `Camille:parent+admin, Léo:enfant:5e`. Ignorée ensuite. |
| `ORBITE_PUBLIC_URL` | Adresse HTTPS publique (cookies `Secure`, hôte autorisé). |
| `ORBITE_ALLOWED_HOSTS` | Autres noms d'hôte autorisés, séparés par des virgules. |
| `ANTHROPIC_API_KEY` | Active le conseil du jour (Claude). Facultatif : la clé peut aussi être saisie dans Réglages → Claude (IA), où elle est gardée chiffrée et prend le pas sur cette variable. |
| `ANTHROPIC_MODEL` | Modèle utilisé, `claude-haiku-5-5` par défaut. |
| `ORBITE_PUSH_CONTACT` | Contact `mailto:` transmis aux services de notification (facultatif ; par défaut l'adresse de `ORBITE_PUBLIC_URL`). |
| `ORBITE_DATA_DIR` | Dossier du coffre chiffré (`/data` dans l'image). |
| `ED_API_VERSION` | Version d'API ÉcoleDirecte si le site en exige une autre. |

## Sécurité

- Coffre AES-256-GCM (`/data`) : profils, empreintes des PIN (scrypt), appareils connectés, identifiants ÉcoleDirecte, cache. La clé `key` est dans le même dossier : sauvegarder le dossier entier, et ne jamais le partager.
- PIN : cinq erreurs bloquent le profil 1 minute, puis 2, 4… jusqu'à 1 heure. Un appareil reste connecté 180 jours.
- Hors de la maison, un appareil inconnu ne voit pas les prénoms : il faut taper le sien.
- Contrôle de l'hôte et de l'origine, en-tête anti-CSRF obligatoire, cookie HttpOnly SameSite=Strict, CSP stricte, aucune ressource externe sauf les photos d'ÉcoleDirecte.
- Notifications : chiffrées de bout en bout (Web Push, RFC 8291), envoyées seulement vers les services push connus (Apple, Google, Mozilla, Microsoft). Un abonnement est lié à l'appareil connecté : verrouiller le profil l'arrête.
- Conseils IA : seuls des agrégats (moyennes, tendance, matières) partent vers l'API Anthropic ; jamais de nom, de photo, d'intitulé ni de devoir.

L'API ÉcoleDirecte est privée et peut changer ; ce projet n'est pas affilié à ÉcoleDirecte.

## Développement

```sh
nvm use            # Node 24
npm install
npm run demo       # http://127.0.0.1:3210, trois élèves fictifs, connexion « démo »
npm run check      # types, lint, format, tests
```

Organisation : `src/server` (HTTP, famille, coffre, ÉcoleDirecte, conseils), `src/client` (interface sans framework), `src/shared` (types et calculs communs), `src/styles` (SCSS), `public` (coque PWA, icônes, polices OFL).

## Licence

MIT. Orbite original © 2026 Thomas Fauré. Polices Bricolage Grotesque, Atkinson Hyperlegible Next et OpenDyslexic sous licence SIL OFL 1.1.
