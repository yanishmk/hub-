import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

process.env.ADMIN_API_KEY = "test-admin-key";

interface FakeOrderRow {
  [key: string]: unknown;
  id: string;
  status: string;
  createdAt: Date;
}

const store = new Map<string, FakeOrderRow>();

function seedOrder(overrides: Partial<FakeOrderRow> = {}): FakeOrderRow {
  const id = overrides.id ?? `order-${store.size + 1}`;
  const row: FakeOrderRow = {
    id,
    externalId: `ext-${id}`,
    source: "website",
    status: "received",
    orderType: "pickup",
    customerName: "Test Customer",
    subtotal: 10,
    tax: 1,
    total: 11,
    paymentStatus: "pay_at_pos",
    items: [],
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
  store.set(id, row);
  return row;
}

vi.mock("../src/lib/prisma.js", () => {
  return {
    prisma: {
      order: {
        findMany: vi.fn(async ({ where }: { where?: { status?: string } } = {}) => {
          const rows = [...store.values()];
          const filtered = where?.status
            ? rows.filter((r) => r.status === where.status)
            : rows;
          return filtered.sort(
            (a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime()
          );
        }),
        findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
          return store.get(where.id) ?? null;
        }),
        update: vi.fn(async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
          const row = store.get(where.id);
          if (!row) throw new Error("not found");
          Object.assign(row, data);
          return row;
        }),
      },
      orderEvent: { create: vi.fn(async () => ({})) },
      clusterDeliveryAttempt: { create: vi.fn(async () => ({})) },
    },
  };
});

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

describe("GET /orders (admin, protected by ADMIN_API_KEY)", () => {
  beforeEach(() => {
    store.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("rejects requests without the admin key", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/orders" });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it("lists orders when the admin key is provided", async () => {
    seedOrder({ id: "a", status: "received" });
    seedOrder({ id: "b", status: "error" });

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/orders",
      headers: { "x-api-key": "test-admin-key" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().orders).toHaveLength(2);
    await app.close();
  });

  it("filters by status", async () => {
    seedOrder({ id: "a", status: "received" });
    seedOrder({ id: "b", status: "error" });

    const app = buildApp();
    const res = await app.inject({
      method: "GET",
      url: "/orders?status=error",
      headers: { "x-api-key": "test-admin-key" },
    });
    expect(res.statusCode).toBe(200);
    const orders = res.json().orders as FakeOrderRow[];
    expect(orders).toHaveLength(1);
    expect(orders[0].id).toBe("b");
    await app.close();
  });

  it("serves the dashboard page without requiring the admin key", async () => {
    const app = buildApp();
    const res = await app.inject({ method: "GET", url: "/dashboard" });
    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toContain("text/html");
    await app.close();
  });
});
