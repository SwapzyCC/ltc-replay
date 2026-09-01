/**
 * A minimal .env reader.
 *
 * Deliberately not a dependency: the file format this needs is twenty lines of
 * parsing, and a service that handles deposits should be able to account for
 * everything that runs before it opens a socket.
 *
 * Values already present in the real environment always win. That is what lets
 * systemd, Docker, or a secrets manager override a checked-out .env without
 * anyone having to remember to delete the file first.
 */

import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Walks up from this module to the package root, which is where .env lives. */
function defaultPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", ".env");
}

export function loadDotEnv(path?: string): void {
  const file = path ?? defaultPath();

  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return; // No .env is fine — the environment may be supplied by the supervisor.
  }

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const eq = trimmed.indexOf("=");
    if (eq < 1) continue;

    const key = trimmed.slice(0, eq).trim();
    if (process.env[key] !== undefined) continue;

    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}
