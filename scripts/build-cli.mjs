#!/usr/bin/env node
// Bundles the CLI into a single ESM executable.
import { build } from "esbuild";
import { chmod, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outfile = join(root, "dist/cli.js");

await mkdir(dirname(outfile), { recursive: true });

await build({
  entryPoints: [join(root, "src/cli.ts")],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  minify: false,
  legalComments: "none",
  logLevel: "warning",
  banner: { js: "#!/usr/bin/env node" },
  external: ["jiti"],
});

await chmod(outfile, 0o755);
console.log("built dist/cli.js");