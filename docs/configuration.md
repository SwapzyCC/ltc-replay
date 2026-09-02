# Configuration

Everything is read from the environment, once, at boot, and validated then.
Anything required and missing is a startup failure rather than a surprise
later. An empty value counts as unset.

A `.env` file in the working directory is loaded if present.
[`.env.example`](../.env.example) is the annotated template — copy it and fill
it in.

## Litecoin Core JSON-RPC

| Variable           | Required | Default                 | Notes                                        |
| ------------------ | -------- | ----------------------- | -------------------------------------------- |
| `LTC_RPC_URL`      | no       | `http://127.0.0.1:9332` |                                              |
| `LTC_RPC_USER`     | **yes**  | —                       | Or the user half of an `rpcauth` line.       |
| `LTC_RPC_PASSWORD` | **yes**  | —                       | Secret. Keep `.env` at mode 600.             |
| `LTC_RPC_WALLET`   | no       | —                       | Only for a node with several wallets loaded. |

Used for catch-up, for block contents on `/v1/replay`, and for confirmation
counts. The relay calls **read methods only** — no wallet method, no write
method. Compromising it does not move coins.

`LTC_RPC_WALLET` appends `/wallet/<name>` to the URL. The relay itself uses no
wallet method, so this only matters if your node's default endpoint is
ambiguous.

Prefer `rpcauth` in `litecoin.conf` over a plaintext `rpcpassword`. The helper
shipped with Core prints the line to paste there and the password to put here,
and the password itself is never stored on the node.

## ZMQ — the live tap

| Variable            | Required | Default                 | Notes                             |
| ------------------- | -------- | ----------------------- | --------------------------------- |
| `LTC_ZMQ_TX_URL`    | no       | `tcp://127.0.0.1:28334` | Core's **`rawtx`** publisher.     |
| `LTC_ZMQ_BLOCK_URL` | no       | `tcp://127.0.0.1:28333` | Core's **`hashblock`** publisher. |

These must match `-zmqpubrawtx` and `-zmqpubhashblock` in `litecoin.conf`, port
for port. The defaults are Core's conventional ports for those two topics, but
"conventional" is not "guaranteed" — check yours.

> **The most common misconfiguration.** `rawtx` and `hashtx` are different
> publishers on different ports. Most guides show `28332` for `hashtx`, and it
> is easy to point `LTC_ZMQ_TX_URL` at it. Doing so delivers 32-byte hashes
> where the tap expects serialised transactions: it decodes nothing, indexes
> nothing, and looks perfectly healthy in the logs. Check the port against the
> `zmqpubrawtx` line, not against the `zmqpub*` line that happens to be first.

Keep both on loopback. The relay runs on the same host as the node — that is
the entire point, since no network between Core and the tap means nothing to
drop.

## Republish socket

| Variable   | Required | Default                 | Notes                      |
| ---------- | -------- | ----------------------- | -------------------------- |
| `PUB_BIND` | no       | `tcp://127.0.0.1:28340` | Where consumers subscribe. |

The relay re-emits `rawtx` and `hashblock` frames verbatim, so an existing Core
ZMQ consumer works unchanged by pointing at this instead of at the node.

**ZMQ PUB has no authentication of any kind.** Anyone who can reach this port
reads every transaction the tap sees. The service warns at boot if this is
bound to `0.0.0.0` or to a public address. Bind it to a private interface and
firewall the port to the consumer's address, or run a tunnel.

## HTTP API

| Variable     | Required | Default     | Notes                                    |
| ------------ | -------- | ----------- | ---------------------------------------- |
| `HTTP_BIND`  | no       | `127.0.0.1` | Loopback by default, on purpose.         |
| `HTTP_PORT`  | no       | `28350`     |                                          |
| `AUTH_TOKEN` | **yes**  | —           | The service refuses to start without it. |

`AUTH_TOKEN` must be at least 24 characters; below that the service refuses to
start on the grounds that it is a password rather than a credential. Generate
one with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

The default bind means a half-finished deploy is unreachable rather than open.
The service names the port at boot if it is bound off-box, because the bearer
token is the only thing in front of the replay history.

Inside Docker, `HTTP_BIND` must be `0.0.0.0` — `127.0.0.1` there means
"unreachable from anywhere". The bundled `docker-compose.yml` sets it, and
publishes the port to the host's loopback instead.

## Journal

| Variable              | Required | Default                 | Notes                                |
| --------------------- | -------- | ----------------------- | ------------------------------------ |
| `DB_PATH`             | no       | `./data/journal.sqlite` | Needs a writable directory.          |
| `TX_RETENTION_HOURS`  | no       | `72`                    | Mempool sightings only.              |
| `CATCHUP_INTERVAL_MS` | no       | `60000`                 | Safety net; blocks also trigger it.  |
| `START_HEIGHT`        | no       | —                       | First-run floor. Empty = node's tip. |

`TX_RETENTION_HOURS` bounds raw mempool transactions only. Block records are
kept forever, a few dozen bytes each, and a deposit missed in the mempool is
still recovered from its block — so this only needs to cover the window where
you want _unconfirmed_ sightings back as well.

`CATCHUP_INTERVAL_MS` is a safety net for frames the tap never received. A
`hashblock` frame triggers catch-up immediately, so in normal operation the
interval rarely does anything.

`START_HEIGHT` applies to an **empty journal only**. Leave it empty to start at
the node's current tip; set it to backfill from a specific height. Note that on
a pruned node nothing can walk below the node's `pruneheight`.

## The watchlist

