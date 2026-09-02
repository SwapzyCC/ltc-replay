# Operations

## Day-to-day

```bash
systemctl status ltc-replay
journalctl -u ltc-replay -f
curl -sH "Authorization: Bearer $AUTH_TOKEN" localhost:28350/v1/stats | jq
curl -sH "Authorization: Bearer $AUTH_TOKEN" localhost:28350/v1/tip | jq
```

Docker: `docker compose logs -f`, `docker compose ps`.

Set `LOG_FORMAT=json` for one object per line, which journald, Loki and
CloudWatch all ingest without a parser.

## What to alert on

| Signal                            | Where       | Means                                                       |
| --------------------------------- | ----------- | ----------------------------------------------------------- |
| `lagBlocks` sustained above 0     | `/v1/tip`   | Catch-up has not finished. Node slow or unreachable.        |
| `tap.coreGaps` climbing           | `/v1/stats` | Core's high-water mark is dropping frames.                  |
| `tap.txSeen` flat, busy mempool   | `/v1/stats` | The tap is not receiving. Usually the wrong ZMQ port.       |
| `lastBlockAt` older than ~30 min  | `/v1/stats` | No block frames. Node stalled, or the block topic is wrong. |
| `/health` not answering           | `/health`   | Process down.                                               |
| `indexFloorHeight` rising fast    | `/v1/stats` | The index is trimming more than expected.                   |
| `watchlist.count` 0 while enabled | `/v1/stats` | **Nothing is being indexed.** See below.                    |
| `watchlist.count` below yours     | `/v1/stats` | The relay is missing addresses the consumer knows about.    |

`lagBlocks` briefly non-zero after a restart is normal — that is catch-up
doing its job. Sustained is the alert.

### `lagBlocks` will not come down

Check the node first:

```bash
litecoin-cli getblockchaininfo | jq '{blocks,headers,initialblockdownload,verificationprogress}'
journalctl -u ltc-replay -n 100 | grep -i catchup
```

Catch-up writes at most 2000 blocks per pass, so a badly stale journal makes
visible progress across several passes rather than in one. If it is moving,
wait. If it is not, the RPC credentials or the node itself are the problem.

### The watchlist is empty, or short

This is the failure mode with no symptoms. With `WATCHLIST_ONLY=true` a relay
whose watchlist is empty matches no transaction, so it writes no rows, logs no
errors and answers `/v1/stats` with counters that look exactly like a quiet
chain. Meanwhile every deposit on the network goes unindexed.

```bash
curl -sH "Authorization: Bearer $AUTH_TOKEN" localhost:28350/v1/stats \
  | jq '.watchlist'
```

`{"enabled": true, "count": 0}` is the alert. The relay also warns at boot and
after the last address is removed:

```
WARN [watchlist] watchlist is empty and WATCHLIST_ONLY is on — NOTHING is being indexed.
```

The fix is always the same: have the consumer push its registry again. The
watchlist is the one part of this database that cannot be rebuilt from the
chain, so a reinstalled relay — or one whose journal was deleted to reclaim
disk — comes back empty by construction. The bundled client's `syncWatched()`
handles it at boot; if the count is short rather than zero, that call is either
not running or not passing the full set.

Comparing the relay's count against the consumer's own is the more useful of the
two alerts, because it catches the address that was derived while the relay was
down as well as the wholesale case.

### `coreGaps` is climbing

Core's ZMQ high-water mark is discarding frames before the tap sees them. This
is otherwise completely silent — the relay only knows because Core stamps each
frame with a per-topic sequence counter and the counter jumped.

Raise the marks in `litecoin.conf` and restart the node:

```conf
zmqpubrawtxhwm=50000
zmqpubhashblockhwm=10000
```

Blocks are unaffected: catch-up recovers those from the chain regardless. What
is being lost is mempool sightings, which means deposits appear later — at
confirmation — rather than never.

### `txSeen` is not moving

Almost always `LTC_ZMQ_TX_URL` pointing at Core's `hashtx` publisher instead of
`rawtx`. They are different topics on different ports, and subscribing to the
wrong one delivers 32-byte hashes where the tap expects transactions: nothing
decodes, nothing is indexed, and nothing errors.

