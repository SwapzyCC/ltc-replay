/**
 * The watchlist decides what the relay stores, so its failure modes are the
 * expensive kind — and they are asymmetric.
 *
 * Storing too much wastes disk, which an operator notices. Storing too little
 * loses a deposit, which nobody notices: an address that was never registered
 * produces no rows, no errors and no logs, and the relay reports itself
 * perfectly healthy while the payment to it goes unindexed. So these tests are
 * mostly about the second kind — that the filter keeps what it must, that the
 * list survives a restart, and that the routes which write it refuse anything
 * they cannot apply in full.
 */

import { test, before, after, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { Journal } from "../src/journal/index.js";
import { Watchlist } from "../src/services/watchlist.js";
import { Catchup } from "../src/services/catchup.js";
import { createApi } from "../src/http/server.js";
import { extractPayments } from "../src/chain/payments.js";
import { scriptToAddress, LTC_MAINNET } from "../src/chain/address.js";
import type { Config } from "../src/config/index.js";
import type { LitecoinRpc } from "../src/chain/rpc.js";
import type { Tap } from "../src/services/tap.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

/**
 * A minimal legacy transaction paying one P2WPKH output.
 *
 * Built rather than pasted so the address and the bytes cannot disagree: the
 * same decoder the relay uses derives the address from this script, which is
 * the property under test.
 */
function payTo(hash20: Buffer, valueSat = 100_000_000n): { hex: string; address: string } {
  const script = Buffer.concat([Buffer.from([0x00, 0x14]), hash20]);

  const value = Buffer.alloc(8);
  value.writeBigUInt64LE(valueSat);

  const raw = Buffer.concat([
    Buffer.from([0x01, 0x00, 0x00, 0x00]), // version 1
    Buffer.from([0x01]), // one input
    Buffer.alloc(32), // null prevout hash
    Buffer.from([0xff, 0xff, 0xff, 0xff]), // prevout index
    Buffer.from([0x00]), // empty scriptSig
    Buffer.from([0xff, 0xff, 0xff, 0xff]), // sequence
    Buffer.from([0x01]), // one output
    value,
    Buffer.from([script.length]),
    script,
    Buffer.alloc(4), // locktime
  ]);

  const address = scriptToAddress(script, LTC_MAINNET);
  assert.ok(address !== null, "fixture script must decode to an address");
  return { hex: raw.toString("hex"), address };
}

const OURS = payTo(Buffer.alloc(20, 0x11));
const THEIRS = payTo(Buffer.alloc(20, 0x22));

const dirs: string[] = [];

function freshJournal(): Journal {
  const dir = mkdtempSync(join(tmpdir(), "ltc-replay-watch-"));
  dirs.push(dir);
  return new Journal(join(dir, "journal.sqlite"));
}

function paymentsOf(hex: string): ReturnType<typeof extractPayments>["payments"] {
  return extractPayments(Buffer.from(hex, "hex")).payments;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// ── The list itself ─────────────────────────────────────────────────────────

test("re-pushing the same registry adds nothing the second time", () => {
  const j = freshJournal();
  const w = new Watchlist(j, { enabled: true });

  const rows = [{ address: OURS.address }, { address: THEIRS.address }];
  assert.equal(w.add(rows), 2);

  // The documented recovery from a rebuilt relay is "push everything again",
  // so a repeat push must be a no-op rather than an error or a duplicate.
  assert.equal(w.add(rows), 0);
  assert.equal(w.size, 2);
  assert.equal(j.countWatched(), 2);

  j.close();
});

test("the list survives a restart, because the chain cannot rebuild it", () => {
  const dir = mkdtempSync(join(tmpdir(), "ltc-replay-watch-"));
  dirs.push(dir);
  const path = join(dir, "journal.sqlite");

  const first = new Journal(path);
  new Watchlist(first, { enabled: true }).add([{ address: OURS.address, label: "user-1" }]);
  first.close();

  const second = new Journal(path);
  const reopened = new Watchlist(second, { enabled: true });

  assert.equal(reopened.size, 1);
  assert.ok(reopened.has(OURS.address));

  const [row] = second.listWatched(10, 0);
  assert.equal(row?.label, "user-1");
  assert.equal(row?.source, "api");
  second.close();
});

test("removing an address stops the filter but keeps the history", () => {
  const j = freshJournal();
  const w = new Watchlist(j, { enabled: true });
  w.add([{ address: OURS.address }]);

  j.indexAddressPayments("a".repeat(64), paymentsOf(OURS.hex));
  assert.equal(w.remove(OURS.address), true);
  assert.equal(
    w.remove(OURS.address),
    false,
    "a second removal is not an error but is not a change",
  );

  assert.equal(w.size, 0);
  // The payment was true when it was written and a reconciliation may still
  // need it; unwatching is about the future, not about erasing the past.
  assert.equal(j.addressEntries(OURS.address, 10, false).length, 1);
  j.close();
});

// ── Filtering ───────────────────────────────────────────────────────────────

test("filtering keeps payments to watched addresses and drops the rest", () => {
  const j = freshJournal();
  const w = new Watchlist(j, { enabled: true });
  w.add([{ address: OURS.address }]);

  assert.equal(w.filter(paymentsOf(OURS.hex)).length, 1);
  assert.equal(w.filter(paymentsOf(THEIRS.hex)).length, 0);

  assert.equal(w.matches(paymentsOf(OURS.hex)), true);
  assert.equal(w.matches(paymentsOf(THEIRS.hex)), false);
  j.close();
});

test("an empty watchlist matches nothing at all", () => {
  const j = freshJournal();
  const w = new Watchlist(j, { enabled: true });

  // The silent-failure case the boot warning exists for: no address is
  // watched, so no transaction is ever stored, and every other counter in
  // /v1/stats reports a healthy relay on a quiet chain.
  assert.equal(w.matches(paymentsOf(OURS.hex)), false);
  assert.equal(w.filter(paymentsOf(OURS.hex)).length, 0);
  j.close();
});

test("with filtering off every payment passes through untouched", () => {
  const j = freshJournal();
  const w = new Watchlist(j, { enabled: false });

  const payments = paymentsOf(THEIRS.hex);
  assert.equal(w.matches(payments), true);
  // The same array, not a copy: the pass-through path must not allocate per
  // transaction on a relay indexing the whole chain.
  assert.equal(w.filter(payments), payments);
  j.close();
});

// ── The routes ──────────────────────────────────────────────────────────────

const TOKEN = "test-token-that-is-long-enough-to-pass";
const TIP_HEIGHT = 2_000;

/** A node whose blocks carry one watched transaction and one that is not. */
const rpcStub = {
  getBlockCount: async () => TIP_HEIGHT,
  getBlockHash: async (h: number) => String(h).padStart(64, "0"),
  getBlockWithTxs: async (hash: string) => ({
    hash,
    height: Number.parseInt(hash, 10),
    time: 1_700_000_000,
    nTx: 2,
    previousblockhash: "0".repeat(64),
    tx: [
      { txid: extractPayments(Buffer.from(OURS.hex, "hex")).txid, hex: OURS.hex },
      { txid: extractPayments(Buffer.from(THEIRS.hex, "hex")).txid, hex: THEIRS.hex },
    ],
  }),
} as unknown as LitecoinRpc;

const tapStub = {
  getStats: () => ({
    txSeen: 0,
    txFiltered: 0,
    txJournalled: 0,
    blocksSeen: 0,
    coreGaps: 0,
    paymentsIndexed: 0,
    lastTxAt: null,
    lastBlockAt: null,
  }),
} as unknown as Tap;

let server: Server;
let apiJournal: Journal;
let apiDir: string;
let base: string;
const auth = { authorization: `Bearer ${TOKEN}` };

before(async () => {
  apiDir = mkdtempSync(join(tmpdir(), "ltc-replay-watch-api-"));
  apiJournal = new Journal(join(apiDir, "journal.sqlite"));

  const cfg = {
    authToken: TOKEN,
    txRetentionHours: 72,
    txIndexBlocks: 20_000,
    addressIndex: true,
    watchlistOnly: true,
    watchRescanMaxBlocks: 10,
  } as Config;

  const watchlist = new Watchlist(apiJournal, { enabled: true });
  const catchup = new Catchup(cfg, apiJournal, rpcStub, watchlist);

  server = createApi({
    cfg,
    journal: apiJournal,
    rpc: rpcStub,
    tap: tapStub,
    watchlist,
    catchup,
    startedAt: Date.now(),
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  apiJournal.close();
  rmSync(apiDir, { recursive: true, force: true });
});

test("the watchlist routes are closed to an unauthenticated caller", async () => {
  // A write endpoint that forgets the bearer check does not merely leak: it
  // lets a stranger decide what this relay indexes.
  const calls = [
    fetch(`${base}/v1/watch`),
    fetch(`${base}/v1/watch`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ address: OURS.address }),
    }),
    fetch(`${base}/v1/watch/${OURS.address}`, { method: "DELETE" }),
  ];

  for (const res of await Promise.all(calls)) assert.equal(res.status, 401);
});

test("POST registers an address and reports what was new", async () => {
  const post = async (body: unknown): Promise<Record<string, unknown>> => {
    const res = await fetch(`${base}/v1/watch`, {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    return (await res.json()) as Record<string, unknown>;
  };

  const first = await post({ addresses: [OURS.address], label: "deposit" });
  assert.equal(first["added"], 1);
  assert.equal(first["alreadyWatched"], 0);

  const again = await post({ addresses: [OURS.address, OURS.address] });
  assert.equal(again["requested"], 1, "duplicates within one request collapse");
  assert.equal(again["added"], 0);
  assert.equal(again["alreadyWatched"], 1);
});

test("one bad address rejects the whole push rather than half-applying it", async () => {
  const res = await fetch(`${base}/v1/watch`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ addresses: [THEIRS.address, "not-an-address"] }),
  });

  assert.equal(res.status, 400);
  // A consumer that gets a 200 must be able to conclude its whole registry is
  // watched. A partial success it has to reconcile is worse than a retry.
  const listed = await fetch(`${base}/v1/watch?limit=100`, { headers: auth });
  const body = (await listed.json()) as { addresses: Array<{ address: string }> };
  assert.ok(!body.addresses.some((a) => a.address === THEIRS.address));
});

