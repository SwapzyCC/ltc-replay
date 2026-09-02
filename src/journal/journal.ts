/**
 * The durable event log, and the two indexes derived from it.
 *
 * Four kinds of record live here and they are deliberately not treated alike:
 *
 *   block       — permanent. A few dozen bytes each, ~576 a day. This is what
 *                 makes a missed deposit recoverable: whatever a consumer
 *                 failed to see in the mempool is still sitting in a block, and
 *                 the block record says exactly which blocks it has not looked
 *                 at yet.
 *
 *   tx          — retention-bounded. A raw mempool sighting is a latency
 *                 optimisation, not a source of truth. Keeping a few days of
 *                 them lets a consumer restore its pending set after a short
 *                 restart; past that, correctness comes from blocks.
 *
 *   block_txs   — which transactions were in which block. The relay's stand-in
 *                 for Core's `txindex`, which a pruned node is not permitted to
 *                 run, and the only way a consumer can ask "did this confirm?"
 *                 about an address the node does not watch.
 *
 *   address_txs — which addresses each transaction paid. Answers the question a
 *                 deposit monitor actually has, without the consumer having to
 *                 scan every block itself.
 *
 * `seq` is the consumer cursor. AUTOINCREMENT means it is monotonic and never
 * reused, so "give me everything after N" is unambiguous across restarts.
 *
 * The SQL lives in ./sql/*.sql. This file holds only the logic that decides
 * when to run it.
 *
 * On performance: every statement is prepared once in the constructor rather
 * than on each call, and multi-row writes run inside a single transaction.
 * Both matter — indexing a block is hundreds of inserts, and a per-row
 * transaction would mean hundreds of WAL commits for one block.
 */

import Database from "better-sqlite3";
import type { Database as Db, Statement } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { loadSchema, loadQueries, QUERY_NAMES, type QueryName } from "./sql/index.js";
import type {
  AddressEntry,
  AddressPayment,
  AddressRow,
  BlockRef,
  EventRow,
  EventSource,
  JournalEvent,
  JournalStats,
  MinedTx,
  WatchedAddress,
} from "./types.js";

export type {
  AddressEntry,
  AddressPayment,
  BlockEvent,
  BlockRef,
  EventSource,
  EventType,
  JournalEvent,
  JournalStats,
  MinedTx,
  ReorgEvent,
  TxEvent,
  WatchedAddress,
} from "./types.js";

/** What `addWatched` accepts. The label is free text for operators. */
export interface WatchedInput {
  address: string;
  label?: string | null;
}

export class Journal {
  private readonly db: Db;

  /**
   * Statements are prepared once. better-sqlite3 compiles on prepare, so
   * re-preparing inside a hot loop is pure overhead — and indexing a single
   * block runs that loop a few hundred times.
   */
  private readonly stmt: Record<QueryName, Statement>;

  private readonly writeBlockTxs: (
    height: number,
    hash: string,
    txids: readonly string[],
  ) => number;

  private readonly writeAddressTxs: (
    txid: string,
    ts: number,
    payments: readonly AddressPayment[],
  ) => number;

  private readonly writeWatched: (rows: readonly WatchedInput[], source: string) => number;

  private readonly dropFrom: (height: number) => number;

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
    // 64 MB of page cache and memory-backed temp tables. The index tables are
    // the only ones large enough to care, and they are exactly the ones the
    // address and confirmation lookups hit.
    this.db.pragma("cache_size = -64000");
    this.db.pragma("temp_store = MEMORY");
    this.db.pragma("foreign_keys = ON");

    this.db.exec(loadSchema());

    const sql = loadQueries();
    const stmt = {} as Record<QueryName, Statement>;
    for (const name of QUERY_NAMES) stmt[name] = this.db.prepare(sql[name]);
    this.stmt = stmt;

    // Transactions are built once too. better-sqlite3 wraps them in savepoints
    // at construction, so building one per call would allocate on every block.
    this.writeBlockTxs = this.db.transaction(
      (height: number, hash: string, txids: readonly string[]): number => {
        const ts = Date.now();
        let n = 0;
        for (const txid of txids) n += this.stmt.insertBlockTx.run(txid, height, hash, ts).changes;
        return n;
      },
    );

    this.writeAddressTxs = this.db.transaction(
      (txid: string, ts: number, payments: readonly AddressPayment[]): number => {
        let n = 0;
        for (const p of payments) {
          n += this.stmt.insertAddressTx.run(p.address, txid, p.vout, p.valueSat, ts).changes;
        }
        return n;
      },
    );

    // A consumer re-pushing its whole registry after a rebuild sends tens of
    // thousands of addresses. One transaction, not one commit per address.
    this.writeWatched = this.db.transaction(
      (rows: readonly WatchedInput[], source: string): number => {
        const ts = Date.now();
        let n = 0;
        for (const r of rows) {
          n += this.stmt.insertWatched.run(r.address, r.label ?? null, ts, source).changes;
        }
        return n;
      },
    );

