/**
 * Typed readers over `process.env`.
 *
 * On `??`: it fires only on null/undefined, so `process.env.X ?? "default"`
 * happily hands back "" for an `X=` line in a .env file — and an empty string
 * is a perfectly valid-looking password right up until the node rejects it.
 * Every read here goes through `str()`, which treats empty and whitespace-only
 * as unset, so a blank line and a missing line mean the same thing.
 */

import { ConfigError } from "../core/errors.js";

/** A present, non-blank value, or null. */
export function str(key: string): string | null {
  const v = process.env[key];
  if (v === undefined) return null;
  const t = v.trim();
  return t === "" ? null : t;
}

export function required(key: string): string {
  const v = str(key);
  if (v === null) throw new ConfigError(`${key} is required and is not set`);
  return v;
}

export function int(key: string, fallback: number, min: number, max: number): number {
  const v = str(key);
  if (v === null) return fallback;

  const n = Number.parseInt(v, 10);
  if (!Number.isFinite(n)) throw new ConfigError(`${key} must be an integer, got "${v}"`);
  if (n < min || n > max) {
    throw new ConfigError(`${key} must be between ${min} and ${max}, got ${n}`);
  }
  return n;
}

export function bool(key: string, fallback: boolean): boolean {
  const v = str(key);
  if (v === null) return fallback;

  const lowered = v.toLowerCase();
  if (["1", "true", "yes", "on"].includes(lowered)) return true;
  if (["0", "false", "no", "off"].includes(lowered)) return false;
  throw new ConfigError(`${key} must be true or false, got "${v}"`);
}

export function zmqUrl(key: string, fallback: string): string {
  const v = str(key) ?? fallback;
  if (!/^(tcp|ipc|inproc):\/\//.test(v)) {
    throw new ConfigError(`${key} must be a ZMQ endpoint such as tcp://host:port, got "${v}"`);
  }
  return v;
}
