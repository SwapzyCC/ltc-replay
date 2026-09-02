/**
 * The journal's data shapes.
 *
 * Split out from the class so consumers — routes, the tap, catch-up, the
 * client library — can import a type without pulling in better-sqlite3.
 */

export type EventType = "block" | "tx" | "reorg";

/** Where a record came from. Useful when reasoning about a gap after the fact. */
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
  /** The raw transaction, hex-encoded, exactly as Core published it. */
  hex: string;
  source: EventSource;
}

export interface ReorgEvent {
  seq: number;
  type: "reorg";
  ts: number;
  height: number;
  hash: string;
  /** The block hash that lost. A consumer holding it must undo its effects. */
  orphanedHash: string;
  source: EventSource;
}

export type JournalEvent = BlockEvent | TxEvent | ReorgEvent;

export interface BlockRef {
  height: number;
  hash: string;
}

export interface MinedTx {
  txid: string;
  height: number;
  hash: string;
  ts: number;
}

export interface AddressEntry {
  txid: string;
  vout: number;
  /** Litoshis, as a string — 8-byte values do not fit a JS number safely. */
  valueSat: string;
  firstSeenAt: number;
  /** Null while the payment is unconfirmed. */
  blockHeight: number | null;
  blockHash: string | null;
  /** The raw transaction, when the caller asked for it and it is still retained. */
  hex: string | null;
}

/** One output of one transaction, as the decoder produces it. */
export interface AddressPayment {
  address: string;
  vout: number;
  valueSat: bigint;
}

/** One row of the watchlist, as /v1/watch reports it. */
export interface WatchedAddress {
  address: string;
  label: string | null;
  addedAt: number;
  /** Who put it here: "api" for a consumer push, "manual" for an operator. */
  source: string;
}

export interface JournalStats {
  events: number;
  txs: number;
  blocks: number;
  oldestTxTs: number | null;
  indexedTxs: number;
  indexedOutputs: number;
  indexedAddresses: number;
  indexFloorHeight: number | null;
  watchedAddresses: number;
  sizeBytes: number;
}

/** A raw `events` row, as SQLite hands it back. */
export interface EventRow {
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

/** A raw row from the `addressEntries` query. */
export interface AddressRow {
  txid: string;
  vout: number;
  value: string;
  ts: number;
  height: number | null;
  hash: string | null;
  hex: Buffer | null;
}
