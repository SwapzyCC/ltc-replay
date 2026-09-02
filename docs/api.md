# API reference

Base URL: `http://<relay-host>:28350` (`HTTP_BIND` / `HTTP_PORT`).

Every endpoint is `GET`. Anything else answers `405` with an `Allow: GET, HEAD`
header. URLs longer than 2048 bytes answer `414`.

## Authentication

All endpoints except `/health` require:

```
Authorization: Bearer <AUTH_TOKEN>
```

The token is compared in constant time. A missing or wrong token answers `401`
with a `WWW-Authenticate` header.

Route resolution happens **before** authentication, deliberately: an
unauthenticated request to a path that does not exist also answers `401`, not
`404`, so the API cannot be mapped by an unauthenticated scan.

## Endpoint summary

| Endpoint                   | Purpose                                                |
| -------------------------- | ------------------------------------------------------ |
| `GET /health`              | Liveness. Public. Reveals nothing about the chain.     |
| `GET /v1/tip`              | Journal cursor, node height, and the lag between them. |
| `GET /v1/events`           | Cursor-based journal read.                             |
| `GET /v1/replay`           | NDJSON stream of blocks with full raw transactions.    |
| `GET /v1/block/:hash`      | One block with its transactions.                       |
| `GET /v1/tx/:txid`         | Confirmation status for one transaction.               |
| `GET /v1/address/:address` | Payments to an address, split confirmed / unconfirmed. |
| `GET /v1/stats`            | Journal counts, tap counters, retention settings.      |

---

## `GET /health`

Public. Used by load balancers, uptime probes and the Docker healthcheck.

```json
{ "ok": true, "service": "ltc-replay", "uptimeSeconds": 84213 }
```

It says nothing about the chain, the node, or the watched address set — an
unauthenticated caller learns only that a process is answering.

---

## `GET /v1/tip`

Where the journal and the node each are.

```json
{
  "journal": { "seq": 918442, "height": 2751402, "hash": "…" },
  "node": { "height": 2751402 },
  "lagBlocks": 0
}
```

`lagBlocks` is the number to gate on. Non-zero means catch-up has not finished,
so an empty answer from any other endpoint means "not yet", not "never". It is
`null` when the node was unreachable — the journal's own position is still
reported rather than failing the whole request.

---

## `GET /v1/events`

Cursor-based read of the journal. Blocks, mempool transactions and reorgs
interleaved in the order the relay saw them.

| Parameter | Default | Notes                                |
| --------- | ------- | ------------------------------------ |
| `since`   | `0`     | Exclusive. Pass the previous `next`. |
| `limit`   | `1000`  | 1..5000.                             |

```json
{
  "events": [
    { "seq": 918441, "type": "tx", "ts": 1756...,
      "txid": "…", "hex": "0200…", "source": "zmq" },
    { "seq": 918442, "type": "block", "ts": 1756...,
      "height": 2751402, "hash": "…", "source": "catchup" }
  ],
  "next": 918442,
  "hasMore": false,
  "journalSeq": 918442
}
```

Event types:

| `type`  | Carries                                            |
| ------- | -------------------------------------------------- |
| `block` | `height`, `hash`                                   |
| `tx`    | `txid`, `hex` (the raw serialisation as published) |
| `reorg` | `height`, `hash` (the winner), `orphanedHash`      |

`next` falls back to `since` on an empty page, so an idle poll holds the cursor
still rather than resetting it to zero and replaying everything.

A `reorg` event is the only signal that a block a consumer already credited
against is gone. Handle it if you credit before deep confirmation.

---

## `GET /v1/replay`

NDJSON stream of blocks, one per line. This is the endpoint that recovers a
gap longer than the event journal's retention.

| Parameter     | Default | Notes                    |
| ------------- | ------- | ------------------------ |
| `sinceHeight` | —       | **Required.** Exclusive. |
| `maxBlocks`   | `50`    | 1..500.                  |

```
{"height":2751401,"hash":"…","time":…,"previousblockhash":"…","nTx":42,"txs":[{"txid":"…","hex":"…"}]}
{"height":2751402,"hash":"…","time":…,"previousblockhash":"…","nTx":37,"txs":[…]}
{"done":true,"nextHeight":2751402,"tipHeight":2751402,"hasMore":false}
```

The `done` line is load-bearing. Without it a truncated response is
indistinguishable from "you are up to date", and a consumer would advance its
cursor past blocks it never received. **Do not advance the cursor unless you
saw it.** The bundled client throws if it is absent.

NDJSON rather than a JSON array because a thousand-block gap must not have to
fit in memory at either end.

Failure modes:

- Node unreachable _before_ the stream opens → `503` with a JSON body.
- Failure _mid-stream_ → the status code is already spent, so an error object
  is written into the stream instead and no `done` line follows:
  ```
  {"error":"block_failed","height":2751399,"detail":"…"}
  ```
- The client disconnecting ends the stream cleanly.

The response carries `x-tip-height`.

---

## `GET /v1/block/:hash`

One block, with every transaction's raw hex. `:hash` is 64 hex characters.

```json
{
  "height": 2751402,
  "hash": "…",
  "time": 1756...,
  "previousblockhash": "…",
  "nTx": 37,
  "txs": [{ "txid": "…", "hex": "0200…" }]
}
```

`404 {"error":"unknown_block"}` covers both an unknown hash and — on a pruned
node — a known block whose body has been discarded. From the consumer's side
those are the same answer: this host cannot give you that block.

---

## `GET /v1/tx/:txid`

