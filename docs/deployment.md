# Deployment

The relay is designed to run on the **node's own host**. That is not incidental:
no network between Core's ZMQ publishers and the tap means there is nothing to
drop between them, which is the whole failure mode this service exists to close.

Two supported shapes: systemd on the host, or Docker. Both start with the same
node configuration.

## 1. Configure Litecoin Core

Merge [`deploy/litecoin.conf.snippet`](../deploy/litecoin.conf.snippet) into
your `litecoin.conf`, then restart `litecoind`.

The short version:

```conf
# ZMQ — rawtx and hashtx are DIFFERENT publishers on different ports
zmqpubrawtx=tcp://127.0.0.1:28334
zmqpubhashblock=tcp://127.0.0.1:28333
zmqpubrawtxhwm=50000
zmqpubhashblockhwm=10000

# RPC — read methods only, loopback only
server=1
rpcbind=127.0.0.1
rpcallowip=127.0.0.1
```

> **If your node is pruned, do not add `txindex=1` and do not reindex.** Core
> refuses to run the two together. The relay maintains its own indexes instead.
> Read [Pruned nodes](pruned-nodes.md) — it is five minutes and it determines
> whether the rest of your plan is possible.

The high-water marks are worth setting even if everything else stays as it is.
Core's default of 1000 is low for a busy mempool, and when a topic's queue
fills Core drops frames **silently**. The relay detects the drop from Core's
per-topic sequence counter and catch-up repairs the block side, but not losing
them in the first place is better.

Two things to narrow if your config has them wide:

- `rpcbind=0.0.0.0` without a matching `rpcallowip` listens on every interface.
- ZMQ publishers on `tcp://0.0.0.0:...` are readable by anyone who can reach
  the port — ZMQ PUB has no authentication of any kind. The relay is on the
  same host; loopback is enough.

Verify the node is ready:

```bash
litecoin-cli getblockchaininfo | jq '{chain,blocks,pruned,pruneheight,initialblockdownload}'
litecoin-cli getzmqnotifications
```

`initialblockdownload` must be `false` — the relay refuses to start otherwise,
because a syncing node would have it publish a tip that is not the chain tip.

## 2a. Deploy with systemd

```bash
sudo git clone <repo> /opt/ltc-replay
cd /opt/ltc-replay
npm ci
npm run build

cp .env.example .env
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # AUTH_TOKEN
$EDITOR .env

sudo useradd --system --home /opt/ltc-replay --shell /usr/sbin/nologin ltcreplay
sudo mkdir -p /opt/ltc-replay/data
sudo chown -R ltcreplay:ltcreplay /opt/ltc-replay
sudo chmod 600 /opt/ltc-replay/.env

sudo cp deploy/ltc-replay.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now ltc-replay
journalctl -u ltc-replay -f
```

The unit is hardened — `ProtectSystem=strict`, `NoNewPrivileges`,
`PrivateDevices`, a restricted address-family set — with the data directory as
the only writable path. `Restart=always` with `StartLimitIntervalSec=0` means
it never gives up: every restart runs catch-up, so even a long outage ends with
a complete journal.

`After=litecoind.service` matters. Preflight refuses to start against a syncing
node, and the restart loop turns that into a retry until the node is ready.

Both native dependencies (`zeromq`, `better-sqlite3`) ship prebuilt binaries for
linux-x64. If `npm ci` starts compiling, install a toolchain first:

```bash
sudo apt install -y build-essential python3
```

## 2b. Deploy with Docker

```bash
cp .env.example .env
$EDITOR .env          # AUTH_TOKEN and the RPC credentials
docker compose up -d --build
docker compose logs -f
```

The image is two-stage on `node:22-bookworm-slim`. Debian rather than Alpine on
purpose: `better-sqlite3` and `zeromq` both publish glibc prebuilds, and on
musl each compiles from source — a toolchain in the final image and several
minutes per build, in exchange for nothing.

`docker-compose.yml` documents two arrangements. Pick one and delete the other:

