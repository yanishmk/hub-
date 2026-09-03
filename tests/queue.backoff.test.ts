import { describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({ prisma: {} }));
vi.mock("bullmq", () => {
  class FakeQueue {
    add = vi.fn();
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

const { clusterAwareBackoff } = await import("../src/queue/worker.js");
const { ClusterPosError } = await import("../src/connectors/clusterPos.js");

describe("clusterAwareBackoff", () => {
  it("honors the Retry-After-derived delay on a 429", () => {
    const err = new ClusterPosError("rate limited", 429, undefined, 30_000);
    expect(clusterAwareBackoff(1, "cluster-aware", err)).toBe(30_000);
  });

  it("defaults to 60s on a 429 with no known retry delay", () => {
    const err = new ClusterPosError("rate limited", 429);
    expect(clusterAwareBackoff(1, "cluster-aware", err)).toBe(60_000);
  });

  it("falls back to exponential backoff for non-429 errors", () => {
    const err = new ClusterPosError("Cluster POS returned 503", 503);
    expect(clusterAwareBackoff(1, "cluster-aware", err)).toBe(2000);
    expect(clusterAwareBackoff(2, "cluster-aware", err)).toBe(4000);
    expect(clusterAwareBackoff(3, "cluster-aware", err)).toBe(8000);
  });

  it("caps the exponential backoff at 30s", () => {
    const err = new ClusterPosError("Cluster POS returned 503", 503);
    expect(clusterAwareBackoff(10, "cluster-aware", err)).toBe(30_000);
  });
});
