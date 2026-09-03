# cluster-pos-hub

Hub central de commandes : reçoit les commandes de plusieurs sources (Uber Eats, DoorDash, Skip the Dishes, site web) et les pousse vers le système de caisse **Cluster POS**, qui imprime automatiquement en cuisine une fois la commande injectée.

Le connecteur Cluster POS et l'ingestion "site web" sont **actifs dès maintenant**. Uber Eats est prêt à être activé avec les credentials partenaires. DoorDash / Skip restent des **stubs désactivés**.

## Architecture

```
sources (Uber Eats / DoorDash / Skip / Site web)
        ↓ webhooks ou POST direct
[Ingestion]  → valide la requête (Zod), répond vite
        ↓
[Normalisation]  → convertit chaque format source vers NormalizedOrder
        ↓
[Queue + état]  → persiste en DB (Postgres/Prisma), idempotence (source+externalId),
                   cycle de vie: received → sent_to_pos → confirmed → preparing → ready → error
        ↓
[Connecteur Cluster POS]  → envoie la commande via CLUSTER_API_KEY / CLUSTER_SERIAL (BullMQ, retry + backoff exponentiel)
        ↓
Cluster POS → impression cuisine automatique (comportement natif Cluster)
```

Structure du code :

```
src/
  ingestion/        website.ts + ubereats.ts (actifs) + doordash.ts / skip.ts (stubs)
  normalization/     toNormalizedOrder.ts, dbOrder.ts
  queue/             orderQueue.ts (BullMQ + idempotence), worker.ts (traitement + retry)
  connectors/        clusterPos.ts (seul point d'appel HTTP vers Cluster POS)
  routes/            orders.ts (site web + liste/erreurs/retry), webhooks.ts (Uber + stubs delivery), dashboard.ts (page admin)
  db/schema.prisma
  app.ts, server.ts
tests/
```

## Prérequis

- Node.js 20+
- PostgreSQL (local ou Docker)
- Redis (local ou Docker), utilisé par BullMQ

## Installation

```bash
npm install
cp .env.example .env
# éditer .env : DATABASE_URL, REDIS_URL, CLUSTER_API_KEY, CLUSTER_SERIAL, CLUSTER_API_BASE_URL
npx prisma migrate dev --name init
```

## Lancer en local

Deux process séparés (le serveur HTTP et le worker qui envoie vers Cluster POS) :

```bash
npm run dev      # Fastify sur http://localhost:3000
npm run worker    # Worker BullMQ (consomme la file et appelle Cluster POS)
```

## Tester une commande via le endpoint site web

```bash
curl -X POST http://localhost:3000/orders/website \
  -H "Content-Type: application/json" \
  -H "x-api-key: <WEBSITE_API_KEY de ton .env>" \
  -d '{
    "externalId": "web-order-001",
    "orderType": "pickup",
    "customer": { "name": "Alice Tremblay", "phone": "514-555-0100" },
    "items": [
      { "name": "Poutine", "quantity": 2, "unitPrice": 9.50, "modifiers": [{ "name": "Extra fromage", "price": 1.50 }] }
    ],
    "subtotal": 23.00,
    "tax": 3.45,
    "total": 26.45,
    "paymentStatus": "pay_at_pos"
  }'
```

Réponse `202` avec `orderId` et `duplicate: false`. Renvoyer exactement le même `externalId` une seconde fois renvoie `duplicate: true` sans créer de doublon.

Le worker (`npm run worker`) prend le relais, appelle `sendOrderToCluster()`, et journalise chaque tentative en base (table `ClusterDeliveryAttempt`).

### Consulter / relancer une commande

- `GET /orders` — liste des commandes, filtrable avec `?status=received|sent_to_pos|confirmed|preparing|ready|error|cancelled`
- `GET /orders/:id` — détail + événements + tentatives Cluster
- `GET /orders/errors` — liste des commandes en état `error` après épuisement des retries
- `POST /orders/:id/retry` — remet une commande en erreur dans la file (retry manuel)

Ces 4 endpoints sont protégés par `ADMIN_API_KEY` (header `x-api-key`) si elle est définie dans `.env` ; laissée vide, l'accès reste ouvert (pratique en dev local).

## Dashboard admin

Une page simple est servie sur **`GET /dashboard`** (HTML + JS vanilla, aucune dépendance, aucun build front) : liste des commandes avec filtre par statut, rafraîchissement auto (10s), détail d'une commande (événements + tentatives Cluster POS) au clic sur une ligne, et bouton "Relancer" sur les commandes en erreur.

Si `ADMIN_API_KEY` est définie, la page demande la clé au premier appel 401 et la garde en `localStorage` — rien à configurer côté serveur au-delà de la variable d'env.

Ouvrir : `http://localhost:3000/dashboard`

## Activer une plateforme de livraison plus tard

Uber Eats est maintenant branche sur le pipeline. Une fois l'acces partenaire accorde, configurer les variables `UBEREATS_*`, exposer `/webhooks/ubereats` en HTTPS public, puis mettre `UBEREATS_ENABLED=true`.

Pour DoorDash / Skip, il reste 3 etapes, sans toucher au reste du pipeline :

