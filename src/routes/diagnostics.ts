import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { createHash, timingSafeEqual } from "node:crypto";
import { env } from "../lib/env.js";

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

export async function registerDiagnosticsRoutes(app: FastifyInstance) {
  app.get("/diagnostics/config", async (request, reply) => {
    if (!requireAdminKey(request, reply)) return;

    return reply.send({
      ubereats: {
        enabled: env.UBEREATS_ENABLED,
        autoAccept: env.UBEREATS_AUTO_ACCEPT,
        manualAcceptPollEnabled: env.UBEREATS_MANUAL_ACCEPT_POLL_ENABLED,
        webhookSigningSecret: secretInfo(env.UBEREATS_WEBHOOK_SIGNING_SECRET),
        clientSecret: secretInfo(env.UBEREATS_CLIENT_SECRET),
      },
      worker: {
        startWorkerInProcess: env.START_WORKER_IN_PROCESS,
        redisUrlConfigured: Boolean(env.REDIS_URL),
      },
      database: {
        databaseUrlConfigured: Boolean(env.DATABASE_URL),
      },
    });
  });
}

function secretInfo(value: string) {
  return {
    configured: Boolean(value),
    length: value.length,
    fingerprint: value ? createHash("sha256").update(value).digest("hex").slice(0, 12) : null,
  };
}
