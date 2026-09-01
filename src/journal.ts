/**
 * The durable event log.
 *
 * Two kinds of record live here and they are deliberately not treated alike:
 *
 *   block  — permanent. A few dozen bytes each, ~576 a day. This is what makes
 *            a missed deposit recoverable: whatever a consumer failed to see in
 *            the mempool is still sitting in a block, and the block index says
 *            exactly which blocks it has not looked at yet.
 *
 *   tx     — retention-bounded. A raw mempool sighting is a latency
 *            optimisation, not a source of truth. Keeping a few days of them
 *            lets a consumer restore its pending set after a short restart;
 *            past that, correctness comes from blocks and these are pruned.
 *
 * `seq` is the consumer cursor. AUTOINCREMENT means it is monotonic and never
 * reused, so "give me everything after N" is unambiguous across restarts.
 */

import Database from "better-sqlite3";
import type { Database as Db } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type EventType = "block" | "tx" | "reorg";
export type EventSource = "zmq" | "catchup";

export interface BlockEvent {
  seq: number;
  type: "block";
  ts: number;
  height: number;
  hash: string;
  source: EventSource;
}

export interface TxEvent {
  seq: number;
  type: "tx";
  ts: number;
  txid: string;
  hex: string;
  source: EventSource;
}

/**
 * Emitted when a block previously reported at some height is no longer the
 * block at that height. Consumers holding credits from the orphaned branch
 * need to know; that is the whole reason this event type exists.
 */
export interface ReorgEvent {
  seq: number;
  type: "reorg";
  ts: number;
  height: number;
  hash: string;
  orphanedHash: string;
  source: EventSource;
}

export type JournalEvent = BlockEvent | TxEvent | ReorgEvent;

interface Row {
  seq: number;
  type: EventType;
  ts: number;
  height: number | null;
  hash: string | null;
  txid: string | null;
  hex: Buffer | null;
  orphaned_hash: string | null;
  source: EventSource;
}

export class Journal {
  private readonly db: Db;

