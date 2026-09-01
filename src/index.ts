/**
 * ltc-replay — durable ZMQ tap and replay service for a Litecoin Core node.
 *
 * Core's ZMQ is fire-and-forget: a consumer that is not connected when a frame
 * is published never learns it existed. Run this alongside the node and that
 * stops being true — every frame is journalled before it is re-published, and
 * a consumer that was down asks for what it missed when it comes back.
 *
 * Boot order matters and is not arbitrary:
 *   1. preflight  — refuse to start against a syncing or txindex-less node
 *   2. tap        — subscribe first, so nothing is missed while catching up
 *   3. catch-up   — fill the gap left by the last shutdown
 *   4. serve      — only advertise availability once the journal is current
 */

import { loadDotEnv, loadConfig, isPublicBind, type Config } from "./config.js";
import { Journal } from "./journal.js";
import { LitecoinRpc } from "./rpc.js";
import { Tap } from "./tap.js";
import { Catchup } from "./catchup.js";
import { createApi } from "./http.js";
import { logger, errMsg } from "./log.js";

const log = logger("main");

const PRUNE_INTERVAL_MS = 15 * 60_000;

async function main(): Promise<void> {
  loadDotEnv();

  let cfg: Config;
  try {
    cfg = loadConfig();
  } catch (err: unknown) {
    log.error(`configuration rejected: ${errMsg(err)}`);
    process.exit(1);
  }

  warnOnExposure(cfg);

  const journal = new Journal(cfg.dbPath);
  const rpc = new LitecoinRpc(cfg);
  const catchup = new Catchup(cfg, journal, rpc);

  try {
    await catchup.preflight();
  } catch (err: unknown) {
    log.error(`node preflight failed: ${errMsg(err)}`);
    journal.close();
    process.exit(1);
  }

  const tap = new Tap(cfg, journal);
  // A new block is the one event worth reacting to immediately; the interval
  // below is only a safety net for frames the tap never received.
  tap.onBlock = () => {
    void catchup.run().catch((err: unknown) => log.error("catch-up failed", errMsg(err)));
  };
  await tap.start();

  const first = await catchup.run();
  if (first) log.info(`startup catch-up wrote ${first.written} block(s) up to ${first.to}`);

  const stopCatchup = catchup.schedule();

  const prune = setInterval(() => {
    try {
      const cutoff = Date.now() - cfg.txRetentionHours * 3_600_000;
      const removed = journal.pruneTx(cutoff);
      if (removed > 0) log.info(`pruned ${removed} tx event(s) older than ${cfg.txRetentionHours}h`);
    } catch (err: unknown) {
      log.warn("prune failed", errMsg(err));
    }
  }, PRUNE_INTERVAL_MS);
  prune.unref?.();

  const server = createApi({ cfg, journal, rpc, tap, startedAt: Date.now() });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(cfg.httpPort, cfg.httpBind, resolve);
  });
  log.info(`replay API on http://${cfg.httpBind}:${cfg.httpPort}`);

  const stats = journal.stats();
  log.info(
    `ready — journal holds ${stats.blocks} block(s) and ${stats.txs} tx event(s), ` +
      `cursor at seq ${journal.tipSeq()}`,
  );

  // ── Shutdown ──────────────────────────────────────────────────────────────

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    log.info(`${signal} received — shutting down`);

    clearInterval(prune);
    stopCatchup();

    const done = (): void => {
      // Closing the journal last means anything still in flight above has
      // already committed, and the WAL is checkpointed on close.
      journal.close();
      log.info("stopped cleanly");
      process.exit(0);
    };

    server.close(() => {
      void tap.stop().then(done, done);
    });

    // A stuck socket must not hold the process open through a deploy.
    setTimeout(() => {
      log.warn("shutdown timed out — exiting anyway");
      process.exit(0);
    }, 10_000).unref?.();
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  process.on("unhandledRejection", (reason: unknown) => {
    log.error("unhandled rejection", errMsg(reason));
  });
  process.on("uncaughtException", (err: unknown) => {
    // Losing frames silently is worse than restarting, so this exits and lets
    // systemd bring the service back — catch-up closes the gap on the way up.
    log.error("uncaught exception — exiting for restart", errMsg(err));
    process.exit(1);
  });
}

function warnOnExposure(cfg: Config): void {
  if (isPublicBind(cfg.httpBind)) {
    log.warn(
      `HTTP_BIND is ${cfg.httpBind}, which is reachable off-box. The bearer token ` +
        "is the only thing in front of the replay history — firewall this port to " +
        "the consumer's address, and terminate TLS in front of it.",
    );
  }
  const pubHost = /^tcp:\/\/([^:]+)/.exec(cfg.pubBind)?.[1];
  if (pubHost && isPublicBind(pubHost) && pubHost !== "0.0.0.0") {
    log.warn(
      `PUB_BIND is ${cfg.pubBind}. ZMQ PUB has no authentication — restrict this ` +
        "port to the consumer's address at the firewall.",
    );
  } else if (pubHost === "0.0.0.0") {
    log.warn(
      "PUB_BIND listens on every interface with no authentication. Bind it to a " +
        "private address instead.",
    );
  }
}

void main().catch((err: unknown) => {
  log.error(`failed to start: ${errMsg(err)}`);
  process.exit(1);
});