1. **Parsing reel** : implementer `<platform>ToNormalizedOrder()` dans `src/normalization/toNormalizedOrder.ts`.
2. **Verification de signature** : implementer `verify<Platform>Signature()` dans `src/ingestion/<platform>.ts`.
3. **Activation** : mettre `<PLATFORM>_ENABLED=true` dans `.env`, et brancher l'appel a `enqueueOrder()` dans la route correspondante de `src/routes/webhooks.ts`.

Aucun changement requis dans `queue/`, `connectors/clusterPos.ts`, ou le schéma DB.

## Ajuster le connecteur Cluster POS

Le seul endroit qui fait un appel HTTP réel vers Cluster POS est `sendOrderToCluster()` dans `src/connectors/clusterPos.ts` (et `buildClusterPayload()` juste au-dessus pour la forme du corps de requête). Une fois la doc technique Cluster reçue, ajuster :

- l'URL (`CLUSTER_API_BASE_URL` + chemin actuellement `/orders`)
- les headers d'authentification
- les noms de champs du payload
- le parsing de la réponse (actuellement on cherche `orderId` ou `id` dans un JSON)

## Uber Eats

`POST /webhooks/ubereats` est maintenant actif lorsque `UBEREATS_ENABLED=true`.

Flux implemente:

1. Verification `X-Uber-Signature` avec HMAC-SHA256 sur le corps brut de la requete.
2. Support des webhooks `orders.notification`, `orders.scheduled.notification` et `orders.release`.
3. Si le webhook contient seulement `resource_href` / `resource_id`, le hub recupere le detail de commande via OAuth `client_credentials`.
4. Normalisation Uber Eats vers `NormalizedOrder`.
5. Enqueue idempotent vers le pipeline Cluster POS.
6. Optionnel: `UBEREATS_AUTO_ACCEPT=true` appelle `/accept_pos_order` apres enregistrement de la commande.

Pour le sandbox Uber Eats, utiliser `UBEREATS_AUTH_URL=https://sandbox-login.uber.com/oauth/v2/token` et `UBEREATS_API_BASE_URL=https://test-api.uber.com`.

## Mapping menu Uber Eats -> Cluster POS

Le mapping est dans `src/menu/clusterItemMapping.ts`.

Item valide confirme par test reel:

| Nom Uber Eats | Item_uid Cluster |
|---|---:|
| `Crêpe classique Nutella` | `6` |

Pour ajouter un produit, ajouter une entree avec son `clusterItemUid`, le nom Cluster, et les alias exacts utilises sur Uber Eats. Le matching ignore les accents, la casse et les espaces multiples.

## Variables d'environnement

Voir `.env.example`. Points clés :

| Variable | Rôle |
|---|---|
| `DATABASE_URL` | Connexion Postgres (Prisma) |
| `REDIS_URL` | Connexion Redis (BullMQ) |
| `CLUSTER_API_KEY`, `CLUSTER_SERIAL`, `CLUSTER_API_BASE_URL` | Auth + endpoint Cluster POS |
| `CLUSTER_MAX_RETRIES` | Nombre de tentatives d'envoi avant état `error` |
| `WEBSITE_API_KEY` | Clé partagée pour authentifier `/orders/website` |
| `ADMIN_API_KEY` | Clé pour le dashboard et les endpoints de gestion (`/orders`, `/orders/errors`, `/orders/:id`, retry). Vide = pas d'auth |
| `UBEREATS_ENABLED` / `DOORDASH_ENABLED` / `SKIP_ENABLED` | Flags d'activation par plateforme (false par défaut) |
| `UBEREATS_API_BASE_URL`, `UBEREATS_AUTH_URL`, `UBEREATS_OAUTH_SCOPE` | Endpoints et scope OAuth Uber Eats |
| `UBEREATS_AUTO_ACCEPT` | Appelle `/accept_pos_order` après ingestion si activé |

## Déploiement (hébergement pas encore décidé)

Le hub doit tourner en continu et être joignable en **HTTPS public** pour que Uber Eats / DoorDash / Skip puissent envoyer leurs webhooks (le site web, lui, peut appeler le hub en interne). Tant que l'hébergement final n'est pas choisi, un `Dockerfile` + `docker-compose.yml` sont fournis pour rester portable (VPS, Railway, Render, Fly.io, ou n'importe quel hôte avec Docker) :

```bash
cp .env.example .env
# éditer .env (CLUSTER_API_KEY, CLUSTER_SERIAL, clés admin/website, etc.)
docker compose up --build
```

Ça démarre 4 services : `postgres`, `redis`, `migrate` (applique les migrations Prisma puis s'arrête), `app` (API + dashboard sur le port 3000) et `worker` (traite la file BullMQ vers Cluster POS). Pour un hébergement public, il ne reste qu'à mettre un reverse proxy TLS (Caddy, Nginx, ou le TLS géré par la plateforme cloud choisie) devant le service `app`.

## Tests

```bash
npm test
```

Couvre : normalisation site web (unitaire), connecteur Cluster POS avec `fetch` mocké (succès, 4xx, 5xx, timeout réseau), un test d'intégration bout en bout (ingestion → normalisation → queue avec idempotence → worker → appel Cluster POS mocké → mise à jour du statut en base), et les routes admin (`GET /orders`, filtre par statut, garde `ADMIN_API_KEY`, page `/dashboard`).
