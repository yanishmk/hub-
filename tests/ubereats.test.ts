import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

process.env.UBEREATS_ENABLED = "true";
process.env.UBEREATS_CLIENT_SECRET = "uber-client-secret";
process.env.UBEREATS_WEBHOOK_SIGNING_SECRET = "uber-webhook-secret";
process.env.UBEREATS_CLIENT_ID = "uber-client-id";
process.env.UBEREATS_AUTH_URL = "https://auth.test/token";
process.env.UBEREATS_API_BASE_URL = "https://api.test";
process.env.UBEREATS_AUTO_ACCEPT = "false";
process.env.UBEREATS_MANUAL_ACCEPT_POLL_ENABLED = "true";
process.env.UBEREATS_MANUAL_ACCEPT_POLL_ATTEMPTS = "3";
process.env.UBEREATS_MANUAL_ACCEPT_POLL_DELAY_MS = "10";

const enqueueOrder = vi.fn(async () => ({ orderId: "order-db-1", duplicate: false }));

vi.mock("../src/queue/orderQueue.js", () => ({ enqueueOrder }));

vi.mock("bullmq", () => {
  class FakeQueue {
    add = vi.fn().mockResolvedValue(undefined);
  }
  class FakeWorker {
    on = vi.fn();
  }
  return { Queue: FakeQueue, Worker: FakeWorker };
});

vi.mock("ioredis", () => {
  class FakeRedis {}
  return { Redis: FakeRedis };
});

const { buildApp } = await import("../src/app.js");
const {
  fetchUberEatsOrder,
  isUberEatsOrderAccepted,
  verifyUberEatsSignature,
} = await import("../src/ingestion/ubereats.js");
const { ubereatsToNormalizedOrder } = await import("../src/normalization/toNormalizedOrder.js");

const uberOrderPayload = {
  id: "uber-order-123",
  display_id: "A12",
  status: "ACCEPTED",
  type: "DELIVERY_BY_UBER",
  created_at: "2026-09-03T12:00:00Z",
  eater: { first_name: "Alice", last_name: "Tremblay", phone: "514-555-0100" },
  cart: {
    items: [
      {
        title: "Crêpe classique Nutella",
        quantity: 2,
        price: { unit_price: { amount: 950 } },
        selected_modifier_groups: [
          { selected_items: [{ title: "Extra fromage", price: { amount: 150 } }] },
        ],
      },
    ],
  },
  payment: {
    charges: {
      subtotal: { amount: 2200 },
      tax: { amount: 330 },
      delivery_fee: { amount: 399 },
      tip: { amount: 200 },
      total: { amount: 2929 },
    },
  },
};

describe("Uber Eats ingestion", () => {
  afterEach(() => {
    enqueueOrder.mockClear();
    vi.unstubAllGlobals();
  });

  it("verifies the X-Uber-Signature HMAC over the raw body", () => {
    const rawBody = JSON.stringify({ event_type: "orders.notification" });
    const signature = createHmac("sha256", "uber-webhook-secret")
      .update(rawBody)
      .digest("hex");

    expect(verifyUberEatsSignature(rawBody, signature)).toBe(true);
    expect(verifyUberEatsSignature(rawBody, "0".repeat(64))).toBe(false);
  });

  it("detects whether an Uber order is accepted before sending it to POS", () => {
    expect(isUberEatsOrderAccepted({ status: "ACCEPTED" })).toBe(true);
    expect(isUberEatsOrderAccepted({ state: "PREPARING" })).toBe(true);
    expect(isUberEatsOrderAccepted({ status: "CREATED" })).toBe(false);
    expect(isUberEatsOrderAccepted({ status: "PENDING" })).toBe(false);
    expect(isUberEatsOrderAccepted({}, "orders.release")).toBe(true);
  });

  it("normalizes Uber order details into the internal POS order format", () => {
    const normalized = ubereatsToNormalizedOrder(uberOrderPayload);

    expect(normalized).toMatchObject({
      externalId: "uber-order-123",
      source: "ubereats",
      orderType: "delivery",
      customer: { name: "Alice Tremblay", phone: "514-555-0100" },
      subtotal: 22,
      tax: 3.3,
      deliveryFee: 3.99,
      tip: 2,
      total: 29.29,
      paymentStatus: "paid_externally",
    });
    expect(normalized.items[0]).toMatchObject({
      name: "Crêpe classique Nutella",
      quantity: 2,
      unitPrice: 9.5,
      clusterItemUid: 6,
      modifiers: [{ name: "Extra fromage", price: 1.5 }],
    });
  });

  it("fetches an order from resource_href with an Uber OAuth token", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: "token-1", expires_in: 3600 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(uberOrderPayload), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const order = await fetchUberEatsOrder({
      event_type: "orders.notification",
      resource_href: "https://api.test/v2/eats/order/uber-order-123",
      meta: { resource_id: "uber-order-123" },
    });

    expect(order).toEqual(uberOrderPayload);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.test/v2/eats/order/uber-order-123",
      expect.objectContaining({ method: "GET" })
    );
  });

  it("accepts a signed webhook carrying full order details and enqueues it", async () => {
    const app = buildApp();
    const rawBody = JSON.stringify(uberOrderPayload);
    const signature = createHmac("sha256", "uber-webhook-secret")
      .update(rawBody)
      .digest("hex");

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/ubereats",
      headers: {
        "content-type": "application/json",
        "x-uber-signature": signature,
      },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ orderId: "order-db-1", duplicate: false });
    expect(enqueueOrder).toHaveBeenCalledWith(expect.objectContaining({
      externalId: "uber-order-123",
      source: "ubereats",
    }));
    await app.close();
  });

  it("watches an Uber order until it is accepted manually", async () => {
    const app = buildApp();
    const rawBody = JSON.stringify({
      ...uberOrderPayload,
      id: "uber-order-pending",
      status: "PENDING",
    });
    const signature = createHmac("sha256", "uber-webhook-secret")
      .update(rawBody)
      .digest("hex");

    const res = await app.inject({
      method: "POST",
      url: "/webhooks/ubereats",
      headers: {
        "content-type": "application/json",
        "x-uber-signature": signature,
      },
      payload: rawBody,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      status: "watching",
      reason: "waiting_for_manual_acceptance",
      orderId: "uber-order-pending",
      watchJobId: "ubereats_manual_acceptance__uber-order-pending",
    });
    expect(enqueueOrder).not.toHaveBeenCalled();
    await app.close();
  });
});