test("a rescan larger than the configured cap is refused", async () => {
  const res = await fetch(`${base}/v1/watch`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ address: OURS.address, rescanBlocks: 5_000 }),
  });

  // Unbounded, this is a way to make the relay walk the chain on request.
  assert.equal(res.status, 400);
});

test("limit=0 answers with the count alone, which is the sync probe", async () => {
  const res = await fetch(`${base}/v1/watch?limit=0`, { headers: auth });
  assert.equal(res.status, 200);

  const body = (await res.json()) as { count: number; enabled: boolean; addresses: unknown[] };
  assert.equal(body.enabled, true);
  assert.ok(body.count >= 1);
  // The whole point is that a consumer can poll this often. Returning the
  // addresses too would make the cheap call expensive.
  assert.deepEqual(body.addresses, []);
});

test("DELETE reports whether it changed anything", async () => {
  const gone = await fetch(`${base}/v1/watch/${THEIRS.address}`, {
    method: "DELETE",
    headers: auth,
  });
  assert.equal(gone.status, 404);

  const removed = await fetch(`${base}/v1/watch/${OURS.address}`, {
    method: "DELETE",
    headers: auth,
  });
  assert.equal(removed.status, 200);
  assert.equal(((await removed.json()) as { removed: boolean }).removed, true);

  // Put it back: later tests read the stream through this address.
  await fetch(`${base}/v1/watch`, {
    method: "POST",
    headers: { ...auth, "content-type": "application/json" },
    body: JSON.stringify({ address: OURS.address }),
  });
});

