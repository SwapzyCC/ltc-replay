# TLS endpoints with nginx

Core's ZMQ has no encryption and no authentication. Core's JSON-RPC has Basic
auth and no TLS, so its credentials cross the wire in base64 — which is to say
in the clear. Neither can leave the node's host as-is.

If you already terminate TLS in front of both, that work is done and this page
is mostly about the other side of the wire: **[pointing the relay at your
endpoints](#1-point-the-relay-at-your-endpoints)**, then **[running it in
Docker](#2-run-the-relay-in-docker)**. The node-side configs are kept in
[`deploy/nginx/`](../deploy/nginx/) as [reference](#5-reference-the-node-side-configs)
for a rebuild or a second node — not as steps to follow.

## The shape

```mermaid
flowchart LR
  subgraph node["Node host"]
    core["litecoind<br/>28333 hashblock<br/>28334 rawtx<br/>9332 RPC"]
    authp["ZMQ PLAIN auth proxy<br/>127.0.0.1:39033/39034"]
    nginx["nginx<br/>stream: 28333, 28334<br/>http: 9332"]
    core -->|"loopback, plain"| authp
    authp -->|"loopback, plain"| nginx
    core -->|"loopback, plain"| nginx
  end
  subgraph consumer["Wherever the relay runs"]
    app["ltc-replay"]
    api["nginx to :28350<br/>(only if the API leaves the host)"]
    app --- api
  end
  nginx -->|"TLS"| app
  api -->|"TLS"| backend["wallet backend"]
```

Two distinct jobs on the node side, and it is worth being precise about which
layer does which:

**nginx provides confidentiality and _server_ authentication.** It terminates
TLS and forwards a decrypted byte stream to loopback. For the ZMQ ports it
never parses ZMTP and never sees the PLAIN handshake — that runs end to end
between the relay's libzmq and the auth proxy, inside the tunnel.

**The auth proxy provides _client_ authentication.** It is the only thing
standing between a port scan and a live view of your deposit flow. TLS without
it gets you an encrypted channel to a service that will talk to anyone.

## 1. Point the relay at your endpoints

The transport comes from the URI scheme — there is no separate "use TLS"
setting. See [Configuration](configuration.md) for every value.

```dotenv
LTC_ZMQ_TX_URL=tls://zmquser:PASSWORD@zmq.example.dev:28334
LTC_ZMQ_BLOCK_URL=tls://zmquser:PASSWORD@zmq.example.dev:28333
LTC_RPC_URL=https://rpcuser:PASSWORD@rpc.example.dev:9332
AUTH_TOKEN=<a long random string>
```

Four things to get right:

**Percent-encode the password.** `@ : / %` become `%40 %3A %2F %25`. Core's
`rpcauth` generator emits `$` and other delimiters freely, so this is the normal
case rather than an edge one. The value is decoded byte-exact before use; a
password that is not encoded produces a parse error at boot, not a silent 401.

**Get 28334 and 28333 the right way round.** 28334 is `rawtx`, 28333 is
`hashblock`. Crossing them is silent: each socket subscribes to a topic its
publisher never sends, and the result looks exactly like a chain that has gone
quiet. If your public port numbers differ from Core's, check them against what
the auth proxy actually forwards to rather than against the number's usual
meaning.

**`tls://` never degrades to `tcp://`.** A certificate that does not verify, or
a hostname that does not match, drops the connection rather than continuing in
the clear. That is deliberate — a fallback here would be a downgrade attack
with a friendly name.

**If the relay runs on the node's own host, do not use the public names.** They
resolve back to the same machine, so `tls://` there buys a TLS handshake and an
nginx hop to reach a service one bridge away. Go straight to the auth proxy, or
straight to Core:

```dotenv
LTC_ZMQ_TX_URL=tcp://zmquser:PASSWORD@127.0.0.1:39034
LTC_ZMQ_BLOCK_URL=tcp://zmquser:PASSWORD@127.0.0.1:39033
LTC_RPC_URL=http://rpcuser:PASSWORD@127.0.0.1:9332
```

The wallet backend reads the same URI format, so this is the same change on
either side.

## 2. Run the relay in Docker

The full walkthrough is in [Deployment](deployment.md); this is what changes
when the endpoints are remote rather than loopback.

```bash
cp .env.example .env    # then set the four values above
mkdir -p data
docker compose up -d --build
docker compose logs -f
```

**Use the bridge shape, not host networking.** `docker-compose.yml` ships two:
Shape A joins litecoind's network, Shape B is `network_mode: host`. Both exist
for a relay sitting next to Core. When the endpoints are remote the container
needs no host network at all — plain bridge networking reaches
`zmq.example.dev` like any other outbound connection.

```yaml
services:
  ltc-replay:
    build: .
    restart: unless-stopped
    env_file: .env
    volumes:
      - ./data:/app/data
    ports:
      - "127.0.0.1:28350:28350" # bind loopback; section 3 exposes it deliberately
    stop_grace_period: 30s
```

**Loopback in the URI means the container's loopback.** If you kept the
`127.0.0.1:39034` form from section 1 because Core is on the same host, the
container cannot reach it — `127.0.0.1` inside a container is the container's
own stack. That is what Shape B (`network_mode: host`) is for. Remote TLS
endpoints have no such problem, which is one more reason to prefer the bridge
when they are remote.

**Keep `./data` on a real volume.** The journal is a SQLite file, and losing it
means re-scanning from the configured start height. `stop_grace_period: 30s`
gives it time to check the journal in cleanly rather than recovering a WAL on
next boot.

**The container's clock matters for TLS.** A host with a badly skewed clock
makes every certificate look expired or not-yet-valid, and the error says so in
a way nobody reads as "fix NTP".

## 3. nginx for the relay's own API

Only needed if something off-box calls the relay. If the wallet backend runs
beside it, leave the API bound to `127.0.0.1:28350` and skip this.

The relay's only authentication is the bearer token in `AUTH_TOKEN`. That token
is enough to read the deposit history of every watched address, and over plain
HTTP it is sent on every request in the clear. If the API crosses anything
public, it crosses it under TLS.

```bash
cp deploy/nginx/http-replay-api.conf /etc/nginx/conf.d/replay.conf
# edit the hostname and certificate paths
nginx -t && nginx -s reload
```

This one is an ordinary `http`-level config, so `conf.d/` is the right place —
unlike the ZMQ file in section 5. Three settings in it are not cosmetic:

- **`proxy_read_timeout 900s`.** `/v1/replay` streams a range of blocks and can
  run for minutes on a large gap — exactly when it matters most. The 60-second
  default truncates it, and the consumer sees a short body rather than an error.
- **`proxy_buffering off`** with `chunked_transfer_encoding on`, so blocks reach
  the consumer as they are produced instead of after the whole range finishes.
- **A separate `location = /health`** with `access_log off`. It is
  unauthenticated by design and reports the process, not the chain — worth
  keeping reachable and worth keeping out of the log.

Pin the caller if you can. The consumer is your own backend at a known address:

```nginx
allow 203.0.113.10;
deny  all;
```

Certificates come from certbot as usual; the config leaves
`/.well-known/acme-challenge/` reachable on port 80 so renewal is not swallowed
by the HTTPS redirect.

### If nginx itself runs in Docker

One trap that costs an afternoon: **`127.0.0.1` inside a container is the
container's own loopback.** A containerised nginx with
`proxy_pass http://127.0.0.1:28350` reaches nothing. Either give it the host's
network stack:

```yaml
services:
  nginx:
    image: nginx:1.27-alpine
    network_mode: host
    restart: unless-stopped
    volumes:
      - ./deploy/nginx/http-replay-api.conf:/etc/nginx/conf.d/replay.conf:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
```

…or put both on the same compose network and proxy to the service name
(`proxy_pass http://ltc-replay:28350;`), which is cleaner when nginx and the
relay are the only two containers involved.

## 4. Verifying

Bottom-up, so a failure names its own cause.

```bash
# 1. TLS terminates and the certificate matches the name.
openssl s_client -connect zmq.example.dev:28334 -servername zmq.example.dev </dev/null 2>&1 \
  | grep -E 'subject=|Verify return code|Protocol'

# 2. RPC end to end, credentials and all.
curl -sS --user "$LTC_RPC_USER:$LTC_RPC_PASSWORD" \
  --data '{"jsonrpc":"1.0","id":"t","method":"getblockchaininfo","params":[]}' \
  https://rpc.example.dev:9332 | jq '{chain,blocks,pruned}'

# 3. The relay is up.
curl -s localhost:28350/health | jq

# 4. The tap is actually receiving.
curl -sH "Authorization: Bearer $AUTH_TOKEN" localhost:28350/v1/stats | jq '.tap'
```

`tap.txSeen` climbing within a minute or two is the proof that the whole path
works. If it stays at zero while the mempool is busy, the tunnel is up but the
subscription is wrong — see the table below.

## 5. Reference: the node-side configs

Kept for a rebuild, a second node, or a co-tenant who needs the same
publishers. Skip this if your termination is already in place.

The port convention the configs assume:

| Core topic  | Core port | Auth proxy port   | Public TLS port |
| ----------- | --------- | ----------------- | --------------- |
| `hashtx`    | 28332     | `127.0.0.1:39032` | —               |
| `hashblock` | 28333     | `127.0.0.1:39033` | 28333           |
| `rawtx`     | 28334     | `127.0.0.1:39034` | 28334           |
| `rawblock`  | 28335     | `127.0.0.1:39035` | —               |
| `sequence`  | 28336     | `127.0.0.1:39036` | —               |

The relay needs `rawtx` and `hashblock`. A port you do not expose cannot be
attacked.

Core cannot authenticate ZMQ itself — `litecoind` publishes on a bare PUB
socket with the NULL mechanism and has no setting to change that. Whatever sits
in front must bind loopback only, use one port per topic (Core's topics are
separate publishers and cannot share a port), and republish payloads verbatim,
since the tap decodes raw transaction bytes and a re-framed payload is useless.

**The `stream` block is not inside `http`.** This is the step that catches
everyone. The ZMQ ports are raw TCP, so they belong in nginx's `stream` block —
a sibling of `http`, not a child. A file dropped into `conf.d/` is loaded
inside `http` and fails with `"proxy_pass" directive is not allowed here`, or
is silently ignored.

```nginx
# /etc/nginx/nginx.conf, outside http { }
stream {
    log_format basic '$remote_addr [$time_local] $protocol $status '
                     '$bytes_sent $bytes_received $session_time';
    include /etc/nginx/stream.d/*.conf;
}
```

```bash
apt-get install -y libnginx-mod-stream        # if your build separates it
nginx -V 2>&1 | tr ' ' '\n' | grep -E 'stream|ssl'
mkdir -p /etc/nginx/stream.d

cp deploy/nginx/stream-zmq.conf /etc/nginx/stream.d/zmq.conf
cp deploy/nginx/http-rpc.conf   /etc/nginx/conf.d/rpc.conf
nginx -t && nginx -s reload
```

Note where each file goes — `stream.d` for ZMQ, `conf.d` for RPC.

`proxy_timeout 1h` on the stream servers is the other setting that is not
cosmetic. A ZMQ subscriber holds one connection open and sends nothing on it;
nginx's 10-minute default counts silence as death and closes it. libzmq
reconnects, so the symptom is not an outage but a periodic reconnect that loses
whatever was published during it.

**Certificates.** `stream` servers cannot answer an HTTP-01 challenge — there
is no HTTP there to answer it with. Use `--standalone` on port 80 if it is
free, or DNS-01 if it is not. Either way renewal must reload nginx, because
`stream` servers do not pick up a new certificate on their own:

```bash
printf '#!/bin/sh\nnginx -s reload\n' > /etc/letsencrypt/renewal-hooks/deploy/nginx-reload
chmod +x /etc/letsencrypt/renewal-hooks/deploy/nginx-reload
```

Without that hook everything works for 90 days and then stops — the worst
possible failure interval, long enough that nobody connects the outage to the
deploy.

**Firewall.** Only the TLS ports go out; the auth proxy ports stay on loopback.

```bash
ufw allow from 203.0.113.10 to any port 28333,28334,9332 proto tcp
```

## When it does not work

| Symptom                                                     | Cause                                                                                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| Boot fails naming `LTC_ZMQ_TX_URL` or `LTC_RPC_URL`         | The URI is malformed — usually an unencoded `@` or `$` in the password. The message names the variable and never prints the password. |
| `ltc-zmq TLS tunnel failed` in the logs                     | Certificate does not verify, or the hostname does not match. Check with section 4 step 1. This is never downgraded to plaintext.      |
| Tunnel connects, `tap.txSeen` stays at 0                    | Subscribed to a topic the publisher never sends — almost always 28333/28334 crossed.                                                 |
| In Docker: `ECONNREFUSED 127.0.0.1`                         | Loopback in the URI is the container's own. Use `network_mode: host`, or the remote TLS endpoint.                                     |
| TLS fails on every certificate at once                      | Host clock skew. Certificates read as expired or not-yet-valid.                                                                      |
| Frames arrive, then stop every ~10 minutes and resume       | Node-side `proxy_timeout` left at nginx's default. See section 5.                                                                    |
| `/v1/replay` returns a truncated body on large gaps         | `proxy_read_timeout` too low on the relay API server. See section 3.                                                                 |
| Everything works for 90 days, then TLS fails                | Certificate renewed without the nginx reload hook. See section 5.                                                                    |
| RPC returns 401 through nginx but works on loopback         | The `Authorization` header is being dropped. Keep `proxy_set_header Authorization $http_authorization;`.                              |
| `nginx: [emerg] "proxy_pass" directive is not allowed here` | A stream config landed in `conf.d/`. See section 5.                                                                                  |
| `nginx -t` passes but the ZMQ ports do not listen           | `stream { }` missing from `nginx.conf`, so `stream.d/` is never included. Nothing warns about this.                                   |

## Related

- [Deployment](deployment.md) — node config, systemd, and the Docker walkthrough
- [Configuration](configuration.md) — what every value controls
- [Operations](operations.md) — monitoring, sizing, troubleshooting
