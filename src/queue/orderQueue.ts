import { Queue } from "bullmq";
import { Prisma } from "@prisma/client";
import { redisConnection } from "./connection.js";
import { prisma } from "../lib/prisma.js";
import { env } from "../lib/env.js";
import type { NormalizedOrder } from "../types/normalizedOrder.js";

export const ORDER_QUEUE_NAME = "cluster-pos-orders";

export interface SendToClusterJobData {
  orderId: string;
}

export const orderQueue = new Queue<SendToClusterJobData>(ORDER_QUEUE_NAME, {
  connection: redisConnection,
});

const UNIQUE_CONSTRAINT_VIOLATION = "P2002";

// BullMQ interdit ":" dans un jobId personnalisé (c'est son propre séparateur
// interne de clé Redis) — on utilise "__" comme délimiteur applicatif.
function jobIdFor(source: string, externalId: string): string {
  return `${source}__${externalId}`;
}

function queueSendToClusterJob(orderId: string, jobId: string) {
  return orderQueue.add(
    "send-to-cluster",
    { orderId },
    {
      jobId,
      attempts: env.CLUSTER_MAX_RETRIES,
      // Stratégie custom enregistrée sur le Worker (voir worker.ts) — respecte
      // le délai de 60s recommandé par Cluster POS sur un 429, backoff
      // exponentiel classique pour les autres erreurs.
      backoff: { type: "cluster-aware" },
      removeOnComplete: 1000,
      removeOnFail: false,
    }
  );
}

export interface EnqueueResult {
  orderId: string;
  duplicate: boolean;
}

/**
 * Persiste la commande normalisée et l'ajoute à la file d'attente d'envoi
 * vers Cluster POS.
 *
 * Idempotence: la contrainte unique (source, externalId) en base est la
 * source de vérité — si un webhook est reçu 2-3 fois, la 2e/3e tentative de
 * création échoue avec P2002 et on renvoie simplement la commande existante
 * sans créer de nouveau job. Le jobId BullMQ dérivé des mêmes champs offre
 * une seconde barrière côté file d'attente.
 */
export async function enqueueOrder(
  order: NormalizedOrder
): Promise<EnqueueResult> {
  try {
    const created = await prisma.order.create({
      data: {
        id: order.id,
        externalId: order.externalId,
        source: order.source,
        status: "received",
        orderType: order.orderType,
        requestedFor: order.requestedFor ? new Date(order.requestedFor) : null,
        customerName: order.customer.name,
        customerPhone: order.customer.phone,
        subtotal: order.subtotal,
        tax: order.tax,
        deliveryFee: order.deliveryFee,
        tip: order.tip,
        total: order.total,
        paymentStatus: order.paymentStatus,
        items: order.items as unknown as Prisma.InputJsonValue,
        rawSourcePayload: order.rawSourcePayload as unknown as Prisma.InputJsonValue,
        events: {
          create: {
            type: "received",
            message: "Order received and normalized",
          },
        },
      },
    });

    await queueSendToClusterJob(created.id, jobIdFor(order.source, order.externalId));

    return { orderId: created.id, duplicate: false };
  } catch (err) {
    if (
      err instanceof Prisma.PrismaClientKnownRequestError &&
      err.code === UNIQUE_CONSTRAINT_VIOLATION
    ) {
      const existing = await prisma.order.findUniqueOrThrow({
        where: {
          source_externalId: { source: order.source, externalId: order.externalId },
        },
      });
      // La commande existe déjà en base, mais si une tentative précédente a
      // échoué juste après l'insertion (ex. la mise en file), aucun job n'a
      // peut-être jamais été créé. BullMQ dédoublonne par jobId (un job déjà
      // présent, quel que soit son état, n'est pas recréé) donc ce re-appel
      // est sans danger et auto-corrige une commande orpheline en "received".
      if (existing.status === "received") {
        await queueSendToClusterJob(
          existing.id,
          jobIdFor(existing.source, existing.externalId)
        );
      }
      return { orderId: existing.id, duplicate: true };
    }
    throw err;
  }
}

/**
 * Remet manuellement en file une commande en état "error" (retry manuel).
 */
export async function retryOrder(orderId: string): Promise<void> {
  const order = await prisma.order.findUniqueOrThrow({ where: { id: orderId } });

  await prisma.order.update({
    where: { id: orderId },
    data: { status: "received", lastError: null },
  });

  await prisma.orderEvent.create({
    data: { orderId, type: "manual_retry", message: "Manual retry triggered" },
  });

  // jobId inclut un suffixe pour permettre un nouveau job même si l'original
  // est toujours marqué "failed" dans BullMQ (removeOnFail: false).
  await queueSendToClusterJob(
    orderId,
    `${jobIdFor(order.source, order.externalId)}__retry__${Date.now()}`
  );
}
