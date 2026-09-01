/**
 * Catch-up: the part that makes this a replay service rather than a tap.
 *
 * A tap only knows what it was connected for. Catch-up asks the node what the
 * chain actually looks like and fills whatever the journal is missing, so the
 * relay's *own* downtime is covered too — a VPS reboot leaves a gap that this
 * closes on the next start.
 *
 * It also owns reorg detection. If the block the journal recorded at some
 * height is no longer the block the node has there, consumers may have
 * credited money against an orphaned branch, and they can only find out if
 * somebody tells them.
 */

import type { Config } from "./config.js";
import type { Journal } from "./journal.js";
import { LitecoinRpc } from "./rpc.js";
import { logger, errMsg } from "./log.js";

const log = logger("catchup");

/** Blocks written per pass, so a badly stale journal makes visible progress. */
const MAX_BLOCKS_PER_RUN = 2_000;

/** How far back a reorg is searched for before giving up and shouting. */
const MAX_REORG_DEPTH = 100;

export interface CatchupResult {
  from: number;
  to: number;
  written: number;
  reorgDepth: number;
  more: boolean;
}

export class Catchup {
  private running = false;
  private queued = false;

  constructor(
    private readonly cfg: Config,
    private readonly journal: Journal,
    private readonly rpc: LitecoinRpc,
  ) {}

  /**
   * Verifies the node can actually serve what this service promises. Both
   * checks are fatal by design: starting anyway would mean silently handing
   * consumers an incomplete history.
   */
  async preflight(): Promise<void> {
    const info = await this.rpc.getChainInfo();
    if (info.initialblockdownload) {
      throw new Error(
        `node is still in initial block download (${info.blocks}/${info.headers}) — ` +
          "replay would report a tip that is not the chain tip",
      );
    }
    if (!(await this.rpc.hasTxIndex())) {
      throw new Error(
        "node has no txindex — /v1/replay cannot resolve transactions that " +
          "belong to no loaded wallet. Set txindex=1 in litecoin.conf and reindex.",
      );
    }
    log.info(`node ready — chain ${info.chain}, height ${info.blocks}`);
  }

  /**
   * Runs a pass, collapsing concurrent requests. A hashblock frame and the
   * interval timer landing together must not walk the chain twice.
   */
  async run(): Promise<CatchupResult | null> {
    if (this.running) {
      this.queued = true;
      return null;
    }
    this.running = true;
    try {
      let result = await this.pass();
      // Keep going while a pass hit its cap, or while something asked again
      // mid-flight, so the journal converges on the tip instead of drifting.
      while (this.queued || result.more) {
        this.queued = false;
        result = await this.pass();
      }
      return result;
    } finally {
      this.running = false;
    }
  }

  private async pass(): Promise<CatchupResult> {
    const tip = await this.rpc.getBlockCount();
    const last = this.journal.lastBlock();

    if (last === null) {
      // First run. Recording the whole chain would be pointless — no consumer
      // is asking for history that predates the service.
      const start = this.cfg.startHeight ?? tip;
      const from = Math.max(0, Math.min(start, tip));
      const written = await this.writeRange(from, tip);
      log.info(`journal initialised at height ${from} (tip ${tip}, ${written} block(s))`);
      return { from, to: tip, written, reorgDepth: 0, more: false };
    }

    const reorgDepth = await this.reconcileReorg(last.height, last.hash);
    const resume = this.journal.lastBlock();
    const from = (resume?.height ?? last.height) + 1;

    if (from > tip) return { from, to: tip, written: 0, reorgDepth, more: false };

    const capped = Math.min(tip, from + MAX_BLOCKS_PER_RUN - 1);
    const written = await this.writeRange(from, capped);

    if (written > 0) {
      log.info(`filled heights ${from}..${capped} (${written} block(s), tip ${tip})`);
    }
    return { from, to: capped, written, reorgDepth, more: capped < tip };
  }

  private async writeRange(from: number, to: number): Promise<number> {
    let written = 0;
    for (let h = from; h <= to; h++) {
      const hash = await this.rpc.getBlockHash(h);
      if (this.journal.appendBlock(h, hash, "catchup") !== null) written += 1;
    }
    return written;
  }

  /**
   * Walks back from the journal's tip until its record agrees with the node.
   * Returns how many heights were orphaned — normally 0.
   */
  private async reconcileReorg(tipHeight: number, tipHash: string): Promise<number> {
    const onChain = await this.rpc.getBlockHash(tipHeight).catch(() => null);
    if (onChain === tipHash) return 0;

    log.warn(`journal tip ${tipHeight} no longer on chain — searching for the fork`);

    let fork = tipHeight;
    let depth = 0;
    while (depth < MAX_REORG_DEPTH && fork > 0) {
      const stored = this.journal.blockAtHeight(fork);
      if (stored === null) break; // Nothing recorded here; nothing to disagree.

      const actual = await this.rpc.getBlockHash(fork).catch(() => null);
      if (actual !== null && actual === stored.hash) break; // Branches agree again.

      if (actual !== null) {
        this.journal.appendReorg(fork, actual, stored.hash);
        log.warn(`reorg at height ${fork}: ${stored.hash} orphaned, now ${actual}`);
      }
      fork -= 1;
      depth += 1;
    }

    if (depth >= MAX_REORG_DEPTH) {
      log.error(
        `reorg deeper than ${MAX_REORG_DEPTH} blocks, or the journal belongs to a ` +
          "different chain — refusing to rewrite further. Inspect before trusting replay.",
      );
      return depth;
    }

    if (depth > 0) {
      const removed = this.journal.dropBlocksFrom(fork + 1);
      log.warn(`dropped ${removed} journalled block(s) above height ${fork}; re-walking`);
    }
    return depth;
  }

  /** Starts the periodic pass. Returns a stop function. */
  schedule(): () => void {
    const timer = setInterval(() => {
      void this.run().catch((err: unknown) => log.error("scheduled pass failed", errMsg(err)));
    }, this.cfg.catchupIntervalMs);
    timer.unref?.();
    return () => clearInterval(timer);
  }
}
