/**
 * ltc-replay — durable ZMQ tap and replay service for a Litecoin Core node.
 *
 * Core's ZMQ is fire-and-forget: a consumer that is not connected when a frame
 * is published never learns it existed. Run this alongside the node and that
 * stops being true — every frame is journalled before it is re-published, and
 * a consumer that was down asks for what it missed when it comes back.
 *
 * This file is the process wrapper only: environment, configuration, signals
 * and exit codes. What the service *is* lives in ./app.ts.
 */

import { loadDotEnv, loadConfig, type Config } from "./config/index.js";
import { App } from "./app.js";
import { logger, errMsg, refreshLogSettings } from "./core/log.js";

const log = logger("main");

async function main(): Promise<void> {
  loadDotEnv();
  // LOG_LEVEL and LOG_FORMAT may have arrived with the .env file, after the
  // logger read them at import time.
  refreshLogSettings();

  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err: unknown) {
    // Configuration errors are the operator's to fix, so they are reported as
    // one line naming the setting rather than as a stack trace.
    log.error(`configuration rejected: ${errMsg(err)}`);
    process.exit(1);
  }

  const app = new App(cfg);
  await app.start();

  installSignalHandlers(app);
}

function installSignalHandlers(app: App): void {
  let closing = false;

  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    log.info(`${signal} received — shutting down`);

    void app.stop().then(
      () => {
        log.info("stopped cleanly");
        process.exit(0);
      },
      (err: unknown) => {
        log.error("shutdown failed", errMsg(err));
        process.exit(1);
      },
    );
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason: unknown) => {
    log.error("unhandled rejection", errMsg(reason));
  });

  process.on("uncaughtException", (err: unknown) => {
    // Losing frames silently is worse than restarting, so this exits and lets
    // the supervisor bring the service back — catch-up closes the gap on the
    // way up, which is the whole point of journalling before re-publishing.
    log.error("uncaught exception — exiting for restart", errMsg(err));
    process.exit(1);
  });
}

void main().catch((err: unknown) => {
  log.error(`failed to start: ${errMsg(err)}`);
  process.exit(1);
});
