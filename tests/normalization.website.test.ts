import { describe, expect, it } from "vitest";
import { parseWebsiteOrder } from "../src/ingestion/website.js";
import { websiteToNormalizedOrder } from "../src/normalization/toNormalizedOrder.js";

const samplePayload = {
  externalId: "web-order-123",
  orderType: "pickup" as const,
  customer: { name: "Alice Tremblay", phone: "514-555-0100" },
  items: [
    {
      name: "Poutine",
      quantity: 2,
      unitPrice: 9.5,
      modifiers: [{ name: "Extra fromage", price: 1.5 }],
      notes: "Sans oignons",
    },
    {
      name: "Coke",
      quantity: 1,
      unitPrice: 2.5,
      modifiers: [],
    },
  ],
  subtotal: 23.0,
  tax: 3.45,
  total: 26.45,
  paymentStatus: "pay_at_pos" as const,
};

describe("parseWebsiteOrder", () => {
  it("accepts a valid website payload", () => {
    const parsed = parseWebsiteOrder(samplePayload);
    expect(parsed.externalId).toBe("web-order-123");
    expect(parsed.items).toHaveLength(2);
  });

  it("rejects a payload with no items", () => {
    expect(() =>
      parseWebsiteOrder({ ...samplePayload, items: [] })
    ).toThrow();
  });

  it("rejects an invalid orderType", () => {
    expect(() =>
      parseWebsiteOrder({ ...samplePayload, orderType: "teleport" })
    ).toThrow();
  });
});

describe("websiteToNormalizedOrder", () => {
  it("maps every field to the internal schema", () => {
    const parsed = parseWebsiteOrder(samplePayload);
    const normalized = websiteToNormalizedOrder(parsed);

    expect(normalized.source).toBe("website");
    expect(normalized.status).toBe("received");
    expect(normalized.externalId).toBe("web-order-123");
    expect(normalized.orderType).toBe("pickup");
    expect(normalized.customer).toEqual({
      name: "Alice Tremblay",
      phone: "514-555-0100",
    });
    expect(normalized.items).toHaveLength(2);
    expect(normalized.items[0]).toMatchObject({
      name: "Poutine",
      quantity: 2,
      unitPrice: 9.5,
      modifiers: [{ name: "Extra fromage", price: 1.5 }],
      notes: "Sans oignons",
    });
    expect(normalized.total).toBe(26.45);
    expect(normalized.paymentStatus).toBe("pay_at_pos");
    expect(normalized.rawSourcePayload).toEqual(parsed);
    expect(typeof normalized.id).toBe("string");
    expect(normalized.id.length).toBeGreaterThan(0);
  });

  it("defaults requestedFor to null when absent", () => {
    const parsed = parseWebsiteOrder(samplePayload);
    const normalized = websiteToNormalizedOrder(parsed);
    expect(normalized.requestedFor).toBeNull();
  });
});
