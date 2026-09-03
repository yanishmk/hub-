import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "../lib/env.js";
import { prisma } from "../lib/prisma.js";
import { parseWebsiteOrder } from "../ingestion/website.js";
import { websiteToNormalizedOrder } from "../normalization/toNormalizedOrder.js";
import { enqueueOrder, retryOrder } from "../queue/orderQueue.js";

const orderStatusValues = [
  "received",
  "sent_to_pos",
  "confirmed",
  "preparing",
  "ready",
  "error",
  "cancelled",
] as const;

function safeHeaderEquals(header: string | string[] | undefined, expected: string): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  if (!value || !expected) return false;
  const left = Buffer.from(value);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireAdminKey(request: FastifyRequest, reply: FastifyReply): boolean {
  if (!env.ADMIN_API_KEY) return true;
  if (!safeHeaderEquals(request.headers["x-api-key"], env.ADMIN_API_KEY)) {
    reply.code(401).send({ error: "Unauthorized" });
    return false;
  }
  return true;
}

export async function registerOrderRoutes(app: FastifyInstance) {
  app.post("/orders/website", async (request, reply) => {
    if (!safeHeaderEquals(request.headers["x-api-key"], env.WEBSITE_API_KEY)) {
      return reply.code(401).send({ error: "Unauthorized" });
    }

    const parseResult = parseWebsiteOrder(request.body);
    const normalized = websiteToNormalizedOrder(parseResult);
    const result = await enqueueOrder(normalized);

    return reply.code(202).send({
      orderId: result.orderId,
      duplicate: result.duplicate,
      status: "received",
    });
  });

  const listQuerySchema = z.object({
    status: z.enum(orderStatusValues).optional(),
    limit: z.coerce.number().int().positive().max(200).optional().default(50),
  });

  app.get("/orders", async (request, reply) => {
    if (!requireAdminKey(request, reply)) return;

    const { status, limit } = listQuerySchema.parse(request.query);
    const orders = await prisma.order.findMany({
      where: status ? { status } : undefined,
      orderBy: { createdAt: "desc" },
      take: limit,
    });
    return reply.send({ orders });
  });

  app.get("/orders/errors", async (request, reply) => {
    if (!requireAdminKey(request, reply)) return;

    const orders = await prisma.order.findMany({
      where: { status: "error" },
      orderBy: { updatedAt: "desc" },
    });
    return reply.send({ orders });
  });

  const retryParamsSchema = z.object({ id: z.string().min(1) });

  app.post("/orders/:id/retry", async (request, reply) => {
    if (!requireAdminKey(request, reply)) return;

    const { id } = retryParamsSchema.parse(request.params);
    const order = await prisma.order.findUnique({ where: { id } });

    if (!order) {
      return reply.code(404).send({ error: "Order not found" });
    }
    if (order.status !== "error") {
      return reply
        .code(409)
        .send({ error: `Order is not in error state (current: ${order.status})` });
    }

    await retryOrder(id);
    return reply.code(202).send({ orderId: id, status: "received" });
  });

  app.get("/orders/:id", async (request, reply) => {
    if (!requireAdminKey(request, reply)) return;

    const { id } = retryParamsSchema.parse(request.params);
    const order = await prisma.order.findUnique({
      where: { id },
      include: { events: { orderBy: { createdAt: "asc" } }, clusterAttempts: true },
    });
    if (!order) {
      return reply.code(404).send({ error: "Order not found" });
    }
    return reply.send({ order });
  });
}
