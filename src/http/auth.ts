/**
 * Bearer-token authentication.
 *
 * The replay history maps every watched address to the transactions that
 * funded it. That is not public data, so everything except /health is behind
 * this check.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { json } from "./respond.js";

export type Authoriser = (req: IncomingMessage) => boolean;

/**
 * Both sides are hashed before comparison so the constant-time compare gets
 * two equal-length buffers. Comparing the raw strings would leak the real
 * token's length through `timingSafeEqual`'s length check, which throws
 * rather than returning false on a mismatch.
 */
export function makeAuthoriser(token: string): Authoriser {
  const expected = createHash("sha256").update(token).digest();

  return (req: IncomingMessage): boolean => {
    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match?.[1]) return false;
    const given = createHash("sha256").update(match[1]).digest();
    return timingSafeEqual(given, expected);
  };
}

export function unauthorised(res: ServerResponse): void {
  res.setHeader("www-authenticate", 'Bearer realm="ltc-replay"');
  json(res, 401, { error: "unauthorized" });
}