```bash
litecoin-cli getzmqnotifications
```

Match the `pubrawtx` address, not whichever `zmqpub*` line comes first.

## Disk

```bash
du -h /opt/ltc-replay/data/
curl -sH "Authorization: Bearer $AUTH_TOKEN" localhost:28350/v1/stats \
  | jq '.journal | {events, txs, blocks, indexedTxs, indexedOutputs, sizeBytes}'
```

### What actually takes the space

Not the event log. The two indexes, by roughly an order of magnitude — and
`address_txs` is the larger of the two.

How much larger depends on one setting. With `WATCHLIST_ONLY=true` (the
default) a row exists only for an output paying an address you registered, so
the index is sized by your deposit rate. With it off, there is a row for **every
addressable output on the chain**, and it is sized by Litecoin.

Per row, including the secondary indexes each table carries:

| Component          | Rows                          | Bytes/row (incl. indexes) |
| ------------------ | ----------------------------- | ------------------------- |
| `block_txs`        | one per transaction per block | ~340                      |
| `address_txs`      | one per addressable output    | ~505                      |
| `events` (`tx`)    | one per mempool sighting      | ~520                      |
| `events` (`block`) | 576/day, permanent            | ~110                      |

At ~2.3 addressable outputs per transaction that is **~1.5 KB per stored
transaction** held inside the index window, and the window is
`TX_INDEX_BLOCKS / 576` days.

```
stored_per_day = deposits/day        with WATCHLIST_ONLY=true
               = chain tx/day        with WATCHLIST_ONLY=false

index bytes     = stored_per_day * (TX_INDEX_BLOCKS / 576) * 1.5 KB
mempool bytes   = stored_per_day * (TX_RETENTION_HOURS / 24) * 0.52 KB
block bytes     = 576 * days_running * 0.11 KB        # permanent, ~23 MB/year
watchlist bytes = watched_addresses * 0.1 KB
```

Litecoin runs roughly 576 blocks a day; take the chain's transaction rate from
`getchaintxstats` and your own from your deposit volume.

**Filtered — the default.** At `TX_INDEX_BLOCKS=20000` (about 35 days):

| Deposits/day | Index   | + 1 year of block records | Steady state |
| ------------ | ------- | ------------------------- | ------------ |
| 100          | ~5 MB   | ~23 MB                    | **~30 MB**   |
| 1,000        | ~52 MB  | ~23 MB                    | **~75 MB**   |
| 10,000       | ~520 MB | ~23 MB                    | **~545 MB**  |

Below a few thousand deposits a day the permanent block records — 576 rows a
day, forever — are the larger half of the database, and no index setting
touches them. That is the floor.

**Unfiltered.** `WATCHLIST_ONLY=false`, at 100k chain transactions/day:

| Settings                                      | Steady state |
| --------------------------------------------- | ------------ |
| `TX_INDEX_BLOCKS=20000`, address index on     | **~5.4 GB**  |
| `TX_INDEX_BLOCKS=20000`, address index off    | ~1.3 GB      |
| `TX_INDEX_BLOCKS=5760`, address index on      | ~1.7 GB      |
| `TX_INDEX_BLOCKS=1440` (2.5 days), address on | ~530 MB      |

Halve those at 50k tx/day, double them at 200k. Add ~15% for the WAL and for
free pages SQLite does not hand back to the filesystem. Treat every table here
as an estimate: `sizeBytes` from `/v1/stats` is the only number that is actually
true about your deployment.

Growth is bounded rather than open-ended. `address_txs` rows whose transaction
has dropped out of `block_txs` are removed on the same pass, so both indexes
settle at the window instead of accumulating.

Levers, in the order worth pulling:

1. `WATCHLIST_ONLY=true`. Two orders of magnitude, and it is the default.
   Costs nothing if you register addresses as you derive them; costs you
   deposits to addresses you forgot to register, which is why the empty-list
   alert below matters.
2. Lower `TX_INDEX_BLOCKS`. Biggest effect on what remains. Costs you the
   ability to answer about older transactions — see
   [Pruned nodes](pruned-nodes.md) for the trade.
