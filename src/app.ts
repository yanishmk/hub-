import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { ZodError } from "zod";
import { registerOrderRoutes } from "./routes/orders.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import { registerDashboardRoutes } from "./routes/dashboard.js";

export function buildApp(): FastifyInstance {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? "info",
      transport:
        process.env.NODE_ENV !== "production"
          ? { target: "pino-pretty" }
          : undefined,
    },
  });

  app.addContentTypeParser(
    "application/json",
    { parseAs: "string" },
    (request, body, done) => {
      (request as FastifyRequest & { rawBody?: string }).rawBody = body as string;
      try {
        done(null, body ? JSON.parse(body as string) : {});
      } catch (error) {
        done(error as Error);
      }
    }
  );

  app.get("/health", async () => ({ status: "ok" }));

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({ error: "Validation error", issues: error.issues });
    }
    app.log.error(error);
    return reply.code(500).send({ error: "Internal server error" });
  });

  app.register(registerOrderRoutes);
  app.register(registerWebhookRoutes);
  app.register(registerDashboardRoutes);

  return app;
}
