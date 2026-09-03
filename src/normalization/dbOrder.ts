import type { Order as DbOrder } from "@prisma/client";
import type {
  NormalizedOrder,
  NormalizedOrderItem,
  OrderSource,
  OrderStatus,
  PaymentStatus,
} from "../types/normalizedOrder.js";

/**
 * Reconstruit un NormalizedOrder à partir de la ligne persistée en base.
 * Utilisé par le worker pour ne pas avoir à re-parser rawSourcePayload à
 * chaque tentative d'envoi vers Cluster POS.
 */
export function dbOrderToNormalizedOrder(dbOrder: DbOrder): NormalizedOrder {
  const rawSourcePayload = dbOrder.rawSourcePayload as object;
  const deliveryAddress = dbOrder.source === "ubereats"
    ? uberDeliveryAddress(rawSourcePayload)
    : {};

  return {
    id: dbOrder.id,
    externalId: dbOrder.externalId,
    source: dbOrder.source as OrderSource,
    status: dbOrder.status as OrderStatus,
    orderType: dbOrder.orderType as NormalizedOrder["orderType"],
    createdAt: dbOrder.createdAt.toISOString(),
    requestedFor: dbOrder.requestedFor ? dbOrder.requestedFor.toISOString() : null,
    customer: {
      name: dbOrder.customerName,
      phone: dbOrder.customerPhone ?? undefined,
      ...deliveryAddress,
    },
    items: dbOrder.items as unknown as NormalizedOrderItem[],
    subtotal: Number(dbOrder.subtotal),
    tax: Number(dbOrder.tax),
    deliveryFee: dbOrder.deliveryFee ? Number(dbOrder.deliveryFee) : undefined,
    tip: dbOrder.tip ? Number(dbOrder.tip) : undefined,
    total: Number(dbOrder.total),
    paymentStatus: dbOrder.paymentStatus as PaymentStatus,
    rawSourcePayload,
  };
}

function uberDeliveryAddress(rawPayload: object) {
  const payload = rawPayload as Record<string, unknown>;
  const delivery = record(payload.delivery);
  const dropoff = record(delivery.dropoff ?? payload.dropoff);
  const addressRecord = record(dropoff.address ?? delivery.address ?? payload.delivery_address);
  const address = stringValue(
    addressRecord.address_1
      ?? addressRecord.street_address
      ?? addressRecord.line1
      ?? addressRecord.address
      ?? dropoff.address
  );
  const city = stringValue(addressRecord.city ?? dropoff.city ?? delivery.city);
  const postalCode = stringValue(
    addressRecord.postal_code
      ?? addressRecord.zip_code
      ?? addressRecord.zip
      ?? dropoff.postal_code
      ?? delivery.postal_code
  );
  return {
    ...(address ? { address } : {}),
    ...(city ? { city } : {}),
    ...(postalCode ? { postalCode } : {}),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
