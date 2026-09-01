/**
 * Line-oriented logging with no dependencies. Output goes to stdout/stderr so
 * systemd's journal is the only log sink to manage.
 */

type Level = "debug" | "info" | "warn" | "error";

const RANK: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const threshold =
  RANK[(process.env["LOG_LEVEL"] ?? "").trim().toLowerCase() as Level] ??
  RANK.info;

function emit(level: Level, tag: string, msg: string, extra?: unknown): void {
  if (RANK[level] < threshold) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${tag}] ${msg}`;
  const stream = level === "error" || level === "warn" ? console.error : console.log;
  if (extra === undefined) stream(line);
  else stream(line, extra);
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
