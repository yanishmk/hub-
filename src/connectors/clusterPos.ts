import { env } from "../lib/env.js";
import type { NormalizedOrder } from "../types/normalizedOrder.js";

export interface ClusterOrderResult {
  statusCode: number;
  clusterOrderRef?: string;
  rawResponse: string;
}

export class ClusterPosError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly rawResponse?: string,
    // Délai recommandé avant de réessayer, en ms (ex: header Retry-After sur un 429).
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "ClusterPosError";
  }
}

// Valeurs magiques de table_id confirmées par la collection Postman officielle
// Cluster API v1.5 (cluster-api-v1.5.environment.json).
const TABLE_ID = {
  counter: 9992,
  delivery: 9993,
  pickup: 9994,
} as const;

/**
 * Mappe notre orderType vers le table_id attendu par Cluster.
 *
 * "dine_in" est mappé sur "counter" (9992): le site crepone ne fait pas de
 * réservation de table (pas de numéro de table collecté au checkout), donc on
 * traite un dine_in comme une commande prise au comptoir. A ajuster vers un
 * vrai numéro de table si la gestion de tables est ajoutée un jour côté site.
 */
function toTableId(order: NormalizedOrder): number {
  switch (order.orderType) {
    case "pickup":
      return TABLE_ID.pickup;
    case "delivery":
      return TABLE_ID.delivery;
    case "dine_in":
      return TABLE_ID.counter;
  }
}

function orderSourceNote(order: NormalizedOrder): string {
  return order.source === "ubereats" ? "COMMANDE UBER" : "COMMANDE CREPONE.CA";
}

/**
 * Construit le corps de la requête envoyée à Cluster POS, au format réel
 * confirmé par la collection Postman officielle Cluster API v1.5 (send-order /
 * calculate-order / calculate-price partagent tous cette forme "table_id" +
 * "data.Cart.Nodes[].Database.Model").
 *
 * IMPORTANT — Item_uid: Cluster identifie chaque article par son ID de
 * catalogue interne (Item_uid), pas par son nom. On ne peut pas l'inventer:
 * chaque NormalizedOrderItem doit porter un clusterItemUid réel, obtenu une
 * fois pour toutes via un appel get-inventory sur le terminal, puis mappé au
 * menu du site. Tant que ce mapping n'existe pas, on refuse d'envoyer la
 * commande plutôt que de risquer de créer un article incorrect sur le POS.
 */
export function buildClusterPayload(order: NormalizedOrder): Record<string, unknown> {
  const missingUidItems = order.items.filter((item) => item.clusterItemUid == null);
  if (missingUidItems.length > 0) {
    throw new ClusterPosError(
      `Cannot send order to Cluster POS: missing clusterItemUid for item(s): ${missingUidItems
        .map((item) => item.name)
        .join(", ")}. Build the menu -> Cluster Item_uid mapping first (see get-inventory).`
    );
  }

  const cart: Record<string, unknown> = {
    Note: orderSourceNote(order),
    OverridePrices: true,
    Nodes: order.items.map((item) => ({
      Database: {
        Model: {
          Item_uid: item.clusterItemUid,
          Name: item.name,
          Price: item.unitPrice,
          Qty: item.quantity,
          // Cluster n'a pas de Item_uid séparé pour la version "croustillante"
          // d'une crêpe (même catalogue que la version classique) — on ajoute
          // cette note pour que la cuisine sache quelle préparation faire.
          // Confirmé via calculate-order que le champ est accepté et conservé;
          // pas encore confirmé visuellement sur un ticket cuisine imprimé.
          Note: [
            /croustillante/i.test(item.name) ? "CROUSTILLANTE" : "",
            item.notes ?? "",
          ].filter(Boolean).join(" - "),
        },
      },
    })),
  };

  // Commande déjà payée en ligne: on informe Cluster du paiement pour que la
  // facture ne soit pas ouverte "à payer" au terminal. Si le client paie sur
  // place (pay_at_pos), on n'envoie aucun Payments et le terminal encaissera.
  if (order.paymentStatus === "paid_externally") {
    cart.Payments = [
      {
        Model: {
          ID: 0,
          Order_ID: 0,
          Method: "ONLINE_ORDERING",
          Payment: order.total,
          Tip: order.tip ?? 0,
          Balance: 0,
          Message: orderSourceNote(order),
        },
      },
    ];
  }

  const data: Record<string, unknown> = {
    Time: order.requestedFor ?? order.createdAt,
    Client: {
      Model: {
        Fullname: order.customer.name,
        Phone_Number: order.customer.phone ?? "",
      },
    },
    Cart: cart,
  };

  if (order.customer.address || order.customer.city || order.customer.postalCode) {
    data.Address = {
      Model: {
        ...(order.customer.address ? { Address: order.customer.address } : {}),
        ...(order.customer.city ? { City: order.customer.city } : {}),
        ...(order.customer.postalCode ? { Zip: order.customer.postalCode } : {}),
      },
    };
  }

  return {
    table_id: toTableId(order),
    data,
  };
}

