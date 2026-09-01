/**
 * The composition root: what gets built, in what order, and how it comes down.
 *
 * Everything the service is made of is assembled here and nowhere else. No
 * module below this one reaches for a singleton or reads `process.env`, which
 * is what lets each of them be stood up in isolation by the tests.
 *
 * Boot order matters and is not arbitrary:
 *
 *   1. journal   — open the store before anything can want to write to it.
 *   2. preflight — refuse to start against a node still in initial sync;
 *                  report, but tolerate, a pruned one.
 *   3. tap       — subscribe *before* catching up, so nothing published during
 *                  the catch-up window is missed. The journal deduplicates the
 *                  overlap, which is the cheap side of the trade; a gap is not.
 *   4. catch-up  — fill whatever the last shutdown left behind.
 *   5. serve     — advertise availability only once the journal is current, so
 *                  a consumer's first poll is not answered with a false empty.
 *
 * Shutdown runs the reverse, and is idempotent: a second SIGTERM during a slow
 * drain is ignored rather than tearing the journal out from under a write.
 */

import type { Server } from "node:http";

import type { Config } from "./config/index.js";
import { isPublicBind } from "./config/index.js";
import { Journal } from "./journal/index.js";
import { LitecoinRpc } from "./chain/rpc.js";
import { Tap } from "./services/tap.js";
import { Catchup } from "./services/catchup.js";
import { createApi } from "./http/server.js";
import { logger, errMsg } from "./core/log.js";

const log = logger("app");

/** How often retention and index trimming run. Neither is urgent. */
const PRUNE_INTERVAL_MS = 15 * 60_000;

/** Longest a drain may take before the process leaves anyway. */
const SHUTDOWN_GRACE_MS = 10_000;

export class App {
  private readonly journal: Journal;
  private readonly rpc: LitecoinRpc;
  private readonly catchup: Catchup;
  private readonly tap: Tap;
  private readonly startedAt = Date.now();

  private server: Server | null = null;
  private pruneTimer: NodeJS.Timeout | null = null;
  private stopCatchup: (() => void) | null = null;
  private stopping = false;

  constructor(private readonly cfg: Config) {
    this.journal = new Journal(cfg.dbPath);
    this.rpc = new LitecoinRpc(cfg);
    this.catchup = new Catchup(cfg, this.journal, this.rpc);
    this.tap = new Tap(cfg, this.journal);
  }

  async start(): Promise<void> {
    this.warnOnExposure();

    try {
      await this.catchup.preflight();
    } catch (err: unknown) {
      // Nothing else has been opened yet, so releasing the journal here leaves
      // the database cleanly closed for the next attempt.
      this.journal.close();
      throw new Error(`node preflight failed: ${errMsg(err)}`, { cause: err });
    }

    // A new block is the one event worth reacting to immediately. The interval
    // below is only a safety net for frames the tap never received.
    this.tap.onBlock = () => {
      void this.catchup.run().catch((err: unknown) => log.error("catch-up failed", errMsg(err)));
    };
    await this.tap.start();

    const first = await this.catchup.run();
    if (first) log.info(`startup catch-up wrote ${first.written} block(s) up to ${first.to}`);

    this.stopCatchup = this.catchup.schedule();
    this.pruneTimer = setInterval(() => this.prune(), PRUNE_INTERVAL_MS);
    this.pruneTimer.unref?.();

    await this.listen();
    this.logReady();
  }

  private async listen(): Promise<void> {
    const server = createApi({
      cfg: this.cfg,
      journal: this.journal,
      rpc: this.rpc,
      tap: this.tap,
      startedAt: this.startedAt,
    });

    await new Promise<void>((resolve, reject) => {
      // Removed on success so a later runtime error — a dropped socket, say —
      // does not reject an already-settled promise.
      const onError = (err: Error): void => reject(err);
      server.once("error", onError);
      server.listen(this.cfg.httpPort, this.cfg.httpBind, () => {
        server.removeListener("error", onError);
        resolve();
      });
    });

    this.server = server;
    log.info(`replay API on http://${this.cfg.httpBind}:${this.cfg.httpPort}`);
  }

  private logReady(): void {
    const stats = this.journal.stats();
    log.info(
      `ready — journal holds ${stats.blocks} block(s), ${stats.txs} tx event(s) and ` +
        `${stats.indexedTxs} indexed transaction(s) from height ` +
        `${stats.indexFloorHeight ?? "—"}; cursor at seq ${this.journal.tipSeq()}`,
    );
  }

  private prune(): void {
    try {
      const cutoff = Date.now() - this.cfg.txRetentionHours * 3_600_000;

      const removed = this.journal.pruneTx(cutoff);
      if (removed > 0) {
        log.info(`pruned ${removed} tx event(s) older than ${this.cfg.txRetentionHours}h`);
      }

      // Address rows for transactions that never made it into a block. Ones
      // that did are kept, and age out with the block index instead.
      const dropped = this.journal.pruneAddressTxs(cutoff);
      if (dropped > 0) log.info(`pruned ${dropped} address row(s) for unmined transactions`);

      // The transaction index is the bulk of the database — one row per
      // transaction per block, against a few dozen bytes for the block itself.
      const trimmed = this.catchup.pruneIndex();
      if (trimmed > 0) {
        log.info(
          `trimmed ${trimmed} index row(s) below the last ${this.cfg.txIndexBlocks} block(s)`,
        );
      }

      if (removed + dropped + trimmed > 0) this.journal.checkpoint();
    } catch (err: unknown) {
      // Pruning is housekeeping. Failing it must never take the service down.
      log.warn("prune failed", errMsg(err));
    }
  }

  /** Idempotent. Resolves once the journal is closed and it is safe to exit. */
  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;

    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.stopCatchup?.();

    if (this.server) {
      const server = this.server;
      await Promise.race([
        new Promise<void>((resolve) => server.close(() => resolve())),
        // An in-flight /v1/replay stream can legitimately be long-running, and
        // a deploy must not wait on it.
        delay(SHUTDOWN_GRACE_MS),
      ]);
    }

    try {
      await this.tap.stop();
    } catch (err: unknown) {
      log.warn("tap did not stop cleanly", errMsg(err));
    }

    // Last, so anything still in flight above has already committed. The WAL
    // is checkpointed on close.
    this.journal.close();
  }

  /**
   * The two ports that carry data have very different protections in front of
   * them — a bearer token on one, nothing at all on the other — so binding
   * either off-box is called out by name at boot rather than left to be
   * discovered.
   */
  private warnOnExposure(): void {
    if (isPublicBind(this.cfg.httpBind)) {
      log.warn(
        `HTTP_BIND is ${this.cfg.httpBind}, which is reachable off-box. The bearer ` +
          "token is the only thing in front of the replay history — firewall this " +
          "port to the consumer's address, and terminate TLS in front of it.",
      );
    }

    const pubHost = /^tcp:\/\/([^:]+)/.exec(this.cfg.pubBind)?.[1];
    if (pubHost === "0.0.0.0") {
      log.warn(
        "PUB_BIND listens on every interface with no authentication. Bind it to a " +
          "private address instead.",
      );
    } else if (pubHost && isPublicBind(pubHost)) {
      log.warn(
        `PUB_BIND is ${this.cfg.pubBind}. ZMQ PUB has no authentication — restrict ` +
          "this port to the consumer's address at the firewall.",
      );
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
}
