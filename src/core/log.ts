/**
 * Line-oriented logging with no dependencies.
 *
 * Two formats, because two audiences read these lines. `text` is for a person
 * following `journalctl -f` during a deploy. `json` is for a log shipper, and
 * is the right default in a container where something downstream is going to
 * parse the stream rather than read it.
 *
 * Everything goes to stdout/stderr and nothing to a file: the supervisor —
 * systemd or Docker — owns rotation and retention, and a service that also
 * writes its own log file gives an operator two places to look and two
 * different answers.
 */

export type Level = "debug" | "info" | "warn" | "error";

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function envLevel(): number {
  const raw = (process.env["LOG_LEVEL"] ?? "").trim().toLowerCase();
  return RANK[raw as Level] ?? RANK.info;
}

function envJson(): boolean {
  return (process.env["LOG_FORMAT"] ?? "").trim().toLowerCase() === "json";
}

let threshold = envLevel();
let asJson = envJson();

/** Re-reads LOG_LEVEL and LOG_FORMAT. Called once the .env file is loaded. */
export function refreshLogSettings(): void {
  threshold = envLevel();
  asJson = envJson();
}

function emit(level: Level, tag: string, msg: string, extra?: unknown): void {
  if (RANK[level] < threshold) return;

  const stream = level === "error" || level === "warn" ? console.error : console.log;

  if (asJson) {
    stream(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        tag,
        msg,
        ...(extra === undefined ? {} : { detail: printable(extra) }),
      }),
    );
    return;
  }

  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}`;
  if (extra === undefined) stream(line);
  else stream(line, extra);
}

/** Keeps an Error from serialising to `{}` inside a JSON log line. */
function printable(value: unknown): unknown {
  if (value instanceof Error) return { name: value.name, message: value.message };
  return value;
}

export interface Logger {
  debug(msg: string, extra?: unknown): void;
  info(msg: string, extra?: unknown): void;
  warn(msg: string, extra?: unknown): void;
  error(msg: string, extra?: unknown): void;
}

export function logger(tag: string): Logger {
  return {
    debug: (m, e) => emit("debug", tag, m, e),
    info: (m, e) => emit("info", tag, m, e),
    warn: (m, e) => emit("warn", tag, m, e),
    error: (m, e) => emit("error", tag, m, e),
  };
}

/** Normalises anything thrown into a printable string. */
export function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
