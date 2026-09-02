/**
 * Two behaviours in the API carry real consequences if they regress:
 *
 *   Auth — the replay history maps every watched address to its funding
 *          transactions. A route that forgets the bearer check leaks it.
 *
 *   The stream terminator — `/v1/replay` answers 200 and then streams. A
 *          truncated response and a complete one are otherwise identical, and
 *          a consumer mistaking one for the other advances its cursor past
 *          blocks it never received. The `done` line is what distinguishes
 *          them, so it is asserted explicitly.
 *
 * The node is stubbed: these assertions are about the HTTP contract, not
 * about Core.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";

import { createApi } from "../src/http/server.js";
import { Watchlist } from "../src/services/watchlist.js";
import { Catchup } from "../src/services/catchup.js";
import { Journal } from "../src/journal/index.js";
import type { Config } from "../src/config/index.js";
import type { LitecoinRpc } from "../src/chain/rpc.js";
import type { Tap } from "../src/services/tap.js";

const TOKEN = "test-token-that-is-long-enough-to-pass";
const TIP_HEIGHT = 1_005;

/** A watched address with one mined payment and one still in the mempool. */
const ADDRESS = "ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kgmn4n9";
const MINED_TXID = "b".repeat(64);
const MEMPOOL_TXID = "c".repeat(64);
const BLOCK_HASH = "f".repeat(64);
const BLOCK_HEIGHT = 1_000;

let server: Server;
let journal: Journal;
let base: string;
let dir: string;

/** A node that always answers, with deterministic hashes and one tx per block. */
const rpcStub = {
  getBlockCount: async () => TIP_HEIGHT,
  getBlockHash: async (h: number) => String(h).padStart(64, "0"),
  getBlockWithTxs: async (hash: string) => ({
    hash,
    height: Number.parseInt(hash, 10),
    time: 1_700_000_000,
    nTx: 1,
    previousblockhash: "0".repeat(64),
    tx: [{ txid: "a".repeat(64), hex: "0100000001" }],
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

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "ltc-replay-api-"));
  journal = new Journal(join(dir, "journal.sqlite"));
  journal.appendBlock(BLOCK_HEIGHT, BLOCK_HASH, "zmq");

  // One payment already mined, one still unconfirmed, both to the same address
  // — the state a deposit monitor is usually in.
  journal.indexBlockTxs(BLOCK_HEIGHT, BLOCK_HASH, [MINED_TXID]);
  journal.indexAddressPayments(MINED_TXID, [{ address: ADDRESS, vout: 0, valueSat: 150_000_000n }]);

  journal.appendTx(MEMPOOL_TXID, Buffer.from("0100000001", "hex"));
  journal.indexAddressPayments(MEMPOOL_TXID, [
    { address: ADDRESS, vout: 1, valueSat: 25_000_000n },
  ]);

  const cfg = {
    authToken: TOKEN,
    txRetentionHours: 72,
    txIndexBlocks: 20_000,
    addressIndex: true,
    // Filtering off, so these tests exercise the routes rather than the
    // watchlist. Its own behaviour is covered in watchlist.test.ts.
    watchlistOnly: false,
    watchRescanMaxBlocks: 2_000,
  } as Config;

  const watchlist = new Watchlist(journal, { enabled: cfg.watchlistOnly });
  const catchup = new Catchup(cfg, journal, rpcStub, watchlist);

  server = createApi({
    cfg,
    journal,
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
  journal.close();
  rmSync(dir, { recursive: true, force: true });
});

const auth = { authorization: `Bearer ${TOKEN}` };

test("health needs no credential and discloses nothing about the chain", async () => {
  const res = await fetch(`${base}/health`);
  assert.equal(res.status, 200);

  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body["ok"], true);
  for (const leak of ["height", "hash", "journal", "node"]) {
    assert.equal(body[leak], undefined, `/health must not expose ${leak}`);
  }
});

test("every data route rejects a missing or wrong token", async () => {
  const routes = [
    "/v1/tip",
    "/v1/events",
    "/v1/stats",
    "/v1/replay?sinceHeight=1000",
    `/v1/tx/${MINED_TXID}`,
    `/v1/address/${ADDRESS}`,
  ];

  for (const route of routes) {
    assert.equal((await fetch(`${base}${route}`)).status, 401, `${route} unauthenticated`);

    const wrong = await fetch(`${base}${route}`, { headers: { authorization: "Bearer nope" } });
    assert.equal(wrong.status, 401, `${route} with a wrong token`);
  }
});