  constructor(dbPath: string) {
    const abs = resolve(dbPath);
    mkdirSync(dirname(abs), { recursive: true });

    this.db = new Database(abs);
    // WAL keeps readers (the HTTP API) off the writer's back; NORMAL trades a
    // few milliseconds of durability on power loss for throughput, which is
    // the right trade when catch-up can rebuild any lost block anyway.
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("synchronous = NORMAL");
    this.db.pragma("busy_timeout = 5000");

    this.migrate();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS events (
        seq           INTEGER PRIMARY KEY AUTOINCREMENT,
        type          TEXT    NOT NULL,
        ts            INTEGER NOT NULL,
        height        INTEGER,
        hash          TEXT,
        txid          TEXT,
        hex           BLOB,
        orphaned_hash TEXT,
        source        TEXT    NOT NULL
      );

      CREATE INDEX IF NOT EXISTS events_type_height ON events(type, height);
      CREATE INDEX IF NOT EXISTS events_type_ts     ON events(type, ts);

      -- Dedupe. A transaction announced twice, or a block seen by both the tap
      -- and catch-up, must not produce two cursor positions.
      CREATE UNIQUE INDEX IF NOT EXISTS events_txid_uniq
        ON events(txid) WHERE txid IS NOT NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS events_block_uniq
        ON events(hash) WHERE type = 'block';

      CREATE TABLE IF NOT EXISTS meta (
        k TEXT PRIMARY KEY,
        v TEXT NOT NULL
      );
    `);
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /** Returns the new seq, or null when the txid was already journalled. */
  appendTx(txid: string, hex: Buffer, source: EventSource = "zmq"): number | null {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO events (type, ts, txid, hex, source)
         VALUES ('tx', ?, ?, ?, ?)`,
      )
      .run(Date.now(), txid, hex, source);
    return info.changes === 0 ? null : Number(info.lastInsertRowid);
  }

  /** Returns the new seq, or null when this block hash was already journalled. */
  appendBlock(height: number, hash: string, source: EventSource): number | null {
    const info = this.db
      .prepare(
        `INSERT OR IGNORE INTO events (type, ts, height, hash, source)
         VALUES ('block', ?, ?, ?, ?)`,
      )
      .run(Date.now(), height, hash, source);
    return info.changes === 0 ? null : Number(info.lastInsertRowid);
  }

  appendReorg(height: number, hash: string, orphanedHash: string): number {
    const info = this.db
      .prepare(
        `INSERT INTO events (type, ts, height, hash, orphaned_hash, source)
         VALUES ('reorg', ?, ?, ?, ?, 'catchup')`,
      )
      .run(Date.now(), height, hash, orphanedHash);
    return Number(info.lastInsertRowid);
  }

  /**
   * Drops journalled blocks at or above `height`. Used when a reorg makes the
   * stored branch wrong — leaving them would let catch-up believe it is
   * already past a height it now needs to re-walk.
   */
  dropBlocksFrom(height: number): number {
    return this.db
      .prepare(`DELETE FROM events WHERE type = 'block' AND height >= ?`)
      .run(height).changes;
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  eventsSince(since: number, limit: number): JournalEvent[] {
    const rows = this.db
      .prepare(`SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?`)
      .all(since, limit) as Row[];
    return rows.map(toEvent);
  }

  tipSeq(): number {
    const row = this.db.prepare(`SELECT MAX(seq) AS s FROM events`).get() as
      | { s: number | null }
      | undefined;
    return row?.s ?? 0;
  }

  lastBlock(): { height: number; hash: string } | null {
    const row = this.db
      .prepare(
        `SELECT height, hash FROM events
         WHERE type = 'block' ORDER BY height DESC LIMIT 1`,
      )
      .get() as { height: number; hash: string } | undefined;
    return row ?? null;
  }

  blockAtHeight(height: number): { height: number; hash: string } | null {
    const row = this.db
      .prepare(`SELECT height, hash FROM events WHERE type = 'block' AND height = ?`)
      .get(height) as { height: number; hash: string } | undefined;
    return row ?? null;
  }

  /** Cursor for a consumer that only knows a block height, not a seq. */
  seqAtOrAfterHeight(height: number): number {
    const row = this.db
      .prepare(
        `SELECT MIN(seq) AS s FROM events WHERE type = 'block' AND height >= ?`,
      )
      .get(height) as { s: number | null } | undefined;
    return row?.s ?? this.tipSeq() + 1;
  }

  stats(): { events: number; txs: number; blocks: number; oldestTxTs: number | null } {
    const total = this.db.prepare(`SELECT COUNT(*) AS c FROM events`).get() as { c: number };
    const txs = this.db
      .prepare(`SELECT COUNT(*) AS c, MIN(ts) AS m FROM events WHERE type = 'tx'`)
      .get() as { c: number; m: number | null };
    const blocks = this.db
      .prepare(`SELECT COUNT(*) AS c FROM events WHERE type = 'block'`)
      .get() as { c: number };
    return { events: total.c, txs: txs.c, blocks: blocks.c, oldestTxTs: txs.m };
  }

  // ── Maintenance ───────────────────────────────────────────────────────────

  /** Removes mempool tx events older than the cutoff. Blocks are never pruned. */
  pruneTx(cutoffMs: number): number {
    return this.db
      .prepare(`DELETE FROM events WHERE type = 'tx' AND ts < ?`)
      .run(cutoffMs).changes;
  }

  getMeta(key: string): string | null {
    const row = this.db.prepare(`SELECT v FROM meta WHERE k = ?`).get(key) as
      | { v: string }
      | undefined;
    return row?.v ?? null;
  }

  setMeta(key: string, value: string): void {
    this.db
      .prepare(`INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`)
      .run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

function toEvent(row: Row): JournalEvent {
  const base = { seq: row.seq, ts: row.ts, source: row.source };
  switch (row.type) {
    case "tx":
      return {
        ...base,
        type: "tx",
        txid: row.txid ?? "",
        hex: row.hex ? row.hex.toString("hex") : "",
      };
    case "reorg":
      return {
        ...base,
        type: "reorg",
        height: row.height ?? 0,
        hash: row.hash ?? "",
        orphanedHash: row.orphaned_hash ?? "",
      };
    case "block":
    default:
      return { ...base, type: "block", height: row.height ?? 0, hash: row.hash ?? "" };
  }
}