    this.dropFrom = this.db.transaction((height: number): number => {
      this.stmt.deleteBlockTxsFrom.run(height);
      return this.stmt.deleteBlocksFrom.run(height).changes;
    });
  }

  // ── Writes ────────────────────────────────────────────────────────────────

  /** Returns the new seq, or null when the txid was already journalled. */
  appendTx(txid: string, hex: Buffer, source: EventSource = "zmq"): number | null {
    const info = this.stmt.insertTx.run(Date.now(), txid, hex, source);
    return info.changes === 0 ? null : Number(info.lastInsertRowid);
  }

  /** Returns the new seq, or null when this block hash was already journalled. */
  appendBlock(height: number, hash: string, source: EventSource): number | null {
    const info = this.stmt.insertBlock.run(Date.now(), height, hash, source);
    return info.changes === 0 ? null : Number(info.lastInsertRowid);
  }

  appendReorg(height: number, hash: string, orphanedHash: string): number {
    const info = this.stmt.insertReorg.run(Date.now(), height, hash, orphanedHash);
    return Number(info.lastInsertRowid);
  }

  /**
   * Records which block a set of transactions was mined in. Written as one
   * transaction so a crash mid-block cannot leave a block indexed by half its
   * contents — a consumer would then read "not mined" for a deposit that is,
   * and go on waiting for a confirmation that already happened.
   */
  indexBlockTxs(height: number, hash: string, txids: readonly string[]): number {
    return this.writeBlockTxs(height, hash, txids);
  }

  /**
   * Records the addresses one transaction paid. Idempotent: the same
   * transaction seen first in the mempool and again in a block writes the same
   * rows, so the two sightings collapse rather than double-counting.
   */
  indexAddressPayments(txid: string, payments: readonly AddressPayment[], ts = Date.now()): number {
    if (payments.length === 0) return 0;
    return this.writeAddressTxs(txid, ts, payments);
  }

  /**
   * Drops journalled blocks at or above `height`, together with the index
   * entries that came from them. Used when a reorg makes the stored branch
   * wrong — leaving the blocks would let catch-up believe it is already past a
   * height it now needs to re-walk, and leaving the index entries would let
   * /v1/tx keep reporting an orphaned block as the one that confirmed a
   * deposit.
   *
   * Address rows are deliberately left alone: the transaction still paid that
   * address, and whether it is confirmed is derived from the block index at
   * read time. Deleting them would lose a payment that is about to be mined
   * again on the winning branch.
   */
  dropBlocksFrom(height: number): number {
    return this.dropFrom(height);
  }

  // ── Reads ─────────────────────────────────────────────────────────────────

  eventsSince(since: number, limit: number): JournalEvent[] {
    return (this.stmt.eventsSince.all(since, limit) as EventRow[]).map(toEvent);
  }

  tipSeq(): number {
    const row = this.stmt.tipSeq.get() as { s: number | null } | undefined;
    return row?.s ?? 0;
  }

  lastBlock(): BlockRef | null {
    return (this.stmt.lastBlock.get() as BlockRef | undefined) ?? null;
  }

  blockAtHeight(height: number): BlockRef | null {
    return (this.stmt.blockAtHeight.get(height) as BlockRef | undefined) ?? null;
  }

  /** Cursor for a consumer that only knows a block height, not a seq. */
  seqAtOrAfterHeight(height: number): number {
    const row = this.stmt.seqAtOrAfterHeight.get(height) as { s: number | null } | undefined;
    return row?.s ?? this.tipSeq() + 1;
  }

  /** Where a transaction was mined, on the branch the journal currently holds. */
  findTx(txid: string): MinedTx | null {
    return (this.stmt.findTx.get(txid) as MinedTx | undefined) ?? null;
  }

  /**
   * A raw mempool sighting, if one is still inside retention. Separate from
   * `findTx` because the two answer different questions: this one says the
   * network has seen it, not that it is in a block.
   */
  findTxEvent(txid: string): { txid: string; ts: number } | null {
    return (this.stmt.findTxEvent.get(txid) as { txid: string; ts: number } | undefined) ?? null;
  }

  /**
   * Lowest height the transaction index covers. Without it a lookup miss is
   * ambiguous — "this was never mined" and "this is older than my window" are
   * very different answers for a consumer deciding whether to credit.
   */
  txIndexFloor(): number | null {
    const row = this.stmt.txIndexFloor.get() as { h: number | null } | undefined;
    return row?.h ?? null;
  }

  /**
   * Every output paying an address, newest first, with its block resolved
   * where there is one. Unconfirmed entries sort first: they are what a caller
   * polling for a deposit is waiting on.
   */
  addressEntries(address: string, limit: number, includeHex: boolean): AddressEntry[] {
    const rows = this.stmt.addressEntries.all(address, limit) as AddressRow[];
    return rows.map((r) => ({
      txid: r.txid,
      vout: r.vout,
      valueSat: r.value,
      firstSeenAt: r.ts,
      blockHeight: r.height,
      blockHash: r.hash,
      hex: includeHex && r.hex ? r.hex.toString("hex") : null,
    }));
  }

  addressEntryCount(address: string): number {
    const row = this.stmt.addressCount.get(address) as { c: number } | undefined;
    return row?.c ?? 0;
  }

  stats(): JournalStats {
    const total = this.stmt.countEvents.get() as { c: number };
    const txs = this.stmt.countTxs.get() as { c: number; m: number | null };
    const blocks = this.stmt.countBlocks.get() as { c: number };
    const indexed = this.stmt.countBlockTxs.get() as { c: number; h: number | null };
    const addresses = this.stmt.countAddressTxs.get() as { c: number; a: number };
    const watched = this.stmt.countWatched.get() as { c: number };

    const pageCount = (this.db.pragma("page_count", { simple: true }) as number) || 0;
    const pageSize = (this.db.pragma("page_size", { simple: true }) as number) || 0;

    return {
      events: total.c,
      txs: txs.c,
      blocks: blocks.c,
      oldestTxTs: txs.m,
      indexedTxs: indexed.c,
      indexedOutputs: addresses.c,
      indexedAddresses: addresses.a,
      indexFloorHeight: indexed.h,
      watchedAddresses: watched.c,
      sizeBytes: pageCount * pageSize,
    };
  }

  // ── Watchlist ─────────────────────────────────────────────────────────────

  /**
   * Adds addresses to the watchlist. Returns how many were new.
   *
   * Idempotent, and deliberately so: the documented recovery from a rebuilt
   * journal is for the consumer to re-push its entire address registry, and
   * that must not reset every added_at or fail on the first duplicate.
   */
  addWatched(rows: readonly WatchedInput[], source = "api"): number {
    if (rows.length === 0) return 0;
    return this.writeWatched(rows, source);
  }

  /** Returns true when the address was on the list. */
  removeWatched(address: string): boolean {
    return this.stmt.deleteWatched.run(address).changes > 0;
  }

  /** The whole list, for loading the in-memory set the hot path checks. */
  allWatched(): string[] {
    return (this.stmt.allWatched.all() as Array<{ address: string }>).map((r) => r.address);
  }

  listWatched(limit: number, offset: number): WatchedAddress[] {
    const rows = this.stmt.listWatched.all(limit, offset) as Array<{
      address: string;
      label: string | null;
      added_at: number;
      source: string;
    }>;
    return rows.map((r) => ({
      address: r.address,
      label: r.label,
      addedAt: r.added_at,
      source: r.source,
    }));
  }

  countWatched(): number {
    return (this.stmt.countWatched.get() as { c: number }).c;
  }

  // ── Maintenance ───────────────────────────────────────────────────────────

  /** Removes mempool tx events older than the cutoff. Blocks are never pruned. */
  pruneTx(cutoffMs: number): number {
    return this.stmt.pruneTx.run(cutoffMs).changes;
  }

  /**
   * Trims the transaction index to a depth below the tip. Blocks themselves
   * stay — they are tiny and they are the replay cursor — but the per-txid
   * rows are the bulk of the database, and they only matter while a consumer
   * might still be asking whether something confirmed.
   */
  pruneBlockTxs(belowHeight: number): number {
    return this.stmt.pruneBlockTxs.run(belowHeight).changes;
  }

  /**
   * Removes address rows for transactions that were seen in the mempool before
   * the cutoff and never made it into a block — replaced by a fee bump,
   * conflicted, or simply dropped. Rows whose transaction *is* in the block
   * index are kept and age out with it, so a confirmed deposit never
   * disappears from an address query while it is still answerable.
   */
  pruneAddressTxs(cutoffMs: number): number {
    return this.stmt.pruneAddressTxs.run(cutoffMs).changes;
  }

  /** Reclaims free pages left by pruning. Cheap, incremental, safe to skip. */
  checkpoint(): void {
    this.db.pragma("wal_checkpoint(TRUNCATE)");
  }

  getMeta(key: string): string | null {
    const row = this.stmt.getMeta.get(key) as { v: string } | undefined;
    return row?.v ?? null;
  }

  setMeta(key: string, value: string): void {
    this.stmt.setMeta.run(key, value);
  }

  close(): void {
    this.db.close();
  }
}

/**
 * Widens a row into the discriminated union consumers see.
 *
 * The nullish fallbacks are for the type checker rather than for reality: the
 * schema allows a NULL height on a tx row, and TypeScript is right to insist
 * the block branch account for it.
 */
function toEvent(row: EventRow): JournalEvent {
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
