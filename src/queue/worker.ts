import { Worker, type Job } from "bullmq";
import { redisConnection } from "./connection.js";
import { ORDER_QUEUE_NAME, type SendToClusterJobData } from "./orderQueue.js";
import { prisma } from "../lib/prisma.js";
import { sendOrderToCluster, ClusterPosError } from "../connectors/clusterPos.js";
import { dbOrderToNormalizedOrder } from "../normalization/dbOrder.js";

const BASE_BACKOFF_MS = 2000;
const MAX_EXPONENTIAL_BACKOFF_MS = 30_000;

/**
 * Stratégie de backoff custom: un 429 Cluster POS respecte le délai
 * recommandé par leur équipe (Retry-After, ou 60s par défaut) plutôt que le
 * backoff exponentiel habituel utilisé pour les autres erreurs (timeout,
 * 5xx, réseau).
 */
export function clusterAwareBackoff(attemptsMade: number, _type?: string, err?: Error): number {
  if (err instanceof ClusterPosError && err.statusCode === 429) {
    return err.retryAfterMs ?? 60_000;
  }
  return Math.min(BASE_BACKOFF_MS * 2 ** (attemptsMade - 1), MAX_EXPONENTIAL_BACKOFF_MS);
}

export async function processSendToCluster(job: Job<SendToClusterJobData>) {
  const dbOrder = await prisma.order.findUniqueOrThrow({
    where: { id: job.data.orderId },
  });

  if (dbOrder.status === "cancelled") {
    return { skipped: true, reason: "order cancelled" };
  }

  const normalized = dbOrderToNormalizedOrder(dbOrder);
  const attemptNumber = job.attemptsMade + 1;
  const maxAttempts = job.opts.attempts ?? 1;

  try {
    const result = await sendOrderToCluster(normalized);

    await prisma.$transaction([
      prisma.clusterDeliveryAttempt.create({
        data: {
          orderId: dbOrder.id,
          attemptNumber,
          success: true,
          statusCode: result.statusCode,
          responseBody: result.rawResponse,
        },
      }),
      prisma.order.update({
        where: { id: dbOrder.id },
        data: {
          status: "sent_to_pos",
          clusterOrderRef: result.clusterOrderRef,
          lastError: null,
        },
      }),
      prisma.orderEvent.create({
        data: {
          orderId: dbOrder.id,
          type: "sent_to_pos",
          message: `Order sent to Cluster POS (attempt ${attemptNumber})`,
        },
      }),
    ]);

    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const statusCode = err instanceof ClusterPosError ? err.statusCode : undefined;
    const rawResponse = err instanceof ClusterPosError ? err.rawResponse : undefined;

    await prisma.clusterDeliveryAttempt.create({
      data: {
        orderId: dbOrder.id,
        attemptNumber,
        success: false,
        statusCode,
        responseBody: rawResponse,
        errorMessage: message,
      },
    });

    const isFinalAttempt = attemptNumber >= maxAttempts;
    if (isFinalAttempt) {
      await prisma.order.update({
        where: { id: dbOrder.id },
        data: { status: "error", lastError: message },
      });
      await prisma.orderEvent.create({
        data: {
          orderId: dbOrder.id,
          type: "error",
          message: `Failed after ${attemptNumber} attempt(s): ${message}`,
        },
      });
    }

    // Relancer l'erreur pour que BullMQ applique le backoff exponentiel et
    // retente automatiquement (jusqu'à CLUSTER_MAX_RETRIES tentatives).
    throw err;
  }
}

export const orderWorker = new Worker<SendToClusterJobData>(
  ORDER_QUEUE_NAME,
  processSendToCluster,
  {
    connection: redisConnection,
    settings: { backoffStrategy: clusterAwareBackoff },
  }
);

orderWorker.on("failed", (job, err) => {
  console.error(`[worker] job ${job?.id} failed: ${err.message}`);
});

orderWorker.on("completed", (job) => {
  console.log(`[worker] job ${job.id} completed`);
});
