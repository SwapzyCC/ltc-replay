-- Named statements, prepared once at boot.
--
-- Format: each query is introduced by a `-- name: <identifier>` line and runs
-- until the next one. The loader in ./index.ts checks that every name the
-- journal expects is present and that nothing here is unclaimed, so a typo is
-- a startup failure rather than a route that throws on its first request.
--
-- Kept out of the TypeScript so the queries can be pasted straight into the
-- sqlite3 CLI against a live journal — which is how most questions about this
-- service actually get answered.

-- ── Writes ──────────────────────────────────────────────────────────────────

-- name: insertTx
-- OR IGNORE, not OR REPLACE: the first sighting's timestamp is the one worth
-- keeping, and replacing would burn a new seq and replay the transaction to
-- every consumer a second time.
INSERT OR IGNORE INTO events (type, ts, txid, hex, source)
VALUES ('tx', ?, ?, ?, ?);

-- name: insertBlock
INSERT OR IGNORE INTO events (type, ts, height, hash, source)
VALUES ('block', ?, ?, ?, ?);

-- name: insertReorg
INSERT INTO events (type, ts, height, hash, orphaned_hash, source)
VALUES ('reorg', ?, ?, ?, ?, 'catchup');

-- name: insertBlockTx
INSERT OR IGNORE INTO block_txs (txid, height, hash, ts) VALUES (?, ?, ?, ?);

-- name: insertAddressTx
INSERT OR IGNORE INTO address_txs (address, txid, vout, value, ts)
VALUES (?, ?, ?, ?, ?);

-- name: deleteBlocksFrom
DELETE FROM events WHERE type = 'block' AND height >= ?;

-- name: deleteBlockTxsFrom
DELETE FROM block_txs WHERE height >= ?;

-- ── Cursor reads ────────────────────────────────────────────────────────────

-- name: eventsSince
SELECT * FROM events WHERE seq > ? ORDER BY seq ASC LIMIT ?;

-- name: tipSeq
SELECT MAX(seq) AS s FROM events;

-- name: lastBlock
SELECT height, hash FROM events WHERE type = 'block' ORDER BY height DESC LIMIT 1;

-- name: blockAtHeight
SELECT height, hash FROM events WHERE type = 'block' AND height = ?;

-- name: seqAtOrAfterHeight
SELECT MIN(seq) AS s FROM events WHERE type = 'block' AND height >= ?;

-- ── Transaction lookups ─────────────────────────────────────────────────────

-- name: findTx
-- The join against block events is what excludes orphaned branches: a reorg
-- deletes the block event, so its transactions stop resolving here even before
-- the index rows themselves are trimmed. ORDER BY height DESC picks the
-- winning branch when a transaction was mined on more than one.
SELECT b.txid, b.height, b.hash, b.ts
FROM block_txs b
JOIN events e ON e.type = 'block' AND e.hash = b.hash
WHERE b.txid = ?
ORDER BY b.height DESC
LIMIT 1;

-- name: findTxEvent
SELECT txid, ts FROM events WHERE type = 'tx' AND txid = ?;

-- name: txIndexFloor
SELECT MIN(height) AS h FROM block_txs;

-- ── Address lookups ─────────────────────────────────────────────────────────

-- name: addressEntries
-- Every output paying an address, with its block resolved where there is one.
--
-- The block join is a subquery rather than a direct join so that an unmined
-- payment still produces a row: LEFT JOIN over the pair keeps mempool entries
-- in the result with NULL height, which is the state a caller polling for a
-- deposit most wants to see.
--
-- Ordering puts unconfirmed first — COALESCE lifts a NULL height above every
-- real one — then newest block, then vout so a transaction paying an address
-- twice comes back in a stable order.
SELECT a.txid,
       a.vout,
       CAST(a.value AS TEXT) AS value,
       a.ts,
       m.height AS height,
       m.hash   AS hash,
       t.hex    AS hex
FROM address_txs a
LEFT JOIN (
  SELECT b.txid AS txid, b.height AS height, b.hash AS hash
  FROM block_txs b
  JOIN events e ON e.type = 'block' AND e.hash = b.hash
) m ON m.txid = a.txid
LEFT JOIN events t ON t.type = 'tx' AND t.txid = a.txid
WHERE a.address = ?
ORDER BY COALESCE(m.height, 9223372036854775807) DESC, a.ts DESC, a.vout ASC
LIMIT ?;

-- name: addressCount
SELECT COUNT(*) AS c FROM address_txs WHERE address = ?;

-- ── Maintenance ─────────────────────────────────────────────────────────────

-- name: pruneTx
DELETE FROM events WHERE type = 'tx' AND ts < ?;

-- name: pruneBlockTxs
DELETE FROM block_txs WHERE height < ?;

-- name: pruneAddressTxs
-- Only rows whose transaction never reached a block: fee-bumped, conflicted,
-- or simply dropped. A confirmed payment stays queryable for as long as the
-- block index can still answer for it.
DELETE FROM address_txs
WHERE ts < ? AND txid NOT IN (SELECT txid FROM block_txs);

-- ── Statistics ──────────────────────────────────────────────────────────────

-- name: countEvents
SELECT COUNT(*) AS c FROM events;

-- name: countTxs
SELECT COUNT(*) AS c, MIN(ts) AS m FROM events WHERE type = 'tx';

-- name: countBlocks
SELECT COUNT(*) AS c FROM events WHERE type = 'block';

-- name: countBlockTxs
SELECT COUNT(*) AS c, MIN(height) AS h FROM block_txs;

-- name: countAddressTxs
SELECT COUNT(*) AS c, COUNT(DISTINCT address) AS a FROM address_txs;

-- ── Meta ────────────────────────────────────────────────────────────────────

-- name: getMeta
SELECT v FROM meta WHERE k = ?;

-- name: setMeta
INSERT INTO meta (k, v) VALUES (?, ?)
ON CONFLICT(k) DO UPDATE SET v = excluded.v;
