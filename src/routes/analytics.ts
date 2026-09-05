import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { env } from "../lib/env.js";
import { prisma } from "../lib/prisma.js";

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

const querySchema = z.object({
  days: z.coerce.number().int().positive().max(365).optional().default(30),
});

export async function registerAnalyticsRoutes(app: FastifyInstance) {
  app.get("/analytics", async (request, reply) => {
    if (!requireAdminKey(request, reply)) return;

    try {
      const { days } = querySchema.parse(request.query);
      const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
      const orders = await prisma.order.findMany({
        where: { createdAt: { gte: since } },
        orderBy: { createdAt: "desc" },
        take: 2000,
      });

      const sentOrders = orders.filter((order) => order.status !== "cancelled");
      const revenueOrders = sentOrders.filter((order) => order.status !== "error");
      const revenue = round2(revenueOrders.reduce((sum, order) => sum + money(order.total), 0));
      const orderCount = revenueOrders.length;
      const averageOrder = orderCount ? round2(revenue / orderCount) : 0;
      const errors = orders.filter((order) => order.status === "error").length;

      const sourceTotals = new Map<string, { source: string; orders: number; revenue: number }>();
      const productTotals = new Map<string, { name: string; quantity: number; revenue: number }>();
      const dailyTotals = new Map<string, { date: string; orders: number; revenue: number }>();

      for (const order of revenueOrders) {
        const total = money(order.total);
        const source = String(order.source);
        const sourceRow = sourceTotals.get(source) ?? { source, orders: 0, revenue: 0 };
        sourceRow.orders += 1;
        sourceRow.revenue = round2(sourceRow.revenue + total);
        sourceTotals.set(source, sourceRow);

        const day = dateIso(order.createdAt).slice(0, 10);
        const dayRow = dailyTotals.get(day) ?? { date: day, orders: 0, revenue: 0 };
        dayRow.orders += 1;
        dayRow.revenue = round2(dayRow.revenue + total);
        dailyTotals.set(day, dayRow);

        for (const item of orderItems(order.items)) {
          const row = productTotals.get(item.name) ?? { name: item.name, quantity: 0, revenue: 0 };
          row.quantity += item.quantity;
          row.revenue = round2(row.revenue + item.quantity * item.unitPrice);
          productTotals.set(item.name, row);
        }
      }

      return reply.send({
        period: { days, since: since.toISOString() },
        totals: {
          revenue,
          orders: orderCount,
          averageOrder,
          errors,
          pending: orders.filter((order) => order.status === "received").length,
          sentToPos: orders.filter((order) => order.status === "sent_to_pos").length,
        },
        sources: [...sourceTotals.values()].sort((a, b) => b.revenue - a.revenue),
        bestSellers: [...productTotals.values()]
          .sort((a, b) => b.quantity - a.quantity || b.revenue - a.revenue)
          .slice(0, 10),
        daily: [...dailyTotals.values()].sort((a, b) => a.date.localeCompare(b.date)),
        recentOrders: orders.slice(0, 10).map((order) => ({
          id: order.id,
          source: String(order.source),
          status: String(order.status),
          total: money(order.total),
          customerName: order.customerName,
          createdAt: dateIso(order.createdAt),
        })),
      });
    } catch (err) {
      request.log.error({ err }, "Analytics failed");
      return reply.code(500).send({
        error: "Analytics failed",
        details: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

function orderItems(value: unknown): { name: string; quantity: number; unitPrice: number }[] {
  const items = parseItems(value);
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    const name = typeof row.name === "string" ? row.name : "";
    const quantity = money(row.quantity);
    const unitPrice = money(row.unitPrice);
    if (!name || !Number.isFinite(quantity) || !Number.isFinite(unitPrice)) return [];
    return [{ name, quantity, unitPrice }];
  });
}

function parseItems(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function money(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function dateIso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