3. Lower `TX_RETENTION_HOURS`. Drops old mempool bodies. Deposits are still
   recovered from blocks.
4. `ADDRESS_INDEX=false`. Only if you never query by address.

Pruning runs every 15 minutes and checkpoints the WAL when it removes anything.
A failure is logged and never takes the service down — it is housekeeping.

## Backup

The journal is **disposable, with one exception**. It is a cache of what the
chain already says, and catch-up rebuilds block history from the node.

The exception is `watched_addresses`. Nothing in the chain records which
addresses you care about, so a rebuilt journal comes back watching nothing — and
indexes nothing, silently, until someone notices deposits have stopped. The
consumer is expected to re-push its registry after any rebuild; the bundled
client's `syncWatched()` does this at boot by comparing counts. If your consumer
does not, back this table up, or you have turned a disposable cache into
something that is not.

If you want a copy anyway, use SQLite's backup rather than `cp` — the database
is in WAL mode and a plain copy can catch it mid-write:

```bash
sqlite3 /opt/ltc-replay/data/journal.sqlite ".backup '/backup/journal.sqlite'"
```

What a rebuild actually costs: the mempool sightings inside the retention
window, and index coverage below whatever the node can still serve. Both are
recoverable from blocks; neither is money.

## Rebuilding

```bash
sudo systemctl stop ltc-replay
sudo rm /opt/ltc-replay/data/journal.sqlite*
sudo systemctl start ltc-replay
```

Set `START_HEIGHT` first if you want to backfill from a specific height rather
than the node's current tip. Nothing can walk below the node's `pruneheight`.

Watch `lagBlocks` fall, and hold consumers off until it reaches zero — an empty
answer from a relay that has not caught up is not evidence of anything.

## Reorgs

```bash
journalctl -u ltc-replay | grep -i reorg
curl -sH "Authorization: Bearer $AUTH_TOKEN" \
  "localhost:28350/v1/events?since=0&limit=5000" | jq '.events[] | select(.type=="reorg")'
```

Catch-up searches up to 100 blocks deep for the fork point. Anything deeper is
logged loudly and left alone, because a reorg that deep on Litecoin is an
incident, not a routine event.

A one- or two-block reorg is normal and needs no action unless a consumer
credits before deep confirmation — in which case see
[Integration](integration.md#5-reorgs).

## Security checks

Worth doing after any change to binds or firewall rules:

```bash
ss -lntp | grep -E '28350|28340'                 # who is listening where
curl -s localhost:28350/v1/tip                    # must be 401
curl -s localhost:28350/health                    # must be 200
```

- `/v1/*` without a token must answer `401`, and so must an unknown path —
  route resolution happens before authentication so the API cannot be mapped
  unauthenticated.
- **ZMQ PUB on 28340 has no authentication at all.** Confirm it is not
  reachable from anywhere it should not be. Anyone who can reach it has a live
  view of your deposit flow.
- The service names either port at boot if it is bound off-box. Do not filter
  that warning out of your log pipeline.
- `.env` holds the RPC password and the bearer token. Mode 600, owned by the
  service user.

### Rotating the token

```bash
NEW=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
sudo sed -i "s|^AUTH_TOKEN=.*|AUTH_TOKEN=$NEW|" /opt/ltc-replay/.env
sudo systemctl restart ltc-replay
```

There is one token, so update consumers in the same window. The restart costs
nothing: catch-up closes the gap it opens.

## Upgrading

```bash
cd /opt/ltc-replay && git pull && npm ci && npm run build
sudo systemctl restart ltc-replay
```

Schema changes are `IF NOT EXISTS`, so the journal survives. Named statements
in `queries.sql` are validated in both directions at boot — a mismatch between
the code and the SQL is a startup failure, not a route that throws later.

If the service will not start after an upgrade, read the first error: it is
written to name the cause, including the case where the build compiled the
TypeScript without copying `*.sql` into `dist/` (`npm run build` does both).

## Related

- [Deployment](deployment.md) — install and exposure
- [Configuration](configuration.md) — every value and its effect
- [API reference](api.md) — the endpoints referenced above
