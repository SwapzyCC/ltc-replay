/**
 * Loads the schema and the named statements from the .sql files beside this
 * module.
 *
 * Read from disk rather than inlined as template literals so the same text an
 * operator pastes into the sqlite3 CLI is the text the service runs. The build
 * copies *.sql into dist alongside the compiled JS (see scripts/copy-sql.mjs),
 * which is why the path resolves relative to `import.meta.url` and not to the
 * working directory.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Every statement the journal prepares. Adding one here is a compile error until queries.sql defines it. */
export const QUERY_NAMES = [
  "insertTx",
  "insertBlock",
  "insertReorg",
  "insertBlockTx",
  "insertAddressTx",
  "deleteBlocksFrom",
  "deleteBlockTxsFrom",
  "eventsSince",
  "tipSeq",
  "lastBlock",
  "blockAtHeight",
  "seqAtOrAfterHeight",
  "findTx",
  "findTxEvent",
  "txIndexFloor",
  "addressEntries",
  "addressCount",
  "pruneTx",
  "pruneBlockTxs",
  "pruneAddressTxs",
  "countEvents",
  "countTxs",
  "countBlocks",
  "countBlockTxs",
  "countAddressTxs",
  "getMeta",
  "setMeta",
] as const;

export type QueryName = (typeof QUERY_NAMES)[number];

const NAME_MARKER = /^--\s*name:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/;

function read(file: string): string {
  try {
    return readFileSync(join(here, file), "utf8");
  } catch (err: unknown) {
    // Almost always a build that compiled the TypeScript without copying the
    // SQL. Say so, rather than letting it surface as a bare ENOENT.
    throw new Error(
      `cannot read ${file} from ${here} — if this is a built artefact, the ` +
        "build did not copy *.sql into dist (npm run build)",
      { cause: err },
    );
  }
}

export function loadSchema(): string {
  return read("schema.sql");
}

/**
 * Splits queries.sql on its `-- name:` markers.
 *
 * Both directions are checked: a name the journal expects but the file does
 * not define, and a query defined here that nothing prepares. Either is a
 * startup failure, because the alternative is a route that throws the first
 * time someone calls it in production.
 */
export function loadQueries(): Record<QueryName, string> {
  const text = read("queries.sql");
  const found = new Map<string, string[]>();

  let current: string[] | null = null;
  for (const line of text.split(/\r?\n/)) {
    const marker = NAME_MARKER.exec(line);
    if (marker?.[1]) {
      current = [];
      if (found.has(marker[1])) throw new Error(`queries.sql defines "${marker[1]}" twice`);
      found.set(marker[1], current);
      continue;
    }
    // Leading commentary before the first marker is file-level documentation.
    if (current) current.push(line);
  }

  const out = {} as Record<QueryName, string>;
  for (const name of QUERY_NAMES) {
    const body = found.get(name)?.join("\n").trim();
    if (!body) throw new Error(`queries.sql is missing a statement named "${name}"`);
    out[name] = body;
    found.delete(name);
  }

  const unclaimed = [...found.keys()];
  if (unclaimed.length > 0) {
    throw new Error(`queries.sql defines statements nothing prepares: ${unclaimed.join(", ")}`);
  }

  return out;
}
