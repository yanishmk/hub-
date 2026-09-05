import { afterEach, describe, expect, it, vi } from "vitest";
import { ClusterPosError, sendOrderToCluster } from "../src/connectors/clusterPos.js";
import type { NormalizedOrder } from "../src/types/normalizedOrder.js";

const sampleOrder: NormalizedOrder = {
  id: "internal-1",
  externalId: "web-order-123",
  source: "website",
  status: "received",
  orderType: "pickup",
  createdAt: new Date().toISOString(),
  requestedFor: null,
  customer: { name: "Alice Tremblay", phone: "514-555-0100" },
  items: [
    {
      name: "Poutine",
      quantity: 2,
      unitPrice: 9.5,
      modifiers: [{ name: "Extra fromage", price: 1.5 }],
      clusterItemUid: 1075120545,
    },
  ],
  subtotal: 23.0,
  tax: 3.45,
  total: 26.45,
  paymentStatus: "pay_at_pos",
  rawSourcePayload: {},
};

describe("sendOrderToCluster", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns the cluster order reference on a successful call", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ Invoice: 999, Status: 200, Message: "" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await sendOrderToCluster(sampleOrder);

    expect(result.statusCode).toBe(200);
    expect(result.clusterOrderRef).toBe("999");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain("/send-order");
    expect(options.method).toBe("POST");
    expect(options.headers["x-serial"]).toBeDefined();
    expect(options.headers["x-apikey"]).toBeDefined();
    expect(options.headers.Authorization).toMatch(/^Bearer /);
    const body = JSON.parse(options.body);
    expect(body.table_id).toBe(9994); // pickup
    expect(body.data.Client.Model.Fullname).toBe("Alice Tremblay");
    expect(body.data.Cart.Note).toBe("COMMANDE CREPONE.CA");
    expect(body.data.Cart.Nodes[0].Database.Model.Item_uid).toBe(1075120545);
  });

  it("throws ClusterPosError when an item has no clusterItemUid mapping", async () => {
    const orderWithUnmappedItem: NormalizedOrder = {
      ...sampleOrder,
      items: [{ name: "Nouveau item", quantity: 1, unitPrice: 5, modifiers: [] }],
    };

    await expect(sendOrderToCluster(orderWithUnmappedItem)).rejects.toThrow(
      /missing clusterItemUid/
    );
  });

  it("includes delivery address fields when present", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ Invoice: 1000, Status: 200, Message: "" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendOrderToCluster({
      ...sampleOrder,
      orderType: "delivery",
      customer: {
        ...sampleOrder.customer,
        address: "668 Boulevard Saint-Joseph",
        city: "Gatineau",
        postalCode: "J8Y 4A8",
      },
    });

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.table_id).toBe(9993);
    expect(body.data.Address.Model).toMatchObject({
      Address: "668 Boulevard Saint-Joseph",
      City: "Gatineau",
      Zip: "J8Y 4A8",
    });
  });

  it("marks Uber Eats orders in the Cluster cart note", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ Invoice: 1001, Status: 200, Message: "" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendOrderToCluster({
      ...sampleOrder,
      externalId: "uber-order-123",
      source: "ubereats",
    });

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.data.Cart.Note).toBe("COMMANDE UBER");
  });

  it("uses a clean source message for online payments", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ Invoice: 1002, Status: 200, Message: "" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendOrderToCluster({
      ...sampleOrder,
      externalId: "stripe-order-123",
      paymentStatus: "paid_externally",
    });

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.data.Cart.Payments[0].Model.Message).toBe("COMMANDE CREPONE.CA");
  });

  it("includes item notes in the Cluster item payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ Invoice: 1003, Status: 200, Message: "" }), { status: 200 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await sendOrderToCluster({
      ...sampleOrder,
      items: [{ ...sampleOrder.items[0], notes: "TEST" }],
    });

    const [, options] = fetchMock.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.data.Cart.Nodes[0].Database.Model.Note).toBe("TEST");
  });

  it("throws ClusterPosError on a 4xx response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("bad request", { status: 400 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendOrderToCluster(sampleOrder)).rejects.toThrow(ClusterPosError);
  });

  it("throws ClusterPosError on a 5xx response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("server error", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendOrderToCluster(sampleOrder)).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it("wraps a network failure in ClusterPosError", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendOrderToCluster(sampleOrder)).rejects.toThrow(ClusterPosError);
  });

  it("carries the Retry-After delay (in ms) on a 429 response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response("rate limited", { status: 429, headers: { "Retry-After": "30" } })
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendOrderToCluster(sampleOrder)).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 30_000,
    });
  });

  it("defaults to a 60s retry delay on a 429 without a Retry-After header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("rate limited", { status: 429 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(sendOrderToCluster(sampleOrder)).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 60_000,
    });
  });
});
