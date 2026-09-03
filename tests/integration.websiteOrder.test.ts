import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// --- Fake in-memory Prisma client (no real Postgres needed for this test) ---
interface FakeOrderRow {
  [key: string]: unknown;
  id: string;
  externalId: string;
  source: string;
  status: string;
}

const store = new Map<string, FakeOrderRow>();
const orderEvents: unknown[] = [];
const clusterAttempts: unknown[] = [];

function findBySourceAndExternalId(source: string, externalId: string) {
  return [...store.values()].find(
    (o) => o.source === source && o.externalId === externalId
  );
}

vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    prisma: {
      order: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          const { events, ...rest } = data as { events?: { create: unknown } } & Record<string, unknown>;
          if (findBySourceAndExternalId(rest.source as string, rest.externalId as string)) {
            throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
              code: "P2002",
              clientVersion: "5.22.0",
            });
          }
          const now = new Date();
          const row: FakeOrderRow = {
            ...rest,
            id: rest.id as string,
            externalId: rest.externalId as string,
            source: rest.source as string,
            status: rest.status as string,
            clusterOrderRef: null,
            lastError: null,
            createdAt: now,
            updatedAt: now,
          };
          store.set(row.id, row);
          if (events?.create) {
            orderEvents.push({ orderId: row.id, createdAt: now, ...(events.create as object) });
          }
          return row;
        }),
        findUnique: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
          if (where.id) return store.get(where.id as string) ?? null;
          if (where.source_externalId) {
            const { source, externalId } = where.source_externalId as {
              source: string;
              externalId: string;
            };
            return findBySourceAndExternalId(source, externalId) ?? null;
          }
          return null;
        }),
        findUniqueOrThrow: vi.fn(async (args: { where: Record<string, unknown> }) => {
          const where = args.where;
          const found = where.id
            ? store.get(where.id as string)
            : findBySourceAndExternalId(
                (where.source_externalId as { source: string }).source,
                (where.source_externalId as { externalId: string }).externalId
              );
          if (!found) throw new Error("Order not found");
          return found;
        }),
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const row = store.get(where.id);
            if (!row) throw new Error("Order not found");
            Object.assign(row, data, { updatedAt: new Date() });
            return row;
          }
        ),
      },
      orderEvent: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          orderEvents.push({ createdAt: new Date(), ...data });
          return data;
        }),
      },
      clusterDeliveryAttempt: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          clusterAttempts.push({ createdAt: new Date(), ...data });
          return data;
        }),
      },
      $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
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

const { parseWebsiteOrder } = await import("../src/ingestion/website.js");
const { websiteToNormalizedOrder } = await import(
  "../src/normalization/toNormalizedOrder.js"
);
const { enqueueOrder } = await import("../src/queue/orderQueue.js");
const { processSendToCluster } = await import("../src/queue/worker.js");
const { prisma } = await import("../src/lib/prisma.js");

describe("website order end-to-end (through to the mocked Cluster POS call)", () => {
  beforeEach(() => {
    store.clear();
    orderEvents.length = 0;
    clusterAttempts.length = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const websitePayload = {
    externalId: "web-e2e-001",
    orderType: "delivery" as const,
    customer: { name: "Marc Dubois", phone: "438-555-0199" },
    items: [
      {
        name: "Burger classique",
        quantity: 1,
        unitPrice: 14.0,
        modifiers: [{ name: "Bacon", price: 2.0 }],
        clusterItemUid: 1075120545,
      },
    ],
    subtotal: 16.0,
    tax: 2.4,
    deliveryFee: 4.0,
    total: 22.4,
    paymentStatus: "paid_externally" as const,
  };

  it("ingests, persists, queues, and sends the order to Cluster POS", async () => {
    // 1. Ingestion + normalisation (comme le ferait la route POST /orders/website)
    const parsed = parseWebsiteOrder(websitePayload);
    const normalized = websiteToNormalizedOrder(parsed);

    // 2. Persistance + mise en file (idempotence via source+externalId)
    const enqueueResult = await enqueueOrder(normalized);
    expect(enqueueResult.duplicate).toBe(false);

    const persisted = await prisma.order.findUnique({ where: { id: enqueueResult.orderId } });
    expect(persisted).toMatchObject({ status: "received", externalId: "web-e2e-001" });

    // 3. Le "worker" traite le job — appel HTTP vers Cluster POS mocké.
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ Invoice: "cluster-e2e-777", Status: 200, Message: "" }), {
        status: 200,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const fakeJob = {
      data: { orderId: enqueueResult.orderId },
      attemptsMade: 0,
      opts: { attempts: 3 },
      // @ts-expect-error - minimal fake Job, only the fields the processor reads
    } satisfies Partial<import("bullmq").Job>;

    await processSendToCluster(fakeJob as unknown as import("bullmq").Job);

    expect(fetchMock).toHaveBeenCalledTimes(1);

    const updated = await prisma.order.findUnique({ where: { id: enqueueResult.orderId } });
    expect(updated).toMatchObject({
      status: "sent_to_pos",
      clusterOrderRef: "cluster-e2e-777",
    });
    expect(clusterAttempts).toHaveLength(1);
    expect(clusterAttempts[0]).toMatchObject({ success: true, attemptNumber: 1 });
  });

  it("never creates a duplicate order when the same externalId is submitted twice", async () => {
    const parsed = parseWebsiteOrder(websitePayload);

    const first = await enqueueOrder(websiteToNormalizedOrder(parsed));
    const second = await enqueueOrder(websiteToNormalizedOrder(parsed));

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.orderId).toBe(first.orderId);
    expect(store.size).toBe(1);
  });

  it("marks the order as error after the final failed attempt", async () => {
    const parsed = parseWebsiteOrder({ ...websitePayload, externalId: "web-e2e-fail" });
    const normalized = websiteToNormalizedOrder(parsed);
    const enqueueResult = await enqueueOrder(normalized);

    const fetchMock = vi.fn().mockResolvedValue(new Response("down", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);

    const finalAttemptJob = {
      data: { orderId: enqueueResult.orderId },
      attemptsMade: 2, // 3rd and final attempt (attemptsMade is 0-indexed)
      opts: { attempts: 3 },
    };

    await expect(
      processSendToCluster(finalAttemptJob as unknown as import("bullmq").Job)
    ).rejects.toThrow();

    const updated = await prisma.order.findUnique({ where: { id: enqueueResult.orderId } });
    expect(updated).toMatchObject({ status: "error" });
  });
});