Confirmation status for one transaction. This is the replacement for
`getrawtransaction` against a pruned node, which cannot answer for a confirmed
watch-only payment at all — see [Pruned nodes](pruned-nodes.md).

`:txid` is 64 hex characters, case-insensitive.

**Mined** — `200`:

```json
{
  "txid": "…",
  "status": "mined",
  "blockHeight": 2751380,
  "blockHash": "…",
  "confirmations": 23,
  "firstSeenAt": 1756...,
  "indexedFrom": 2731400,
  "indexedTo": 2751402
}
```

**In the mempool** — `200`, `status: "mempool"`, `confirmations: 0`,
`blockHeight: null`.

**Unknown** — `404`:

```json
{ "txid": "…", "status": "unknown", "indexedFrom": 2731400, "indexedTo": 2751402 }
```

Two things to be careful with:

- `confirmations` is `null` when the node was unreachable. That is an _unknown_,
  distinct from the `0` a mempool transaction reports, which is a _fact_. Never
  collapse them.
- `unknown` is a negative answer only **within** `indexedFrom..indexedTo`. If
  the height you care about is below `indexedFrom`, you have been told nothing.

---

## `GET /v1/address/:address`

Every payment the relay has seen to an address, split into confirmed and
unconfirmed. This is the deposit-monitor endpoint.

| Parameter          | Default | Notes                                                 |
| ------------------ | ------- | ----------------------------------------------------- |
| `limit`            | `200`   | 1..1000.                                              |
| `minConfirmations` | `1`     | 0..10000. Where the confirmed/unconfirmed line falls. |
| `includeHex`       | `false` | Include each transaction's raw hex. Large.            |

```json
{
  "address": "ltc1q…",
  "query": { "limit": 200, "minConfirmations": 6, "includeHex": false },
  "coverage": {
    "addressIndexEnabled": true,
    "indexedFrom": 2731400,
    "indexedTo": 2751402,
    "nodeHeight": 2751402,
    "lagBlocks": 0
  },
  "totals": {
    "confirmedSat": "150000000",
    "confirmedLtc": "1.50000000",
    "unconfirmedSat": "25000000",
    "unconfirmedLtc": "0.25000000",
    "totalSat": "175000000",
    "totalLtc": "1.75000000",
    "confirmedCount": 2,
    "unconfirmedCount": 1
  },
  "confirmed": [
    {
      "txid": "…", "vout": 1,
      "valueSat": "100000000", "valueLtc": "1.00000000",
      "status": "confirmed", "confirmations": 23,
      "blockHeight": 2751380, "blockHash": "…",
      "firstSeenAt": 1756..., "hex": null
    }
  ],
  "unconfirmed": [ … ],
  "truncated": false,
  "totalEntries": 3
}
```

Notes that matter:

- **Amounts are integer litoshi strings.** Parse with `BigInt`, never `Number`.
  `valueLtc` is for display only.
- **Only received outputs are indexed.** Resolving an input's address requires
  the transaction it spends, which a pruned node may no longer hold. "What did
  this address receive" is the question a deposit monitor asks, so the limit
  costs it nothing.
- **Entries are stable across the confirmation boundary.** The index is keyed
  `(address, txid, vout)`, and both ingest paths use the same decoder, so a
  mempool sighting and its later mining are one entry that gains a block — not
  two. Key your credits on `(txid, vout)` and re-processing is harmless.
- **`truncated: true` means the totals describe the returned page, not the
  address.** Raise `limit` before reconciling a balance from them.
- **Read `coverage` before trusting an empty list.** An empty result from a
  relay with `lagBlocks: 400` is not evidence of anything, and one with
  `addressIndexEnabled: false` means the index was never being written.

`400` for an address that does not decode, with a reason. Ordering puts
unconfirmed entries first, then newest block, then `vout`.

---

## `GET /v1/stats`

```json
{
  "journal": {
    "events": 918442, "txs": 812004, "blocks": 20438,
    "oldestTxTs": 1756...,
    "indexedTxs": 1840221, "indexedOutputs": 4102887,
    "indexedAddresses": 3011204,
    "indexFloorHeight": 2731400,
    "sizeBytes": 412303360
  },
  "tap": {
    "txSeen": 812110, "txJournalled": 812004, "paymentsIndexed": 1904221,
    "blocksSeen": 20438, "coreGaps": 0,
    "lastTxAt": 1756..., "lastBlockAt": 1756...
  },
  "retention": { "txHours": 72, "txIndexBlocks": 20000, "addressIndex": true },
  "startedAt": 1756...
}
```

`coreGaps` is the one to alert on: it counts jumps in Core's per-topic sequence
counter, which is the only visible trace of Core's high-water mark silently
dropping frames. See [Operations](operations.md).

---

## Error shapes

| Status | Body                             | Meaning                                       |
| ------ | -------------------------------- | --------------------------------------------- |
| `400`  | `{"error":"…"}`                  | Bad parameter, with the reason.               |
| `401`  | `{"error":"unauthorized"}`       | Missing or wrong token — or an unknown path.  |
| `404`  | `{"error":"not_found"}`          | Authenticated, path does not exist.           |
| `404`  | `{"status":"unknown",…}`         | `/v1/tx` — a real answer, read `indexedFrom`. |
| `405`  | `{"error":"method_not_allowed"}` | Not GET or HEAD.                              |
| `414`  | `{"error":"uri_too_long"}`       | URL over 2048 bytes.                          |
| `503`  | `{"error":"node_unavailable",…}` | The node could not be reached.                |

## Related

- [Integration guide](integration.md) — using these from a deposit monitor
- [Pruned nodes](pruned-nodes.md) — why `/v1/tx` and `/v1/address` exist
