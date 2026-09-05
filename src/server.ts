import { env } from "./lib/env.js";
import { buildApp } from "./app.js";

const app = buildApp();

if (env.START_WORKER_IN_PROCESS) {
  await import("./queue/worker.js");
  app.log.info("Cluster POS worker started in API process");
}

app
  .listen({ port: env.PORT, host: env.HOST })
  .then((address) => {
    app.log.info(`cluster-pos-hub listening on ${address}`);
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
