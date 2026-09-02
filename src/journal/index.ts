/**
 * Public surface of the journal module.
 *
 * Importing from here rather than reaching into ./journal.js keeps the
 * internal split — class, types, SQL loader — free to move without touching
 * every call site.
 */

export { Journal } from "./journal.js";
export type { WatchedInput } from "./journal.js";
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
