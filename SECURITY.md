# Security policy

This service sits on a Litecoin node's host, holds that node's RPC credentials,
and answers the question a wallet backend uses to decide whether to credit
someone money. Bugs here are not cosmetic.

## Reporting a vulnerability

**Do not open a public issue.** Use GitHub's private reporting:

> **Security** tab → **Report a vulnerability**

That opens a private advisory only you and the maintainers can read.

What helps, in rough order of usefulness: the version or commit, the
configuration that triggers it (redacted), what you expected, what happened,
and a reproduction — a failing test against `test/` is worth more than a
paragraph.

**Never include real credentials, real addresses or real transaction IDs in a
report.** The example values in `.env.example` and the test fixtures exist for
exactly this. A report that leaks a live RPC password creates a second incident.

You can expect an acknowledgement within 72 hours and an assessment within a
week. Fixes go out as a patch release with an advisory; you get credit unless
you ask not to. There is no bounty programme.

## What is in scope

The bar is: **anything that makes the relay lie about money, or leaks the keys
to the node.**

- Reading or writing any `/v1/*` endpoint without a valid bearer token, or a
  timing oracle on the token comparison.
- Reporting a transaction as confirmed when it is not, or omitting one that is.
- Losing or mis-recording a reorg, so a consumer never learns a credited block
  was orphaned.
- Any credential — RPC password, ZMQ PLAIN password, bearer token — reaching a
  log line, an error message, an HTTP response, or a crash dump.
- A `tls://` ZMQ endpoint being served over plaintext, or connecting despite a
  certificate or hostname that does not verify.
- Injection through any path or query parameter that reaches SQL.
- Journal corruption, or a crash that leaves the database unrecoverable.
- Unbounded resource growth reachable by an authenticated caller —
  `/v1/watch` and `/v1/replay` are the ones to look at.
- Anything in `Dockerfile` or `deploy/` that grants more privilege than the
  service needs.

## What is out of scope

Not because they do not matter, but because they are known and deliberate.
Argue with a design decision in an issue rather than an advisory.

- **`GET /health` is unauthenticated.** It reports process liveness and nothing
  about the chain. That is the point.
- **The loopback leg of the TLS bridge is plaintext.** `tls://` endpoints are
  terminated on `127.0.0.1` because libzmq has no TLS transport and no way to
  adopt an established socket. The unencrypted hop never leaves the machine and
  is inside the same trust boundary as the process holding the password. The
  reasoning is written out in `src/chain/zmq/tls-bridge.ts`.
- **A malicious or compromised node.** The relay trusts its own node completely,
  by design. If your `litecoind` lies to you, nothing downstream can help.
- **Denial of service by someone who already has the bearer token.** The token
  is the trust boundary; guard it accordingly.
- **An endpoint you exposed publicly without the reverse proxy.** Rate limiting
  and TLS live in `deploy/nginx/`; see [docs/tls-endpoints.md](docs/tls-endpoints.md).
- **`ZMQ PUB` on `PUB_BIND` has no authentication of any kind.** It is loopback
  by default and documented as such. Binding it to `0.0.0.0` publishes your
  deposit flow to anyone who asks.
- Missing hardening headers on an API that serves only JSON to machines.
- Dependency advisories with no reachable path from this code — say which call
  path reaches it and it becomes in scope.

## Supported versions

The `main` branch and the most recent tagged release. There are no long-term
support branches; the fix for anything found in an older tag is to upgrade.

## Operating it safely

Two failure modes cause more real-world loss than any bug in this repository:

**A crossed ZMQ endpoint.** `LTC_ZMQ_TX_URL` pointed at `hashtx` instead of
`rawtx` decodes nothing, indexes nothing, and looks perfectly healthy. Watch
`tap.txSeen` in `/v1/stats`; if it sits at zero while the mempool is busy, that
is why.

**Trusting an empty answer.** Every lookup reports the range it can speak for
(`indexedFrom` / `indexedTo` / `coverage.lagBlocks`). "I have no record of it"
and "it did not happen" are different answers, and a consumer that treats them
alike will eventually drop a real deposit. See
[docs/integration.md](docs/integration.md).