| Variable                  | Required | Default | Notes                                                                |
| ------------------------- | -------- | ------- | -------------------------------------------------------------------- |
| `WATCHLIST_ONLY`          | no       | `true`  | Index only transactions paying a watched address.                    |
| `WATCH_RESCAN_MAX_BLOCKS` | no       | `2000`  | Largest rescan one `POST /v1/watch` may ask for. 0 disables rescans. |

This is the single largest lever on disk, and it is on by default. With it on,
a transaction that pays nothing on the list is decoded, counted in
`tap.txFiltered`, and dropped — not journalled, not indexed, not re-published.
A deposit monitor watching a few thousand addresses discards upwards of 99.9%
of chain traffic that way, and the sizing below stops being about Litecoin's
transaction rate and starts being about your own deposit rate.

Two consequences worth understanding before you deploy it:

**An empty watchlist indexes nothing, and looks healthy doing it.** No rows, no
errors, no logs — `/v1/stats` reports a quiet chain. The relay warns at boot and
after the last removal, and `/v1/stats` carries `watchlist.count`; alert on
`enabled: true` with `count: 0`.

**The list is the one thing the chain cannot rebuild.** Every other byte in the
journal can be reconstructed by re-walking blocks. This cannot, so the consumer
owns it and re-pushes it — see the sync loop in
[Integration](integration.md#0-register-your-addresses).

Set `WATCHLIST_ONLY=false` to index every addressable output on the chain. That
is the right setting for a block explorer or a relay serving consumers whose
address set it cannot know, and the wrong one for a deposit monitor.

`WATCH_RESCAN_MAX_BLOCKS` bounds the optional rescan on `POST /v1/watch`.
Unbounded, it would be a way to make the relay walk the chain on request. Set it
to `0` if you register every address before publishing it, which is the case
where no rescan is ever needed.

## Indexes

| Variable          | Required | Default | Notes                                       |
| ----------------- | -------- | ------- | ------------------------------------------- |
| `TX_INDEX_BLOCKS` | no       | `20000` | Depth of the txid → block index. 0 = off.   |
| `ADDRESS_INDEX`   | no       | `true`  | Decode and index which addresses were paid. |

These two exist because Core will not run `txindex` alongside `prune`. Read
[Pruned nodes](pruned-nodes.md) before choosing values — the defaults are
reasonable, but the sizing question is a real one.

| `TX_INDEX_BLOCKS` | Roughly    | Serves                           | Watchlist on, 1k/day | Watchlist off, 100k tx/day |
| ----------------- | ---------- | -------------------------------- | -------------------- | -------------------------- |
| `0`               | —          | Nothing. `/v1/tx` always misses. | —                    | —                          |
| `1440`            | 2.5 days   | Deposits only, nothing historic. | ~5 MB                | ~530 MB                    |
| `5760`            | 10 days    | Same-week disputes.              | ~15 MB               | ~1.7 GB                    |
| `20000`           | 5 weeks    | The default.                     | ~50 MB               | ~5.4 GB                    |
| `60000`           | 3.5 months | Long-tail reconciliation.        | ~155 MB              | ~16 GB                     |

Disk scales linearly with the window and with the number of transactions that
survive the filter — your deposit rate with `WATCHLIST_ONLY=true`, the whole
chain's rate without it. `ADDRESS_INDEX=false` cuts what remains to roughly a
quarter. The arithmetic is in
[Operations](operations.md#what-actually-takes-the-space).

`ADDRESS_INDEX=false` leaves `/v1/address` answering an empty history with
`coverage.addressIndexEnabled: false` rather than erroring — so a consumer can
tell the difference. Turn it off only if you look transactions up by txid
exclusively.

## Logging

| Variable     | Default | Notes                                                     |
| ------------ | ------- | --------------------------------------------------------- |
| `LOG_LEVEL`  | `info`  | `error`, `warn`, `info`, `debug`.                         |
| `LOG_FORMAT` | —       | `json` for one object per line. The Docker image sets it. |

Anything unrecognised in `LOG_LEVEL` falls back to `info` rather than failing —
a typo in a log setting should not stop a deposit relay from starting.

## Validation at boot

Beyond the per-variable checks, the service verifies the node itself before it
serves anything:

- **Initial block download is fatal.** A syncing node would have the relay
  publish a tip that is not the chain tip, and consumers would read the absence
  of their deposit as final.
- **A pruned node is reported, not rejected.** The log states the prune floor,
  its depth in blocks and days, and that replay cannot reach below it.
- **A missing `txindex` is stated, not warned about.** It is expected on a
  pruned node. What matters is the consequence, which the log spells out:
  resolve confirmations through `/v1/tx`, not through `getrawtransaction`.
- **`TX_INDEX_BLOCKS=0` on a node without `txindex` is warned about**, because
  in that combination nothing can answer whether a transaction confirmed.

Three configuration combinations are rejected outright:

| Rejected                                      | Because                                           |
| --------------------------------------------- | ------------------------------------------------- |
| `AUTH_TOKEN` under 24 characters              | It is a password, not a credential.               |
| `LTC_ZMQ_TX_URL` equal to `LTC_ZMQ_BLOCK_URL` | One of the two topics would never be subscribed.  |
| `PUB_BIND` equal to either ZMQ URL            | The relay would be subscribing to its own output. |

## Related

- [`.env.example`](../.env.example) — the annotated template
- [Deployment](deployment.md) — where these values come from in practice
- [Pruned nodes](pruned-nodes.md) — sizing the two index settings
