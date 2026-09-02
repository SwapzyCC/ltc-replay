-- ltc-replay journal schema.
--
-- Applied on every boot. Every statement is IF NOT EXISTS, so this doubles as
-- the migration: adding a table or an index here is picked up on restart with
-- no separate step and no migration table to get out of sync with reality.
--
-- Kept as SQL rather than embedded in TypeScript so it can be read, diffed and
-- run against a live database with the sqlite3 CLI when something needs
-- explaining at three in the morning.

-- ── events ──────────────────────────────────────────────────────────────────
--
-- The durable log, and the consumer cursor. `seq` is AUTOINCREMENT, so it is
-- monotonic and never reused: "give me everything after N" is unambiguous
-- across restarts of either side.
--
-- Three record types share the table because they share the cursor. Splitting
-- them would mean a consumer tracking three positions and merging them in
-- order, which is the one thing a replay log exists to avoid.
CREATE TABLE IF NOT EXISTS events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  type          TEXT    NOT NULL,  -- 'block' | 'tx' | 'reorg'
  ts            INTEGER NOT NULL,  -- epoch ms, when the relay saw it
  height        INTEGER,           -- block, reorg
  hash          TEXT,              -- block, reorg
  txid          TEXT,              -- tx
  hex           BLOB,              -- tx: the raw serialisation as published
  orphaned_hash TEXT,              -- reorg: the branch that lost
  source        TEXT    NOT NULL   -- 'zmq' | 'catchup'
);

CREATE INDEX IF NOT EXISTS events_type_height ON events(type, height);
CREATE INDEX IF NOT EXISTS events_type_ts     ON events(type, ts);

-- Dedupe. A transaction announced twice, or a block seen by both the tap and
-- catch-up, must not produce two cursor positions — a consumer would process
-- it twice and, if it credits on sight, credit it twice.
CREATE UNIQUE INDEX IF NOT EXISTS events_txid_uniq
  ON events(txid) WHERE txid IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS events_block_uniq
  ON events(hash) WHERE type = 'block';

-- ── block_txs ───────────────────────────────────────────────────────────────
--
-- The relay's own transaction index: which transactions were in which block.
--
-- This exists because Litecoin Core refuses to run `txindex` together with
-- `prune` — the options are mutually exclusive. Without txindex,
-- `getrawtransaction` cannot resolve a confirmed transaction belonging to no
-- loaded wallet, which is exactly what a deposit to a watch-only address is.
--
-- Keyed by (txid, hash) rather than txid alone: across a reorg the same
-- transaction legitimately appears under two block hashes, and collapsing them
-- would hide the branch a consumer needs to know about.
--
-- WITHOUT ROWID because the primary key *is* the row. The default layout would
-- store a separate rowid plus a second B-tree to reach it, on what is by far
-- the largest table here.
CREATE TABLE IF NOT EXISTS block_txs (
  txid   TEXT    NOT NULL,
  height INTEGER NOT NULL,
  hash   TEXT    NOT NULL,
  ts     INTEGER NOT NULL,
  PRIMARY KEY (txid, hash)
) WITHOUT ROWID;

-- Pruning trims by height, and so does the index-floor query.
CREATE INDEX IF NOT EXISTS block_txs_height ON block_txs(height);

-- ── address_txs ─────────────────────────────────────────────────────────────
--
-- Which addresses each transaction paid, and how much.
--
-- Outputs only. An input names its source by outpoint, and resolving one to an
-- address means reading the transaction it spends — which a pruned node may no
-- longer hold. "What did this address receive" is the question a deposit
-- monitor asks, so the limit costs it nothing.
--
-- The (address, txid, vout) key is what makes mempool and confirmed sightings
-- collapse: both paths decode with the same function, so the second write is a
-- no-op rather than a duplicate credit.
--
-- `value` is litoshis in an INTEGER column — SQLite integers are 64-bit, so
-- this is exact. It is read back with CAST(... AS TEXT) so it never passes
-- through a JS number.
CREATE TABLE IF NOT EXISTS address_txs (
  address TEXT    NOT NULL,
  txid    TEXT    NOT NULL,
  vout    INTEGER NOT NULL,
  value   INTEGER NOT NULL,
  ts      INTEGER NOT NULL,
  PRIMARY KEY (address, txid, vout)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS address_txs_txid ON address_txs(txid);
CREATE INDEX IF NOT EXISTS address_txs_ts   ON address_txs(ts);

-- ── meta ────────────────────────────────────────────────────────────────────
--
-- Small operational state that must survive a restart: the catch-up cursor,
-- and the schema marker.
CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- ── watched_addresses ───────────────────────────────────────────────────────
--
-- The addresses this relay actually cares about.
--
-- Indexing every addressable output on the chain costs roughly 1.5 KB per
-- transaction and answers a question nobody asked: a deposit monitor watches a
-- known set of addresses, and everything else on the chain is noise it pays to
-- store. With WATCHLIST_ONLY on, a transaction that pays nothing in this table
-- is dropped before it is journalled, indexed or re-published.
--
-- This table is the one part of the journal that is NOT reconstructible from
-- the chain. It is a cache of the consumer's own address registry, and the
-- consumer is expected to re-push it after a rebuild — see /v1/watch and the
-- sync loop in the integration guide. `source` records who put it here so an
-- operator can tell a manual entry from a synced one.
CREATE TABLE IF NOT EXISTS watched_addresses (
  address  TEXT    NOT NULL PRIMARY KEY,
  label    TEXT,
  added_at INTEGER NOT NULL,
  source   TEXT    NOT NULL DEFAULT 'api'
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS watched_added_at ON watched_addresses(added_at);
