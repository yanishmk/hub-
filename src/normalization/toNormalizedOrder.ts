import { randomUUID } from "node:crypto";
import type {
  NormalizedOrder,
  NormalizedOrderItem,
  OrderType,
} from "../types/normalizedOrder.js";
import type { WebsiteOrderPayload } from "../ingestion/website.js";
import { clusterItemUidForName } from "../menu/clusterItemMapping.js";

export function websiteToNormalizedOrder(
  payload: WebsiteOrderPayload
): NormalizedOrder {
  const items: NormalizedOrderItem[] = payload.items.map((item) => ({
    name: item.name,
    quantity: item.quantity,
    unitPrice: item.unitPrice,
    modifiers: item.modifiers ?? [],
    notes: item.notes,
    clusterItemUid: item.clusterItemUid ?? clusterItemUidForName(item.name),
  }));

  return {
    id: randomUUID(),
    externalId: payload.externalId,
    source: "website",
    status: "received",
    orderType: payload.orderType,
    createdAt: new Date().toISOString(),
    requestedFor: payload.requestedFor ?? null,
    customer: {
      name: payload.customer.name,
      phone: payload.customer.phone,
    },
    items,
    subtotal: payload.subtotal,
    tax: payload.tax,
    deliveryFee: payload.deliveryFee,
    tip: payload.tip,
    total: payload.total,
    paymentStatus: payload.paymentStatus,
    rawSourcePayload: payload,
  };
}

export function ubereatsToNormalizedOrder(rawPayload: unknown): NormalizedOrder {
  const payload = asRecord(rawPayload);
  const cart = asOptionalRecord(payload.cart) ?? {};
  const payment = asOptionalRecord(payload.payment) ?? {};
  const charges = asOptionalRecord(payment.charges) ?? {};
  const eater = asOptionalRecord(payload.eater ?? payload.customer) ?? {};
  const address = uberDeliveryAddress(payload);
  const itemsPayload = arrayValue(cart.items ?? payload.items);

  if (!itemsPayload.length) {
    throw new Error("Uber Eats order has no items");
  }

  const items: NormalizedOrderItem[] = itemsPayload.map((item) => {
    const row = asRecord(item);
    const name = requiredString(row.title ?? row.name, "Uber Eats item name");
    return {
      name,
      quantity: numberValue(row.quantity, 1),
      unitPrice: moneyValue(
        valueAt(row, ["price", "unit_price", "amount"])
          ?? valueAt(row, ["price", "amount"])
          ?? row.unit_price
          ?? row.price
      ),
      modifiers: uberModifiers(row),
      notes: stringValue(row.special_instructions ?? row.notes) ?? undefined,
      clusterItemUid: optionalInteger(row.clusterItemUid ?? row.cluster_item_uid ?? row.item_uid)
        ?? clusterItemUidForName(name),
    };
  });

  const subtotal = moneyValue(
    valueAt(charges, ["subtotal", "amount"])
      ?? valueAt(payment, ["subtotal", "amount"])
      ?? payload.subtotal,
    sumItems(items)
  );
  const tax = moneyValue(
    valueAt(charges, ["tax", "amount"])
      ?? valueAt(payment, ["tax", "amount"])
      ?? payload.tax,
    0
  );
  const total = moneyValue(
    valueAt(charges, ["total", "amount"])
      ?? valueAt(payment, ["total", "amount"])
      ?? payload.total,
    subtotal + tax
  );

  return {
    id: randomUUID(),
    externalId: requiredString(payload.id ?? payload.order_id ?? payload.display_id, "Uber Eats order id"),
    source: "ubereats",
    status: "received",
    orderType: uberOrderType(payload.type ?? payload.fulfillment_type),
    createdAt: dateString(payload.created_at ?? payload.placed_at ?? payload.created_time),
    requestedFor: dateStringOrNull(payload.requested_for ?? payload.pickup_at ?? payload.scheduled_for),
    customer: {
      name: customerName(eater),
      phone: stringValue(eater.phone ?? eater.phone_number) ?? undefined,
      address: address.address,
      city: address.city,
      postalCode: address.postalCode,
    },
    items,
    subtotal,
    tax,
    deliveryFee: optionalMoney(
      valueAt(charges, ["delivery_fee", "amount"])
        ?? valueAt(payment, ["delivery_fee", "amount"])
        ?? payload.delivery_fee
    ),
    tip: optionalMoney(
      valueAt(charges, ["tip", "amount"])
        ?? valueAt(payment, ["tip", "amount"])
        ?? payload.tip
    ),
    total,
    paymentStatus: "paid_externally",
    rawSourcePayload: payload,
  };
}

