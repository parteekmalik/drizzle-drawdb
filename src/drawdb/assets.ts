import { existsSync, readdirSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { CliError } from "../errors";
import { packageRoot } from "../paths";

const execFileAsync = promisify(execFile);

/** Commit of drawDB this integration is pinned to. */
export const PINNED_DRAWDB_COMMIT = "d9c0d39c6ae85d30058f3c32fc1af571dc25e456";

export interface DrawDbCheckout {
  /** Root of the drawDB checkout. */
  root: string;
  /** Built static assets. */
  dist: string;
}

export interface ResolveCheckoutOptions {
  /** Explicit `--drawdb-dir` value. */
  dir?: string | undefined;
  /** Build the app if `dist/` is missing. */
  ensureBuild?: boolean;
}

/**
 * Locates the pinned drawDB checkout carrying our extension.
 *
 * The extension is applied as a patch (see patches/), so this function also
 * verifies the patch is present and fails loudly rather than silently serving an
 * upstream build that cannot load our diagrams.
 */
export async function resolveDrawDbCheckout(
  options: ResolveCheckoutOptions = {},
): Promise<DrawDbCheckout> {
  const candidates = [
    options.dir,
    process.env.DRAWDB_DIR,
    join(packageRoot(), "vendor", "drawdb"),
    join(packageRoot(), "drawdb-editor"),
  ];

  let root: string | undefined;
  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) {
      root = resolve(candidate);
      break;
    }
  }

  if (!root) {
    throw new CliError(`drawDB checkout not found.`, {
      hint:
        "Clone the pinned revision and apply the extension patch:\n" +
        "  git clone https://github.com/drawdb-io/drawdb.git vendor/drawdb\n" +
        `  git -C vendor/drawdb checkout ${PINNED_DRAWDB_COMMIT}\n` +
        "  git -C vendor/drawdb apply <path>/patches/0001-local-diagram-extension.patch\n" +
        "Or pass --drawdb-dir <path>.",
    });
  }

  const isPrebuiltDist = root.endsWith("drawdb-editor") || root.includes("drawdb-editor");

  // When using the committed prebuilt dist (drawdb-editor/), skip source checks.
  if (!isPrebuiltDist) {
    if (!existsSync(join(root, "package.json"))) {
      throw new CliError(`drawDB checkout not found at ${root}.`, {
        hint:
          "Clone the pinned revision and apply the extension patch:\n" +
          "  git clone https://github.com/drawdb-io/drawdb.git vendor/drawdb\n" +
          `  git -C vendor/drawdb checkout ${PINNED_DRAWDB_COMMIT}\n` +
          "  git -C vendor/drawdb apply <path>/patches/0001-local-diagram-extension.patch\n" +
          "Or pass --drawdb-dir <path>.",
      });
    }

    const extensionPath = join(root, "src", "extensions", "localDiagram.js");
    if (!existsSync(extensionPath)) {
      throw new CliError(
        `The drawDB checkout at ${root} does not contain the drizzle-drawdb extension.`,
        {
          hint:
            "Apply the patch first:\n" +
            "  git -C <path> apply /path/to/drizzle-drawdb/patches/0001-local-diagram-extension.patch\n" +
            "Re-checkout and re-apply if upstream changed.",
        },
      );
    }
  }

  // For the committed prebuilt dist (drawdb-editor/), root IS the dist directory.
  const dist = isPrebuiltDist ? root : join(root, "dist");
  const distIndex = join(dist, "index.html");

  if (!isPrebuiltDist && options.ensureBuild !== false && (!existsSync(distIndex) || isStale(root, distIndex))) {
    await buildDrawDb(root);
  }

  if (!existsSync(distIndex)) {
    throw new CliError(`drawDB has not been built (missing ${distIndex}).`, {
      hint: `Run \`npm run build\` in ${root}.`,
    });
  }

  return { root, dist };
}

/**
 * Rebuilds when drawDB's source is newer than its bundle.
 *
 * Without this, applying the extension patch to an already-built checkout
 * silently serves a bundle that cannot load our diagrams.
 */
function isStale(root: string, distIndex: string): boolean {
  try {
    const builtAt = statSync(distIndex).mtimeMs;
    const sourceDir = join(root, "src");

    for (const entry of readdirSync(sourceDir, { withFileTypes: true, recursive: true })) {
      if (!entry.isFile()) continue;

      const path = join(entry.parentPath ?? sourceDir, entry.name);
      if (statSync(path).mtimeMs > builtAt) return true;
    }
  } catch {
    // If we cannot tell, assume the existing build is good rather than
    // rebuilding on every invocation.
    return false;
  }

  return false;
}

async function buildDrawDb(root: string): Promise<void> {
  process.stderr.write("Building drawDB (first run only, this takes a moment)…\n");

  try {
    await execFileAsync("npm", ["run", "build"], {
      cwd: root,
      maxBuffer: 32 * 1024 * 1024,
      env: { ...process.env, NODE_ENV: "production" },
    });
  } catch (error) {
    throw new CliError(`Failed to build drawDB in ${root}.`, {
      hint: error instanceof Error ? error.message : String(error),
    });
  }
}