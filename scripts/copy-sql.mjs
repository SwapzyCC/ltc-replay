/**
 * Copies src/**\/*.sql into dist, preserving layout.
 *
 * The journal reads its schema and statements from disk at runtime, resolved
 * relative to the module. tsc only emits JavaScript, so without this step a
 * built image starts, opens the database, and fails on the first query — which
 * is exactly the failure that must not reach production. The loader in
 * src/journal/sql/index.ts names this script when it cannot find a file.
 *
 * Hand-rolled rather than using fs.glob: that landed in Node 22, and this
 * package supports 20.
 */

import { readdir, mkdir, copyFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const from = join(root, "src");
// Mirrors tsconfig.build.json's rootDir: src/x/y.ts emits to dist/x/y.js, so
// src/x/y.sql belongs at dist/x/y.sql.
const to = join(root, "dist");

async function* sqlFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* sqlFiles(full);
    else if (entry.name.endsWith(".sql")) yield full;
  }
}

let copied = 0;
for await (const file of sqlFiles(from)) {
  const target = join(to, relative(from, file));
  await mkdir(dirname(target), { recursive: true });
  await copyFile(file, target);
  console.log(`  ${relative(root, target)}`);
  copied++;
}

if (copied === 0) {
  console.error("copy-sql: no .sql files found under src/ — did the layout change?");
  process.exit(1);
}
console.log(`copy-sql: ${copied} file(s)`);
