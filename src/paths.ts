import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Locates the drizzle-drawdb package root regardless of where this module ends
 * up (bundled into `dist/cli.js` vs. running from `src/`), by walking upward
 * until it finds this package's own manifest.
 */
export function packageRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));

  for (;;) {
    const manifest = join(dir, "package.json");

    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as { name?: string };
        if (parsed.name === "drizzle-drawdb") return dir;
      } catch {
        // Unreadable manifest: keep walking.
      }
    }

    const parent = dirname(dir);
    if (parent === dir) {
      throw new Error(
        "Could not locate the drizzle-drawdb package root (no package.json named drizzle-drawdb found above this module).",
      );
    }

    dir = parent;
  }
}