| Shape | When                       | How the relay reaches Core                                                                            |
| ----- | -------------------------- | ----------------------------------------------------------------------------------------------------- |
| **A** | litecoind runs in Docker   | Join its network, address it as `http://litecoind:9332`. Core's ports need no host publishing at all. |
| **B** | litecoind runs on the host | `network_mode: host`. Core's ZMQ stays on loopback. Note that `ports:` is ignored in this mode.       |

Shape A is the default in the file. Change `litecoind` to whatever the node's
service is actually called, and check the network name with `docker network ls`
— the compose file joins an `external: true` network rather than creating a
second one.

Both published ports bind to `127.0.0.1` deliberately:

```yaml
ports:
  - "127.0.0.1:28350:28350" # replay API — bearer token is the only guard
  - "127.0.0.1:28340:28340" # ZMQ PUB — no authentication whatsoever
```

`HTTP_BIND` is forced to `0.0.0.0` in the `environment:` block, overriding
`.env` on purpose: a `.env` written for a bare-metal install says `127.0.0.1`,
which inside a container means "unreachable from anywhere".

The journal lives in `./data:/app/data`. That is the one piece of state worth
keeping — losing it means re-walking the chain and, until that finishes,
answering "no" to questions about deposits that did happen.

## 3. Verify

```bash
curl -s localhost:28350/health | jq
curl -sH "Authorization: Bearer $AUTH_TOKEN" localhost:28350/v1/tip | jq
curl -sH "Authorization: Bearer $AUTH_TOKEN" localhost:28350/v1/stats | jq
```

What to look for on a healthy first start:

- `/v1/tip` → `lagBlocks: 0`, or a number that is falling.
- `/v1/stats` → `tap.txSeen` climbing within a minute or two. **If it stays at
  zero while the mempool is busy, `LTC_ZMQ_TX_URL` is almost certainly pointed
  at the `hashtx` port instead of `rawtx`.**
- `/v1/stats` → `tap.coreGaps` at `0`.
- The boot log stating the node's prune floor and that the relay is maintaining
  its own transaction index.

## 4. Exposure

Both ports default to loopback so a half-finished deploy is unreachable rather
than open. To serve a consumer on another host:

```bash
ufw allow from <consumer-ip> to any port 28350 proto tcp
ufw allow from <consumer-ip> to any port 28340 proto tcp
```

The bearer token is the only authentication on the HTTP API, and **ZMQ PUB has
none at all** — anyone who can reach `PUB_BIND` reads every transaction the tap
sees, which is a live view of your deposit flow.

A WireGuard tunnel between the two hosts is the better arrangement. If the HTTP
port crosses anything public, terminate TLS in front of it.

The service names either port at boot if it is bound off-box. That warning is
worth reading rather than filtering out.

## Upgrading

```bash
cd /opt/ltc-replay
git pull
npm ci
npm run build
sudo systemctl restart ltc-replay
```

The journal survives restarts and schema changes are `IF NOT EXISTS`. Catch-up
closes whatever gap the restart opened, and the tap is subscribed before
catch-up runs, so the window is covered from both sides.

Docker: `docker compose up -d --build`. `stop_grace_period: 30s` gives an
in-flight `/v1/replay` stream time to drain.

## Rebuilding the journal from scratch

The journal is disposable. Delete it and restart:

```bash
sudo systemctl stop ltc-replay
sudo rm /opt/ltc-replay/data/journal.sqlite*
sudo systemctl start ltc-replay
```

Catch-up rebuilds block history from the node. What is lost is the mempool
sightings inside the retention window, which are recoverable from blocks
anyway, and the index below whatever the node can still serve.

Set `START_HEIGHT` before restarting if you want to backfill from a specific
height rather than the current tip — but nothing can walk below the node's
`pruneheight`.

## Related

- [Configuration](configuration.md) — what every value controls
- [Operations](operations.md) — monitoring, sizing, troubleshooting
- [Pruned nodes](pruned-nodes.md) — read this before configuring Core