test("replay streams only watched transactions, but reports the real block size", async () => {
  const res = await fetch(`${base}/v1/replay?sinceHeight=1000&maxBlocks=1`, { headers: auth });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("x-filtered"), "watchlist");

  const lines = (await res.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const block = lines[0] as { nTx: number; txs: Array<{ hex: string }> };

  assert.equal(block.txs.length, 1, "the unwatched transaction must not be sent");
  assert.equal(block.txs[0]?.hex, OURS.hex);
  // nTx stays honest so a consumer can tell a filtered block from a small one.
  assert.equal(block.nTx, 2);
  assert.equal(lines.at(-1)?.["done"], true, "the terminator is what makes a short read safe");
});

test("all=1 returns the whole block for an operator who asks for it", async () => {
  const res = await fetch(`${base}/v1/replay?sinceHeight=1000&maxBlocks=1&all=1`, {
    headers: auth,
  });
  assert.equal(res.headers.get("x-filtered"), "none");

  const first = JSON.parse((await res.text()).trim().split("\n")[0] ?? "{}") as {
    txs: unknown[];
  };
  assert.equal(first.txs.length, 2);
});

test("stats says whether filtering is on, and how many addresses it has", async () => {
  const res = await fetch(`${base}/v1/stats`, { headers: auth });
  const body = (await res.json()) as { watchlist: { enabled: boolean; count: number } };

  // Read together, these two are the difference between "the chain is quiet"
  // and "this relay is storing nothing".
  assert.equal(body.watchlist.enabled, true);
  assert.ok(body.watchlist.count >= 1);
});
