import { env } from "./lib/env.js";
import { buildApp } from "./app.js";

const app = buildApp();

app
  .listen({ port: env.PORT, host: env.HOST })
  .then((address) => {
    app.log.info(`cluster-pos-hub listening on ${address}`);
    if (env.START_WORKER_IN_PROCESS) {
      void import("./queue/worker.js")
        .then(() => {
          app.log.info("Cluster POS worker started in API process");
        })
        .catch((err) => {
          app.log.error({ err }, "Cluster POS worker failed to start");
        });
    }
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
