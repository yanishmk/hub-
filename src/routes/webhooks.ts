import type { FastifyInstance } from "fastify";
import { createHash } from "node:crypto";
import { env } from "../lib/env.js";
import { prisma } from "../lib/prisma.js";
import {
  acceptUberEatsOrder,
  fetchUberEatsOrder,
  getUberEatsOrderId,
  isUberEatsOrderAccepted,
  isUberEatsEnabled,
  verifyUberEatsSignature,
} from "../ingestion/ubereats.js";
import { isDoorDashEnabled } from "../ingestion/doordash.js";
import { isSkipEnabled } from "../ingestion/skip.js";
import { ubereatsToNormalizedOrder } from "../normalization/toNormalizedOrder.js";
import { enqueueOrder } from "../queue/orderQueue.js";
import { scheduleUberAcceptanceCheck } from "../queue/uberAcceptanceQueue.js";

export async function registerWebhookRoutes(app: FastifyInstance) {
  app.post("/webhooks/ubereats", async (request, reply) => {
    if (!isUberEatsEnabled()) {
      app.log.info("Uber Eats webhook received but UBEREATS_ENABLED=false - ignoring");
      return reply.code(200).send({ status: "ignored", reason: "ubereats integration not enabled" });
    }

    const rawBody = (request as typeof request & { rawBody?: string }).rawBody ?? JSON.stringify(request.body ?? {});
    const body = request.body;
    const eventType = body && typeof body === "object"
      ? String((body as Record<string, unknown>).event_type ?? "")
      : "";
    const webhookOrderId = getUberEatsOrderId(body);
    const hasSignature = Boolean(request.headers["x-uber-signature"]);
    const hasSecondarySignature = Boolean(request.headers["x-uber-signature-new"]);
    let deliveryLogId = await createUberWebhookDeliveryLog(app, {
      eventType,
      externalOrderId: webhookOrderId,
      status: "received",
      hasSignature,
      hasSecondarySignature,
      rawBodyHash: createHash("sha256").update(rawBody).digest("hex"),
    });
    app.log.info(
      {
        eventType,
        orderId: webhookOrderId,
        hasSignature,
        hasNewSignature: hasSecondarySignature,
      },
      "Uber Eats webhook request received"
    );
    const signatureValid = verifyUberEatsSignature(rawBody, [
      request.headers["x-uber-signature"],
      request.headers["x-uber-signature-new"],
    ].flat().filter((header): header is string => Boolean(header)));
    if (!signatureValid) {
      app.log.warn({ eventType, orderId: webhookOrderId }, "Uber Eats webhook rejected: invalid signature");
      await updateUberWebhookDeliveryLog(app, deliveryLogId, {
        status: "invalid_signature",
        reason: "invalid_signature",
        httpStatus: 401,
        signatureValid: false,
      });
      return reply.code(401).send({ error: "Invalid Uber Eats signature" });
    }

    await updateUberWebhookDeliveryLog(app, deliveryLogId, {
      status: "signature_valid",
      signatureValid: true,
    });

    app.log.info({ eventType, orderId: webhookOrderId }, "Uber Eats webhook received");
    if (eventType && !["orders.notification", "orders.scheduled.notification", "orders.release"].includes(eventType)) {
      app.log.info({ eventType, orderId: webhookOrderId }, "Uber Eats webhook event ignored");
      await updateUberWebhookDeliveryLog(app, deliveryLogId, {
        status: "ignored",
        reason: `ignored_event:${eventType}`,
        httpStatus: 200,
      });
      return reply.code(200).send({ status: "ignored", eventType });
    }

    try {
      const orderPayload = body && typeof body === "object" && "cart" in body
        ? body
        : await fetchUberEatsOrder(body);

      const fetchedOrderId = getUberEatsOrderId(orderPayload) ?? webhookOrderId;
      if (fetchedOrderId && fetchedOrderId !== webhookOrderId) {
        await updateUberWebhookDeliveryLog(app, deliveryLogId, {
          externalOrderId: fetchedOrderId,
        });
      }

      let accepted = isUberEatsOrderAccepted(orderPayload, eventType);
      app.log.info(
        { eventType, orderId: fetchedOrderId, accepted },
        "Uber Eats order fetched"
      );
      if (!accepted && env.UBEREATS_AUTO_ACCEPT) {
        const orderId = getUberEatsOrderId(orderPayload);
        if (!orderId) {
          throw new Error("Uber Eats order cannot be auto-accepted: missing order id");
        }
        await acceptUberEatsOrder(orderId);
        accepted = true;
        app.log.info({ eventType, orderId }, "Uber Eats order auto-accepted");
      }

      if (!accepted) {
        const orderId = getUberEatsOrderId(orderPayload);
        const watchJobId = await scheduleUberAcceptanceCheck(orderPayload);
        app.log.info({ eventType, orderId, watchJobId }, "Uber Eats order waiting for manual acceptance");
        await updateUberWebhookDeliveryLog(app, deliveryLogId, {
          status: watchJobId ? "waiting_manual_acceptance" : "ignored",
          reason: watchJobId ? "waiting_for_manual_acceptance" : "order_not_accepted",
          httpStatus: 200,
        });
        return reply.code(200).send({
          status: watchJobId ? "watching" : "ignored",
          reason: watchJobId ? "waiting_for_manual_acceptance" : "order_not_accepted",
          orderId,
          watchJobId,
        });
      }

      const normalized = ubereatsToNormalizedOrder(orderPayload);
      const result = await enqueueOrder(normalized);
      app.log.info(
        { eventType, orderId: result.orderId, externalId: normalized.externalId, duplicate: result.duplicate },
        "Uber Eats order queued for Cluster POS"
      );
      await updateUberWebhookDeliveryLog(app, deliveryLogId, {
        status: "queued",
        reason: result.duplicate ? "duplicate_order" : "queued_for_pos",
        httpStatus: 200,
        externalOrderId: normalized.externalId,
      });

      return reply.code(200).send({
        orderId: result.orderId,
        duplicate: result.duplicate,
        status: "received",
      });
    } catch (err) {
      await updateUberWebhookDeliveryLog(app, deliveryLogId, {
        status: "error",
        reason: "processing_error",
        httpStatus: 500,
        errorMessage: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  });

  app.post("/webhooks/doordash", async (request, reply) => {
    if (!isDoorDashEnabled()) {
      app.log.info("DoorDash webhook received but DOORDASH_ENABLED=false - ignoring");
      return reply.code(200).send({ status: "ignored", reason: "doordash integration not enabled" });
    }

    return reply.code(501).send({ error: "DoorDash parsing not yet implemented" });
  });

  app.post("/webhooks/skip", async (request, reply) => {
    if (!isSkipEnabled()) {
      app.log.info("Skip webhook received but SKIP_ENABLED=false - ignoring");
      return reply.code(200).send({ status: "ignored", reason: "skip integration not enabled" });
    }

    return reply.code(501).send({ error: "Skip the Dishes parsing not yet implemented" });
  });
}

async function createUberWebhookDeliveryLog(
  app: FastifyInstance,
  data: {
    eventType: string;
    externalOrderId: string | null;
    status: string;
    hasSignature: boolean;
    hasSecondarySignature: boolean;
    rawBodyHash: string;
  }
): Promise<string | null> {
  try {
    const row = await prisma.webhookDelivery.create({
      data: {
        provider: "ubereats",
        eventType: data.eventType || null,
        externalOrderId: data.externalOrderId,
        status: data.status,
        hasSignature: data.hasSignature,
        hasSecondarySignature: data.hasSecondarySignature,
        rawBodyHash: data.rawBodyHash,
      },
    });
    return row.id;
  } catch (err) {
    app.log.warn({ err }, "Unable to create Uber webhook delivery log");
    return null;
  }
}

async function updateUberWebhookDeliveryLog(
  app: FastifyInstance,
  id: string | null,
  data: {
    eventType?: string;
    externalOrderId?: string | null;
    status?: string;
    reason?: string;
    httpStatus?: number;
    signatureValid?: boolean;
    errorMessage?: string;
  }
): Promise<void> {
  if (!id) return;
  try {
    await prisma.webhookDelivery.update({
      where: { id },
      data,
    });
  } catch (err) {
    app.log.warn({ err, webhookDeliveryId: id }, "Unable to update Uber webhook delivery log");
  }
}
