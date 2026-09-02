# ltc-replay documentation

Start with whichever of these matches what you are trying to do.

| Document                            | Read it when                                                                          |
| ----------------------------------- | ------------------------------------------------------------------------------------- |
| [Architecture](architecture.md)     | You want to know what the service is made of and why each piece exists.               |
| [Pruned nodes](pruned-nodes.md)     | Your node runs with `prune=`. Read this before anything else — it changes the design. |
| [Configuration](configuration.md)   | You are filling in `.env` and want to know what each value actually controls.         |
| [Deployment](deployment.md)         | You are putting this on the node's host, with systemd or with Docker.                 |
| [TLS endpoints](tls-endpoints.md)   | The node's ZMQ or RPC is behind TLS, or the relay runs off-box.                        |
| [API reference](api.md)             | You are calling the HTTP endpoints directly.                                          |
| [Integration guide](integration.md) | You are wiring a deposit monitor or wallet backend to it.                             |
| [Operations](operations.md)         | It is running and you need to watch it, size it, or fix it.                           |

## The one-paragraph version

Litecoin Core's ZMQ is fire-and-forget: it publishes to whoever happens to be
connected and buffers nothing for anyone who is not. A consumer that restarts
never learns what was published while it was away. `ltc-replay` runs on the
node's own host, journals every frame before re-publishing it, walks the chain
over JSON-RPC to cover its own downtime, and answers "what did I miss" over
HTTP. On a pruned node it also maintains the transaction and address indexes
Core cannot, so a confirmed deposit is still resolvable.

## Reading order for a first deploy

1. [Pruned nodes](pruned-nodes.md) — five minutes, and it determines whether
   the rest of your plan is even possible.
2. [Deployment](deployment.md) — node config, then the service.
   [TLS endpoints](tls-endpoints.md) if the relay is not on the node's host.
3. [Configuration](configuration.md) — the two index settings deserve a
   decision rather than a default.
4. [Integration guide](integration.md) — the consumer side, including the
   failure modes that silently lose money if you get them wrong.