test("tip reports the journal cursor and the lag behind the node", async () => {
  const res = await fetch(`${base}/v1/tip`, { headers: auth });
  assert.equal(res.status, 200);

  const body = (await res.json()) as {
    journal: { height: number };
    node: { height: number };
    lagBlocks: number;
  };
  assert.equal(body.journal.height, 1_000);
  assert.equal(body.node.height, TIP_HEIGHT);
  assert.equal(body.lagBlocks, 5);
});

test("replay streams the missing blocks and terminates explicitly", async () => {
  const res = await fetch(`${base}/v1/replay?sinceHeight=1000&maxBlocks=3`, { headers: auth });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type") ?? "", /ndjson/);

  const lines = (await res.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

  const blocks = lines.filter((l) => l["done"] !== true);
  assert.deepEqual(
    blocks.map((b) => b["height"]),
    [1_001, 1_002, 1_003],
  );
  assert.ok(Array.isArray(blocks[0]?.["txs"]), "blocks carry their transactions");

  const done = lines.at(-1);
  assert.equal(done?.["done"], true, "the stream must end with a terminator");
  assert.equal(done?.["nextHeight"], 1_003);
  assert.equal(done?.["hasMore"], true, "more blocks remain below the tip");
});

test("replay reports no more work once it reaches the tip", async () => {
  const res = await fetch(`${base}/v1/replay?sinceHeight=${TIP_HEIGHT - 1}&maxBlocks=10`, {
    headers: auth,
  });
  const lines = (await res.text())
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  const done = lines.at(-1);

  assert.equal(done?.["done"], true);
  assert.equal(done?.["hasMore"], false);
  assert.equal(done?.["nextHeight"], TIP_HEIGHT);
});

test("replay requires sinceHeight and rejects a malformed one", async () => {
  assert.equal((await fetch(`${base}/v1/replay`, { headers: auth })).status, 400);
  assert.equal((await fetch(`${base}/v1/replay?sinceHeight=abc`, { headers: auth })).status, 400);
});

test("events paginate from a cursor", async () => {
  const res = await fetch(`${base}/v1/events?since=0&limit=10`, { headers: auth });
  const body = (await res.json()) as { events: unknown[]; next: number; hasMore: boolean };

  // The fixture journals one block and one mempool transaction.
  assert.equal(body.events.length, 2);
  assert.equal(body.hasMore, false);
  assert.ok(body.next > 0);
});

test("unknown routes and non-GET methods are refused", async () => {
  assert.equal((await fetch(`${base}/v1/nope`, { headers: auth })).status, 404);
  assert.equal((await fetch(`${base}/v1/tip`, { method: "POST", headers: auth })).status, 405);
});

// ── /v1/tx ───────────────────────────────────────────────────────────────────────

test("tx reports a mined transaction with its depth", async () => {
  const res = await fetch(`${base}/v1/tx/${MINED_TXID}`, { headers: auth });
  assert.equal(res.status, 200);

  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body["status"], "mined");
  assert.equal(body["blockHeight"], BLOCK_HEIGHT);
  assert.equal(body["blockHash"], BLOCK_HASH);
  // Inclusive of its own block: 1005 - 1000 + 1.
  assert.equal(body["confirmations"], 6);
});

test("tx distinguishes an unconfirmed sighting from an unknown transaction", async () => {
  const seen = await fetch(`${base}/v1/tx/${MEMPOOL_TXID}`, { headers: auth });
  assert.equal(seen.status, 200);
  const seenBody = (await seen.json()) as Record<string, unknown>;
  assert.equal(seenBody["status"], "mempool");
  assert.equal(seenBody["confirmations"], 0);
  assert.equal(seenBody["blockHeight"], null);

  const missing = await fetch(`${base}/v1/tx/${"d".repeat(64)}`, { headers: auth });
  assert.equal(missing.status, 404, "unknown must not be reported as unconfirmed");
  assert.equal(((await missing.json()) as Record<string, unknown>)["status"], "unknown");
});

test("every tx answer states the window it is answering within", async () => {
  // Without this a consumer cannot tell "never mined" from "older than my
  // index", and the two call for opposite behaviour.
  for (const txid of [MINED_TXID, MEMPOOL_TXID, "d".repeat(64)]) {
    const body = (await (await fetch(`${base}/v1/tx/${txid}`, { headers: auth })).json()) as Record<
      string,
      unknown
    >;
    assert.equal(body["indexedFrom"], BLOCK_HEIGHT, `${txid} indexedFrom`);
    assert.equal(body["indexedTo"], BLOCK_HEIGHT, `${txid} indexedTo`);
  }
});

test("a txid that is not 64 hex characters does not reach the handler", async () => {
  assert.equal((await fetch(`${base}/v1/tx/nope`, { headers: auth })).status, 404);
});

// ── /v1/address ──────────────────────────────────────────────────────────────────

