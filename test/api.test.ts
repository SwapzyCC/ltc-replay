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

import { createApi } from "../src/http.js";
import { Journal } from "../src/journal.js";
import type { Config } from "../src/config.js";
import type { LitecoinRpc } from "../src/rpc.js";
import type { Tap } from "../src/tap.js";

const TOKEN = "test-token-that-is-long-enough-to-pass";
const TIP_HEIGHT = 1_005;

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
    txJournalled: 0,
    blocksSeen: 0,
    coreGaps: 0,
    lastTxAt: null,
    lastBlockAt: null,
  }),
} as unknown as Tap;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), "ltc-replay-api-"));
  journal = new Journal(join(dir, "journal.sqlite"));
  journal.appendBlock(1_000, "f".repeat(64), "zmq");

  const cfg = { authToken: TOKEN, txRetentionHours: 72 } as Config;
  server = createApi({ cfg, journal, rpc: rpcStub, tap: tapStub, startedAt: Date.now() });

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
  const routes = ["/v1/tip", "/v1/events", "/v1/stats", "/v1/replay?sinceHeight=1000"];

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

  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

  const blocks = lines.filter((l) => l["done"] !== true);
  assert.deepEqual(blocks.map((b) => b["height"]), [1_001, 1_002, 1_003]);
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
  const lines = (await res.text()).trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);
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

  assert.equal(body.events.length, 1);
  assert.equal(body.hasMore, false);
  assert.ok(body.next > 0);
});

test("unknown routes and non-GET methods are refused", async () => {
  assert.equal((await fetch(`${base}/v1/nope`, { headers: auth })).status, 404);
  assert.equal(
    (await fetch(`${base}/v1/tip`, { method: "POST", headers: auth })).status,
    405,
  );
});
