/**
 * The journal's contract is what consumers depend on for correctness:
 * cursors never go backwards, the same event is never handed out twice under
 * two sequence numbers, and a reorg actually removes the branch it orphaned
 * so catch-up re-walks it instead of believing it is already done.
 */

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Journal, type JournalEvent } from "../src/journal/index.js";

const dirs: string[] = [];

function freshJournal(): Journal {
  const dir = mkdtempSync(join(tmpdir(), "ltc-replay-test-"));
  dirs.push(dir);
  return new Journal(join(dir, "journal.sqlite"));
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

test("sequences are monotonic across event types", () => {
  const j = freshJournal();
  const a = j.appendBlock(100, "a".repeat(64), "zmq");
  const b = j.appendTx("b".repeat(64), Buffer.from([0x01]));
  const c = j.appendBlock(101, "c".repeat(64), "catchup");

  assert.ok(a !== null && b !== null && c !== null);
  assert.ok(a < b && b < c, "seq must increase");
  assert.equal(j.tipSeq(), c);
  j.close();
});

test("a repeated txid is ignored rather than given a second cursor position", () => {
  const j = freshJournal();
  const txid = "d".repeat(64);

  assert.notEqual(j.appendTx(txid, Buffer.from([0xaa])), null);
  assert.equal(j.appendTx(txid, Buffer.from([0xaa])), null, "duplicate must be dropped");
  assert.equal(j.eventsSince(0, 10).length, 1);
  j.close();
});

test("a block seen by both the tap and catch-up is journalled once", () => {
  const j = freshJournal();
  const hash = "e".repeat(64);

  assert.notEqual(j.appendBlock(500, hash, "zmq"), null);
  assert.equal(j.appendBlock(500, hash, "catchup"), null);
  assert.equal(j.stats().blocks, 1);
  j.close();
});

test("eventsSince pages without gaps or repeats", () => {
  const j = freshJournal();
  for (let i = 0; i < 25; i++) j.appendBlock(i, String(i).padStart(64, "0"), "zmq");

  const seen: number[] = [];
  let cursor = 0;
  for (;;) {
    const page = j.eventsSince(cursor, 10);
    if (page.length === 0) break;
    for (const e of page) seen.push(e.seq);
    cursor = page[page.length - 1]!.seq;
  }

  assert.equal(seen.length, 25);
  assert.deepEqual(
    seen,
    seen.toSorted((x, y) => x - y),
    "pages must stay ordered",
  );
  assert.equal(new Set(seen).size, 25, "no event may appear twice");
  j.close();
});

test("round-tripping a transaction preserves its raw bytes", () => {
  const j = freshJournal();
  const raw = Buffer.from("0100000001abcdef", "hex");
  j.appendTx("f".repeat(64), raw);

  const [event] = j.eventsSince(0, 1);
  assert.equal(event?.type, "tx");
  assert.equal(event?.type === "tx" ? event.hex : null, raw.toString("hex"));
  j.close();
});

test("a reorg drops the orphaned branch so catch-up re-walks it", () => {
  const j = freshJournal();
  j.appendBlock(10, "a".repeat(64), "zmq");
  j.appendBlock(11, "b".repeat(64), "zmq");
  j.appendBlock(12, "c".repeat(64), "zmq");
  assert.equal(j.lastBlock()?.height, 12);

  j.appendReorg(11, "x".repeat(64), "b".repeat(64));
  const removed = j.dropBlocksFrom(11);

  assert.equal(removed, 2, "heights 11 and 12 leave the journal");
  assert.equal(j.lastBlock()?.height, 10, "catch-up resumes from the fork point");

  // The reorg record itself survives — it is the consumer's only notice.
  const reorgs = j.eventsSince(0, 100).filter((e: JournalEvent) => e.type === "reorg");
  assert.equal(reorgs.length, 1);
  j.close();
});

test("pruning removes aged transactions and never blocks", () => {
  const j = freshJournal();
  j.appendBlock(1, "a".repeat(64), "zmq");
  j.appendTx("b".repeat(64), Buffer.from([0x01]));

  const removed = j.pruneTx(Date.now() + 60_000); // cutoff in the future: prune all
  assert.equal(removed, 1);

  const stats = j.stats();
  assert.equal(stats.txs, 0);
  assert.equal(stats.blocks, 1, "block history is permanent");
  j.close();
});

test("seqAtOrAfterHeight maps a height cursor onto a seq cursor", () => {
  const j = freshJournal();
  const first = j.appendBlock(700, "a".repeat(64), "zmq");
  j.appendBlock(701, "b".repeat(64), "zmq");

  assert.equal(j.seqAtOrAfterHeight(700), first);
  // Past the tip, the cursor points at the next event to be written.
  assert.equal(j.seqAtOrAfterHeight(9_999), j.tipSeq() + 1);
  j.close();
});
