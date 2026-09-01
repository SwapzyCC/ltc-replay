/**
 * The live tap: subscribe to Core's ZMQ, journal every frame, re-publish it.
 *
 * Two jobs, deliberately in that order. Journalling first is what makes the
 * service worth running — a consumer that is down when a frame arrives finds
 * it waiting afterwards. Re-publishing second means an existing Core ZMQ
 * consumer can point at this socket instead and behave exactly as before.
 *
 * Core stamps each frame with a per-topic sequence counter. Comparing it to
 * the last one seen is the only way to learn that Core's own high-water mark
 * dropped something, which is otherwise completely silent.
 */

import { Subscriber, Publisher } from "zeromq";
import type { Config } from "./config.js";
import type { Journal } from "./journal.js";
import { logger, errMsg } from "./log.js";
import { computeTxid } from "./txid.js";

const log = logger("tap");

const RECONNECT_DELAY_MS = 2_000;

export interface TapStats {
  txSeen: number;
  txJournalled: number;
  blocksSeen: number;
  coreGaps: number;
  lastTxAt: number | null;
  lastBlockAt: number | null;
}

export class Tap {
  private running = false;
  private txSocket: Subscriber | null = null;
  private blockSocket: Subscriber | null = null;
  private pub: Publisher | null = null;

  private readonly coreSeq = new Map<string, number>();

  private readonly stats: TapStats = {
    txSeen: 0,
    txJournalled: 0,
    blocksSeen: 0,
    coreGaps: 0,
    lastTxAt: null,
    lastBlockAt: null,
  };

  /** Set by the owner so a hashblock frame can trigger an immediate catch-up. */
  onBlock: ((hash: string) => void) | null = null;

  constructor(
    private readonly cfg: Config,
    private readonly journal: Journal,
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    this.pub = new Publisher();
    await this.pub.bind(this.cfg.pubBind);
    log.info(`republishing on ${this.cfg.pubBind}`);

    void this.loop("rawtx", this.cfg.zmqTxUrl, (frames) => this.handleTx(frames));
    void this.loop("hashblock", this.cfg.zmqBlockUrl, (frames) => this.handleBlock(frames));
  }

  async stop(): Promise<void> {
    this.running = false;
    this.txSocket?.close();
    this.blockSocket?.close();
    this.txSocket = null;
    this.blockSocket = null;
    await this.pub?.unbind(this.cfg.pubBind).catch(() => undefined);
    this.pub?.close();
    this.pub = null;
    log.info("stopped");
  }

  getStats(): TapStats {
    return { ...this.stats };
  }

  // ── Socket loops ──────────────────────────────────────────────────────────

  private async loop(
    topic: "rawtx" | "hashblock",
    url: string,
    handle: (frames: Buffer[]) => Promise<void>,
  ): Promise<void> {
    while (this.running) {
      const sock = new Subscriber();
      // A generous receive buffer: a block's worth of mempool churn can arrive
      // faster than SQLite commits, and dropping there would defeat the point.
      sock.receiveHighWaterMark = 100_000;
      sock.connect(url);
      sock.subscribe(topic);

      if (topic === "rawtx") this.txSocket = sock;
      else this.blockSocket = sock;

      log.info(`subscribed to ${topic} at ${url}`);

      try {
        for await (const frames of sock) {
          if (!this.running) break;
          await handle(frames as Buffer[]);
        }
      } catch (err: unknown) {
        if (!this.running) return;
        log.error(`${topic} loop failed — reconnecting`, errMsg(err));
      }

      if (!this.running) return;
      sock.close();
      await new Promise((r) => setTimeout(r, RECONNECT_DELAY_MS));
    }
  }

  /** Warns when Core's per-topic counter skips, which means frames were lost. */
  private checkCoreSeq(topic: string, frames: Buffer[]): number | null {
    const raw = frames[2];
    if (!raw || raw.length < 4) return null;
    const seq = raw.readUInt32LE(0);

    const prev = this.coreSeq.get(topic);
    if (prev !== undefined && seq !== ((prev + 1) >>> 0)) {
      const missed = (seq - prev - 1) >>> 0;
      this.stats.coreGaps += 1;
      log.warn(
        `core dropped ${missed} ${topic} frame(s) (seq ${prev} → ${seq}) — ` +
          `raise -zmqpub${topic}hwm in litecoin.conf; catch-up will cover blocks`,
      );
    }
    this.coreSeq.set(topic, seq);
    return seq;
  }

  private async republish(frames: Buffer[]): Promise<void> {
    if (!this.pub) return;
    try {
      await this.pub.send(frames.slice(0, 3));
    } catch (err: unknown) {
      // A failed fan-out is a live-path degradation, never a reason to stop
      // journalling — the durable copy is already written by this point.
      log.warn("republish failed", errMsg(err));
    }
  }

  // ── Frame handlers ────────────────────────────────────────────────────────

  private async handleTx(frames: Buffer[]): Promise<void> {
    const payload = frames[1];
    if (!payload || payload.length === 0) return;

    this.checkCoreSeq("rawtx", frames);
    this.stats.txSeen += 1;
    this.stats.lastTxAt = Date.now();

    let txid: string;
    try {
      txid = computeTxid(payload);
    } catch (err: unknown) {
      log.warn(`undecodable rawtx frame (${payload.length} bytes)`, errMsg(err));
      return;
    }

    try {
      if (this.journal.appendTx(txid, payload) !== null) this.stats.txJournalled += 1;
    } catch (err: unknown) {
      log.error(`journal write failed for ${txid}`, errMsg(err));
    }

    await this.republish(frames);
  }

  private async handleBlock(frames: Buffer[]): Promise<void> {
    const payload = frames[1];
    if (!payload || payload.length !== 32) return;

    this.checkCoreSeq("hashblock", frames);
    this.stats.blocksSeen += 1;
    this.stats.lastBlockAt = Date.now();

    const hash = Buffer.from(payload).reverse().toString("hex");

    await this.republish(frames);

    // The height is not in the frame, so catch-up resolves it over RPC and
    // writes the journal entry. That keeps one code path responsible for
    // block records, whether they arrive live or after downtime.
    this.onBlock?.(hash);
  }
}