const REQUEST_TIMEOUT_MS = 10_000;

// Recommandé explicitement par l'équipe Cluster POS pour tout 429 sur les
// endpoints de commande, en l'absence d'un header Retry-After exploitable.
const DEFAULT_RATE_LIMIT_RETRY_MS = 60_000;

function parseRetryAfterMs(header: string | null): number {
  if (!header) return DEFAULT_RATE_LIMIT_RETRY_MS;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  return DEFAULT_RATE_LIMIT_RETRY_MS;
}

/**
 * Seul point d'appel HTTP réel vers l'API Cluster POS.
 *
 * Auth confirmée par la collection Postman officielle (script prerequest):
 * trois headers distincts — x-serial, x-apikey, et Authorization: Bearer
 * {token} — pas juste un Bearer token unique comme précédemment supposé.
 *
 * Endpoint "send-order", partie des endpoints de commande (calculate-price,
 * calculate-order, send-order, cancel-order, add-payment, pinpad-payment,
 * get-invoice), limités à 6000 req/min.
 */
export async function sendOrderToCluster(
  order: NormalizedOrder
): Promise<ClusterOrderResult> {
  const payload = buildClusterPayload(order);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let response: Response;
  try {
    response = await fetch(`${env.CLUSTER_API_BASE_URL}/send-order`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "x-serial": env.CLUSTER_SERIAL,
        "x-apikey": env.CLUSTER_API_KEY,
        Authorization: `Bearer ${env.CLUSTER_TOKEN}`,
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new ClusterPosError(
        `Cluster POS request timed out after ${REQUEST_TIMEOUT_MS}ms`
      );
    }
    throw new ClusterPosError(
      `Cluster POS request failed: ${err instanceof Error ? err.message : String(err)}`
    );
  } finally {
    clearTimeout(timeout);
  }

  const rawResponse = await response.text();

  if (response.status === 429) {
    const retryAfterMs = parseRetryAfterMs(response.headers.get("retry-after"));
    throw new ClusterPosError(
      "Cluster POS rate limit exceeded (429)",
      429,
      rawResponse,
      retryAfterMs
    );
  }

  if (!response.ok) {
    throw new ClusterPosError(
      `Cluster POS returned ${response.status}`,
      response.status,
      rawResponse
    );
  }

  let clusterOrderRef: string | undefined;
  try {
    // Réponse réelle de send-order: { "Invoice": <id>, "Status": 200, "Message": "" }
    const parsed = JSON.parse(rawResponse) as { Invoice?: number | string; Status?: number; Message?: string };
    if (typeof parsed.Status === "number" && parsed.Status !== 200) {
      throw new ClusterPosError(
        `Cluster POS returned Status ${parsed.Status}: ${parsed.Message ?? "unknown error"}`,
        response.status,
        rawResponse
      );
    }
    clusterOrderRef = parsed.Invoice !== undefined ? String(parsed.Invoice) : undefined;
  } catch (err) {
    if (err instanceof ClusterPosError) throw err;
    // Réponse non-JSON: on garde rawResponse tel quel pour debug.
  }

  return {
    statusCode: response.status,
    clusterOrderRef,
    rawResponse,
  };
}
