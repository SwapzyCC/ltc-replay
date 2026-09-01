/**
 * The replay API.
 *
 * Consumers arrive in one of a few states, and there is an endpoint for each:
 *
 *   /v1/events         — "I have seq N, what came after?" Cursor-based and
 *                        cheap, including raw mempool sightings still inside
 *                        retention.
 *   /v1/replay         — "I processed up to block H, stream me the rest."
 *                        Blocks with their full transactions, as NDJSON.
 *   /v1/tx/:txid       — "Is this confirmed?" The stand-in for
 *                        `getrawtransaction`, which a pruned node cannot answer.
 *   /v1/address/:addr  — "What has paid this address?" Split into confirmed
 *                        and unconfirmed.
 *
 * This module owns only the wiring: the server, the auth gate, and the
 * top-level error boundary. Handlers live in ./routes.
 */

import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { makeAuthoriser, unauthorised } from "./auth.js";
import { resolve, notFound, methodNotAllowed } from "./router.js";
import { json } from "./respond.js";
import type { ApiDeps } from "./context.js";
import { logger, errMsg } from "../core/log.js";

export type { ApiDeps } from "./context.js";

const log = logger("http");

/** Beyond this, a URL is a probe rather than a request. */
const MAX_URL_LENGTH = 2_048;

export function createApi(deps: ApiDeps): Server {
  const authorised = makeAuthoriser(deps.cfg.authToken);

  const server = createServer((req, res) => {
    void handle(req, res).catch((err: unknown) => {
      log.error(`${req.method ?? "?"} ${req.url ?? "?"} failed`, errMsg(err));
      // Once the stream is open the status is spent and the detail has already
      // gone to the log; all that is left is to stop cleanly.
      if (!res.headersSent) json(res, 500, { error: "internal_error", detail: errMsg(err) });
      else res.end();
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const raw = req.url ?? "/";
    if (raw.length > MAX_URL_LENGTH) return json(res, 414, { error: "uri_too_long" });

    const url = new URL(raw, "http://localhost");
    const path = url.pathname.replace(/\/+$/, "") || "/";
    const method = req.method ?? "GET";

    if (method !== "GET" && method !== "HEAD") return methodNotAllowed(res);

    const route = resolve(deps, method, path, url, req, res);

    // /health answers before the auth gate so an uptime probe needs no secret.
    if (route?.isPublic) return await route.run();

    // Authentication is checked before the route is known to exist, so an
    // unauthenticated scan cannot use 404-vs-401 to map the API surface.
    if (!authorised(req)) return unauthorised(res);
    if (!route) return notFound(res);

    await route.run();
  }

  return server;
}
