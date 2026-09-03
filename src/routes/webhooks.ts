import type { FastifyInstance } from "fastify";
import { env } from "../lib/env.js";
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

export async function registerWebhookRoutes(app: FastifyInstance) {
  app.post("/webhooks/ubereats", async (request, reply) => {
    if (!isUberEatsEnabled()) {
      app.log.info("Uber Eats webhook received but UBEREATS_ENABLED=false - ignoring");
      return reply.code(200).send({ status: "ignored", reason: "ubereats integration not enabled" });
    }

    const rawBody = (request as typeof request & { rawBody?: string }).rawBody ?? JSON.stringify(request.body ?? {});
    if (!verifyUberEatsSignature(rawBody, request.headers["x-uber-signature"])) {
      return reply.code(401).send({ error: "Invalid Uber Eats signature" });
    }

    const body = request.body;
    const eventType = body && typeof body === "object"
      ? String((body as Record<string, unknown>).event_type ?? "")
      : "";
    if (eventType && !["orders.notification", "orders.scheduled.notification", "orders.release"].includes(eventType)) {
      app.log.info({ eventType }, "Uber Eats webhook event ignored");
      return reply.code(200).send({ status: "ignored", eventType });
    }

    const orderPayload = body && typeof body === "object" && "cart" in body
      ? body
      : await fetchUberEatsOrder(body);

    let accepted = isUberEatsOrderAccepted(orderPayload, eventType);
    if (!accepted && env.UBEREATS_AUTO_ACCEPT) {
      const orderId = getUberEatsOrderId(orderPayload);
      if (!orderId) {
        throw new Error("Uber Eats order cannot be auto-accepted: missing order id");
      }
      await acceptUberEatsOrder(orderId);
      accepted = true;
    }

    if (!accepted) {
      const orderId = getUberEatsOrderId(orderPayload);
      app.log.info({ eventType, orderId }, "Uber Eats order ignored until it is accepted");
      return reply.code(200).send({
        status: "ignored",
        reason: "order_not_accepted",
        orderId,
      });
    }

    const normalized = ubereatsToNormalizedOrder(orderPayload);
    const result = await enqueueOrder(normalized);

    return reply.code(200).send({
      orderId: result.orderId,
      duplicate: result.duplicate,
      status: "received",
    });
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
