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
 *
 * And on a pruned node it owns the transaction index. Core will not run
 * `txindex` alongside `-prune`, which means `getrawtransaction` cannot resolve
 * a confirmed deposit to a watch-only address — so as catch-up walks each
 * block it records which transactions were in it. That mapping is the only
 * thing standing between a consumer and "I saw this transaction in the mempool
 * and can no longer tell whether it confirmed".
 */

import type { Config } from "../config/index.js";
import type { Journal } from "../journal/index.js";
import { LitecoinRpc } from "../chain/rpc.js";
import { extractPayments } from "../chain/payments.js";
import { logger, errMsg } from "../core/log.js";

const log = logger("catchup");

/** Blocks written per pass, so a badly stale journal makes visible progress. */
const MAX_BLOCKS_PER_RUN = 2_000;

/** How far back a reorg is searched for before giving up and shouting. */
const MAX_REORG_DEPTH = 100;

/** Litecoin's target spacing, used only to phrase a retention window in days. */
const MINUTES_PER_BLOCK = 2.5;

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

  /**
   * Lowest height the node can still serve full block data for, or null on an
   * unpruned node. Refreshed every pass, because it advances as the node
   * prunes — a range that was readable a minute ago may not be now.
   */
  private pruneFloor: number | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly journal: Journal,
    private readonly rpc: LitecoinRpc,
  ) {}

  /**
   * Verifies the node can serve what this service promises, and reports the
   * constraints it will be working under.
   *
   * Only one condition is fatal: a node still syncing would have the relay
   * publish a tip that is not the chain tip, and consumers would read the
   * absence of their deposit as final. Pruning is not fatal — it bounds how
   * far back replay can reach, which is a horizon to report, not a defect.
   */
  async preflight(): Promise<void> {
    const info = await this.rpc.getChainInfo();
    if (info.initialblockdownload) {
      throw new Error(
        `node is still in initial block download (${info.blocks}/${info.headers}) — ` +
          "replay would report a tip that is not the chain tip",
      );
    }

    this.pruneFloor = info.pruned === true ? (info.pruneheight ?? 0) : null;
    const indexes = await this.rpc.getIndexNames();

    log.info(`node ready — chain ${info.chain}, height ${info.blocks}`);

    if (this.pruneFloor !== null) {
      const depth = info.blocks - this.pruneFloor;
      const days = Math.floor((depth * MINUTES_PER_BLOCK) / 60 / 24);
      log.info(
        `node is pruned: full blocks from height ${this.pruneFloor} ` +
          `(${depth} blocks, roughly ${days} days). Replay cannot reach below that floor.`,
      );
    }

    if (!indexes.includes("txindex")) {
      // Expected on a pruned node — Core refuses to start with both — so this
      // is stated rather than warned about. The consequence is what matters:
      // the node cannot answer getrawtransaction for a watch-only deposit, so
      // the relay keeps its own txid → block mapping instead.
      const reason = this.pruneFloor !== null ? "pruned node" : "not enabled";
      log.info(
        `node has no txindex (${reason}) — the relay maintains its own transaction ` +
          `index over the last ${this.cfg.txIndexBlocks} block(s). Consumers must ` +
          "resolve confirmations through /v1/tx, not through getrawtransaction.",
      );

      if (this.cfg.txIndexBlocks === 0) {
        log.warn(
          "TX_INDEX_BLOCKS is 0 and the node has no txindex — nothing can answer " +
            "whether a given transaction confirmed. /v1/tx will always miss.",
        );
      }
    }
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
    // getblockchaininfo rather than getblockcount: the same round trip also
    // refreshes the prune floor, which moves under us as the node prunes.
    const info = await this.rpc.getChainInfo();
    const tip = info.blocks;
    this.pruneFloor = info.pruned === true ? (info.pruneheight ?? 0) : null;

    const last = this.journal.lastBlock();

    if (last === null) {
      // First run. Recording the whole chain would be pointless — no consumer
      // is asking for history that predates the service.
      const start = this.cfg.startHeight ?? tip;
      const from = this.clampToPruneFloor(Math.max(0, Math.min(start, tip)), "first run");
      const written = await this.writeRange(from, tip);
      log.info(`journal initialised at height ${from} (tip ${tip}, ${written} block(s))`);
      return { from, to: tip, written, reorgDepth: 0, more: false };
    }

    const reorgDepth = await this.reconcileReorg(last.height, last.hash);
    const resume = this.journal.lastBlock();
    const from = this.clampToPruneFloor((resume?.height ?? last.height) + 1, "resume");

    if (from > tip) return { from, to: tip, written: 0, reorgDepth, more: false };

    const capped = Math.min(tip, from + MAX_BLOCKS_PER_RUN - 1);
    const written = await this.writeRange(from, capped);

    if (written > 0) {
      log.info(`filled heights ${from}..${capped} (${written} block(s), tip ${tip})`);
    }
    return { from, to: capped, written, reorgDepth, more: capped < tip };
  }

  /**
   * Keeps the walk inside what the node can still serve.
   *
   * On a pruned node a long enough outage puts the journal's resume point
   * below the prune floor, and those blocks are simply gone: `getblock` fails
   * on every one of them, so the pass would make no progress while logging the
   * same error forever. Skipping forward is the only way to keep serving, but
   * it leaves a real hole in the history, so it is said plainly and loudly.
   */
  private clampToPruneFloor(height: number, context: string): number {
    if (this.pruneFloor === null || height >= this.pruneFloor) return height;
    log.error(
      `${context}: height ${height} is below the node's prune floor ${this.pruneFloor}. ` +
        `Blocks ${height}..${this.pruneFloor - 1} are gone from this node and cannot be ` +
        "replayed — any deposit confirmed in that range has to be reconciled by other " +
        "means. Resuming from the floor.",
    );
    return this.pruneFloor;
  }

  private async writeRange(from: number, to: number): Promise<number> {
    let written = 0;
    for (let h = from; h <= to; h++) {
      const hash = await this.rpc.getBlockHash(h);

      // Both indexes are filled before the block event is recorded. The block
      // event is the consumer's cursor, so writing it last means no consumer
      // ever sees a height announced whose transactions it cannot yet look
      // up — the reverse order would open exactly that window.
      await this.indexBlock(h, hash);

      if (this.journal.appendBlock(h, hash, "catchup") !== null) written += 1;
    }
    return written;
  }

  /**
   * Fills the two indexes for one block, reading it at the cheapest verbosity
   * that answers what is switched on.
   *
   * Verbosity 1 returns txids only; verbosity 2 returns every transaction's
   * full serialisation, which is a great deal more data and only worth
   * fetching when the addresses inside it are actually being indexed.
   */
  private async indexBlock(height: number, hash: string): Promise<void> {
    if (this.cfg.addressIndex) {
      const block = await this.rpc.getBlockWithTxs(hash);

      if (this.cfg.txIndexBlocks > 0) {
        this.journal.indexBlockTxs(
          height,
          hash,
          block.tx.map((t) => t.txid),
        );
      }

      const ts = block.time * 1_000;
      for (const tx of block.tx) {
        try {
          const { txid, payments } = extractPayments(Buffer.from(tx.hex, "hex"));
          this.journal.indexAddressPayments(txid, payments, ts);
        } catch (err: unknown) {
          // One unparseable transaction must not abandon the block: the rest
          // of it still carries deposits, and stopping here would leave the
          // block half-indexed but still about to be marked done.
          log.warn(`skipping undecodable tx ${tx.txid} in block ${height}`, errMsg(err));
        }
      }
      return;
    }

    if (this.cfg.txIndexBlocks > 0) {
      const block = await this.rpc.getBlockTxids(hash);
      this.journal.indexBlockTxs(height, hash, block.tx);
    }
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

  /**
   * Trims the transaction index to the configured depth below the journal tip.
   * Driven by the maintenance timer rather than from a pass, so a long
   * catch-up is not competing with a large DELETE.
   */
  pruneIndex(): number {
    if (this.cfg.txIndexBlocks === 0) return 0;
    const tip = this.journal.lastBlock();
    if (tip === null) return 0;
    const floor = tip.height - this.cfg.txIndexBlocks;
    if (floor <= 0) return 0;
    return this.journal.pruneBlockTxs(floor);
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
