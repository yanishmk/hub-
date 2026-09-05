import { Queue, Worker, type Job } from "bullmq";
import { env } from "../lib/env.js";
import {
  fetchUberEatsOrder,
  getUberEatsOrderHref,
  getUberEatsOrderId,
  isUberEatsOrderAccepted,
} from "../ingestion/ubereats.js";
import { ubereatsToNormalizedOrder } from "../normalization/toNormalizedOrder.js";
import { enqueueOrder } from "./orderQueue.js";
import { redisConnection } from "./connection.js";

export const UBER_ACCEPTANCE_QUEUE_NAME = "ubereats-manual-acceptance";

interface UberAcceptanceJobData {
  orderId?: string;
  resourceHref?: string;
}

const uberAcceptanceQueue = new Queue<UberAcceptanceJobData>(UBER_ACCEPTANCE_QUEUE_NAME, {
  connection: redisConnection,
});

export async function scheduleUberAcceptanceCheck(payload: unknown): Promise<string | null> {
  if (!env.UBEREATS_MANUAL_ACCEPT_POLL_ENABLED) return null;

  const orderId = getUberEatsOrderId(payload) ?? undefined;
  const resourceHref = getUberEatsOrderHref(payload) ?? undefined;
  if (!orderId && !resourceHref) return null;

  const jobKey = safeJobKey(orderId ?? resourceHref ?? "unknown");
  const jobId = `ubereats_manual_acceptance__${jobKey}`;
  await uberAcceptanceQueue.add(
    "check-manual-acceptance",
    { orderId, resourceHref },
    {
      jobId,
      attempts: env.UBEREATS_MANUAL_ACCEPT_POLL_ATTEMPTS,
      backoff: {
        type: "fixed",
        delay: env.UBEREATS_MANUAL_ACCEPT_POLL_DELAY_MS,
      },
      removeOnComplete: 1000,
      removeOnFail: false,
    }
  );

  return jobId;
}

async function processUberAcceptanceCheck(job: Job<UberAcceptanceJobData>) {
  const payload = await fetchUberEatsOrder({
    resource_href: job.data.resourceHref,
    meta: { resource_id: job.data.orderId },
  });

  if (!isUberEatsOrderAccepted(payload)) {
    throw new Error(`Uber Eats order ${job.data.orderId ?? job.data.resourceHref} is not accepted yet`);
  }

  const normalized = ubereatsToNormalizedOrder(payload);
  return enqueueOrder(normalized);
}

export const uberAcceptanceWorker = new Worker<UberAcceptanceJobData>(
  UBER_ACCEPTANCE_QUEUE_NAME,
  processUberAcceptanceCheck,
  { connection: redisConnection }
);

uberAcceptanceWorker.on("failed", (job, err) => {
  console.error(`[ubereats-watch] job ${job?.id} failed: ${err.message}`);
});

uberAcceptanceWorker.on("completed", (job) => {
  console.log(`[ubereats-watch] job ${job.id} completed`);
});

function safeJobKey(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 160);
}
