# Changelog

Notable changes to ltc-replay. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

For this service, "breaking" means any of: a response field a consumer reads
disappears or changes meaning, a required setting is added, or the journal
schema changes in a way that needs a rebuild.

## [Unreleased]

### Added

- `docs/tls-endpoints.md` — running the relay against a node whose ZMQ and RPC
  are behind TLS, and the nginx config for exposing the relay's own API.
- `deploy/nginx/` — three reference configs: stream-level TLS for the ZMQ
  publishers, TLS for Core's JSON-RPC, and TLS for the replay API.
- Public-repository files: licence, security policy, contribution guide, CI.

### Fixed

- `docker-compose.yml` set `LTC_RPC_URL`, `LTC_ZMQ_TX_URL` and
  `LTC_ZMQ_BLOCK_URL` in its `environment:` block, which overrides `env_file`.
  A `.env` pointing at a node outside the Docker network was silently discarded
  and the relay connected to `litecoind:9332` instead. The three are now
  `${VAR:-default}`, so `.env` wins and the container names remain the
  fallback. `HTTP_PORT`, `DB_PATH` and `LOG_FORMAT` follow `.env` too.

### Changed

- Under Docker, `HTTP_BIND` now sets the **host-side** publish address. The
  process always binds `0.0.0.0` inside the container, because a container
  process on `127.0.0.1` is reachable from nothing. Two Docker-only variables,
  `PUB_PORT` and `PUB_BIND_HOST`, exist because compose cannot split a URI.

## [1.0.0] - 2026-09-02

First public release.

### Added

- **Durable ZMQ tap.** Subscribes to Core's `rawtx` and `hashblock`, journals
  every frame before re-publishing it on `PUB_BIND`, so a consumer that
  restarts can ask for what it missed. Existing Core subscribers work unchanged
  by pointing at the relay instead of the node.
- **Catch-up.** Walks the chain over JSON-RPC to cover the relay's own
  downtime, so a host reboot is survivable rather than a permanent gap.
- **Indexes a pruned node cannot keep.** `prune` and `txindex` are mutually
  exclusive in Core, which leaves `getrawtransaction` unable to answer about a
  confirmed watch-only deposit. A txid → block index (bounded by
  `TX_INDEX_BLOCKS`) and an address → received-output index close that.
- **Watchlist.** Nothing is indexed until an address is registered through
  `POST /v1/watch`; every other transaction is decoded, counted and dropped.
  The database is sized by your deposits rather than by Litecoin.
- **Reorg detection.** A block that is no longer the block the node has at that
  height is recorded as a `reorg` event and the journal re-walks, so a consumer
  that credited against an orphaned branch can find out.
- **Core-drop visibility.** Per-topic sequence gaps mean Core's high-water mark
  discarded frames — otherwise entirely silent. Logged and counted in
  `/v1/stats`.
- **Coverage on every answer.** Lookups report `indexedFrom` / `indexedTo` /
  `coverage.lagBlocks`, so "I have no record of it" stays distinguishable from
  "it did not happen".
- **HTTP API** — `/health`, `/v1/tip`, `/v1/events`, `/v1/replay` (NDJSON
  stream), `/v1/block/:hash`, `/v1/tx/:txid`, `/v1/address/:address`,
  `/v1/stats`, and the `/v1/watch` set. Bearer token on everything but
  `/health`.
- **Endpoint URIs carry their own credentials and transport.** `tcp://`,
  `tls://` for ZMQ and `http://`, `https://` for JSON-RPC, with
  percent-decoded userinfo. `tls://` reaches a TLS-terminating proxy through a
  loopback bridge, since libzmq has no TLS transport; it never degrades to
  plaintext.
- **Credentials stay out of logs.** Errors name the setting, never its value.
  Tests assert this by searching every rejection message for the fixture
  password.
- Dependency-free TypeScript consumer client in `client/`.
- Deployment for systemd and Docker, a `litecoin.conf` snippet, and eight
  documents under `docs/`.

[unreleased]: https://github.com/BackStacked/ltc-replay/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/BackStacked/ltc-replay/releases/tag/v1.0.0
