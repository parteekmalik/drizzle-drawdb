#!/usr/bin/env node
// Bundles drawDB's SQL importer into a single self-contained ESM module so the
// published CLI does not depend on the vendored checkout at runtime.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdirSync } from "node:fs";

const root = dirname(dirname(fileURLToPath(import.meta.url)));

await build({
  entryPoints: [join(root, "scripts/importer-entry.mjs")],
  outfile: join(root, "src/generated/drawdb-import.mjs"),
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  minify: true,
  legalComments: "none",
  logLevel: "warning",
  // drawDB's optional native/binary-free deps are all pure JS.
  define: { "process.env.NODE_ENV": '"production"' },
});

mkdirSync(join(root, "src/generated"), { recursive: true });

console.log("built src/generated/drawdb-import.mjs (drawDB importer bundled)");