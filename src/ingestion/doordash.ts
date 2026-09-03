import { env } from "../lib/env.js";

/**
 * STUB — DoorDash webhook ingestion.
 *
 * Une fois l'accès partenaire DoorDash obtenu:
 *   1. Remplacer verifySignature() par la vérification réelle (DoorDash
 *      signe ses webhooks avec un JWT/HMAC dérivé de DOORDASH_SIGNING_SECRET
 *      — à confirmer avec leur doc développeur).
 *   2. Implémenter doordashToNormalizedOrder() dans
 *      src/normalization/toNormalizedOrder.ts avec le vrai format de payload.
 *   3. Mettre DOORDASH_ENABLED=true dans .env.
 * Aucun changement requis ailleurs dans le pipeline (queue, connecteur Cluster, DB).
 */

export function isDoorDashEnabled(): boolean {
  return env.DOORDASH_ENABLED;
}

/**
 * TODO: vérification de signature DoorDash.
 * A implémenter une fois la doc technique confirmée par DoorDash.
 */
export function verifyDoorDashSignature(
  _rawBody: string,
  _signatureHeader: string | undefined
): boolean {
  throw new Error(
    "verifyDoorDashSignature: not implemented — waiting on DoorDash webhook signing docs"
  );
}
