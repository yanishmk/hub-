import { env } from "../lib/env.js";

/**
 * STUB — Skip the Dishes webhook ingestion.
 *
 * Une fois l'accès partenaire Skip obtenu:
 *   1. Remplacer verifySignature() par la vérification réelle (à confirmer
 *      avec leur doc développeur — probablement HMAC sur SKIP_WEBHOOK_SIGNING_SECRET).
 *   2. Implémenter skipToNormalizedOrder() dans
 *      src/normalization/toNormalizedOrder.ts avec le vrai format de payload.
 *   3. Mettre SKIP_ENABLED=true dans .env.
 * Aucun changement requis ailleurs dans le pipeline (queue, connecteur Cluster, DB).
 */

export function isSkipEnabled(): boolean {
  return env.SKIP_ENABLED;
}

/**
 * TODO: vérification de signature Skip the Dishes.
 * A implémenter une fois la doc technique confirmée par Skip.
 */
export function verifySkipSignature(
  _rawBody: string,
  _signatureHeader: string | undefined
): boolean {
  throw new Error(
    "verifySkipSignature: not implemented — waiting on Skip the Dishes webhook signing docs"
  );
}