interface AddressBody {
  address: string;
  coverage: { addressIndexEnabled: boolean; indexedFrom: number | null; nodeHeight: number | null };
  totals: {
    confirmedSat: string;
    confirmedLtc: string;
    unconfirmedSat: string;
    totalSat: string;
    confirmedCount: number;
    unconfirmedCount: number;
  };
  confirmed: Array<Record<string, unknown>>;
  unconfirmed: Array<Record<string, unknown>>;
  truncated: boolean;
  totalEntries: number;
}

const addressBody = async (query = ""): Promise<AddressBody> => {
  const res = await fetch(`${base}/v1/address/${ADDRESS}${query}`, { headers: auth });
  assert.equal(res.status, 200);
  return (await res.json()) as AddressBody;
};

test("address splits payments into confirmed and unconfirmed", async () => {
  const body = await addressBody();

  assert.equal(body.address, ADDRESS);
  assert.equal(body.confirmed.length, 1);
  assert.equal(body.unconfirmed.length, 1);

  assert.equal(body.confirmed[0]?.["txid"], MINED_TXID);
  assert.equal(body.confirmed[0]?.["blockHeight"], BLOCK_HEIGHT);
  assert.equal(body.confirmed[0]?.["confirmations"], 6);

  assert.equal(body.unconfirmed[0]?.["txid"], MEMPOOL_TXID);
  assert.equal(body.unconfirmed[0]?.["blockHeight"], null);
  assert.equal(body.unconfirmed[0]?.["confirmations"], 0);
});

test("address totals are exact strings, never floats", async () => {
  const body = await addressBody();

  assert.equal(body.totals.confirmedSat, "150000000");
  assert.equal(body.totals.confirmedLtc, "1.50000000");
  assert.equal(body.totals.unconfirmedSat, "25000000");
  assert.equal(body.totals.totalSat, "175000000");
  assert.equal(body.totals.confirmedCount, 1);
  assert.equal(body.totals.unconfirmedCount, 1);

  // A JSON number here would be a rounding bug waiting for a large balance.
  assert.equal(typeof body.totals.totalSat, "string");
  assert.equal(typeof body.confirmed[0]?.["valueSat"], "string");
});

test("minConfirmations moves the confirmed boundary without hiding anything", async () => {
  // At six confirmations deep, a threshold of seven must reclassify the mined
  // payment as not-yet-final rather than dropping it from the answer.
  const body = await addressBody("?minConfirmations=7");

  assert.equal(body.confirmed.length, 0);
  assert.equal(body.unconfirmed.length, 2);
  assert.equal(body.totals.totalSat, "175000000", "the total is unchanged by the threshold");

  const still = body.unconfirmed.find((e) => e["txid"] === MINED_TXID);
  assert.equal(still?.["blockHeight"], BLOCK_HEIGHT, "its block is still reported");
  assert.equal(still?.["confirmations"], 6);
});

test("address reports the coverage its answer depends on", async () => {
  const body = await addressBody();

  assert.equal(body.coverage.addressIndexEnabled, true);
  assert.equal(body.coverage.indexedFrom, BLOCK_HEIGHT);
  assert.equal(body.coverage.nodeHeight, TIP_HEIGHT);
});

test("an address with no payments answers empty rather than 404", async () => {
  const other = "ltc1qw508d6qejxtdg4y5r3zarvary0c5xw7kaaaaaa";
  const res = await fetch(`${base}/v1/address/${other}`, { headers: auth });
  assert.equal(res.status, 200, "absence of payments is not absence of the address");

  const body = (await res.json()) as AddressBody;
  assert.equal(body.confirmed.length, 0);
  assert.equal(body.unconfirmed.length, 0);
  assert.equal(body.totals.totalSat, "0");
  assert.equal(body.truncated, false);
});

test("raw hex is opt-in", async () => {
  assert.equal((await addressBody()).unconfirmed[0]?.["hex"], null);
  assert.equal((await addressBody("?includeHex=true")).unconfirmed[0]?.["hex"], "0100000001");
});

test("a malformed address is a 400 with a reason, not a silent empty result", async () => {
  const res = await fetch(`${base}/v1/address/notanaddressatallnotanaddressatall`, {
    headers: auth,
  });
  assert.equal(res.status, 400);
  assert.equal(((await res.json()) as Record<string, unknown>)["error"], "bad_request");
});

test("out-of-range query parameters are rejected rather than clamped", async () => {
  for (const q of ["limit=0", "limit=99999", "minConfirmations=-1", "includeHex=maybe"]) {
    const res = await fetch(`${base}/v1/address/${ADDRESS}?${q}`, { headers: auth });
    assert.equal(res.status, 400, `${q} should be refused`);
  }
});