export function doordashToNormalizedOrder(
  _rawPayload: unknown
): NormalizedOrder {
  throw new Error(
    "doordashToNormalizedOrder: not implemented - waiting on DoorDash API access. " +
      "Set DOORDASH_ENABLED=true only once real parsing logic is implemented here."
  );
}

export function skipToNormalizedOrder(_rawPayload: unknown): NormalizedOrder {
  throw new Error(
    "skipToNormalizedOrder: not implemented - waiting on Skip the Dishes API access. " +
      "Set SKIP_ENABLED=true only once real parsing logic is implemented here."
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Expected object payload");
  }
  return value as Record<string, unknown>;
}

function asOptionalRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function requiredString(value: unknown, field: string): string {
  const result = stringValue(value);
  if (!result) throw new Error(`${field} is required`);
  return result;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function numberValue(value: unknown, fallback: number): number {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function moneyValue(value: unknown, fallback = 0): number {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    return moneyValue(record.amount ?? record.value, fallback);
  }
  const amount = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(amount)) return fallback;
  return Math.round((Math.abs(amount) >= 100 ? amount / 100 : amount) * 100) / 100;
}

function optionalMoney(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return moneyValue(value);
}

function optionalInteger(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  const number = typeof value === "number" ? value : Number(value);
  return Number.isInteger(number) ? number : undefined;
}

function valueAt(source: Record<string, unknown>, path: string[]): unknown {
  let value: unknown = source;
  for (const key of path) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    value = (value as Record<string, unknown>)[key];
  }
  return value;
}

function uberModifiers(item: Record<string, unknown>) {
  const groups = arrayValue(item.selected_modifier_groups ?? item.modifier_groups);
  return groups.flatMap((group) => {
    const groupRecord = asOptionalRecord(group) ?? {};
    const modifiers = arrayValue(groupRecord.selected_items ?? groupRecord.items);
    return modifiers.map((modifier) => {
      const row = asRecord(modifier);
      return {
        name: requiredString(row.title ?? row.name, "Uber Eats modifier name"),
        price: moneyValue(
          valueAt(row, ["price", "unit_price", "amount"])
            ?? valueAt(row, ["price", "amount"])
            ?? row.price
        ),
      };
    });
  });
}

function sumItems(items: NormalizedOrderItem[]): number {
  return Math.round(
    items.reduce(
      (total, item) =>
        total + item.quantity * (item.unitPrice + item.modifiers.reduce((sum, modifier) => sum + modifier.price, 0)),
      0
    ) * 100
  ) / 100;
}

function uberOrderType(value: unknown): OrderType {
  const normalized = String(value ?? "").toLowerCase();
  if (normalized.includes("pick")) return "pickup";
  return "delivery";
}

function dateString(value: unknown): string {
  const parsed = dateStringOrNull(value);
  return parsed ?? new Date().toISOString();
}

function dateStringOrNull(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function customerName(eater: Record<string, unknown>): string {
  const joined = [stringValue(eater.first_name), stringValue(eater.last_name)]
    .filter(Boolean)
    .join(" ");
  return stringValue(eater.name) ?? (joined || "Uber Eats customer");
}

function uberDeliveryAddress(payload: Record<string, unknown>) {
  const delivery = asOptionalRecord(payload.delivery) ?? {};
  const dropoff = asOptionalRecord(delivery.dropoff ?? payload.dropoff) ?? {};
  const addressRecord = asOptionalRecord(dropoff.address ?? delivery.address ?? payload.delivery_address) ?? {};
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
    address: address ?? undefined,
    city: city ?? undefined,
    postalCode: postalCode ?? undefined,
  };
}
