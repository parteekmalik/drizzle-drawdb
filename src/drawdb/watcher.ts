import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

/**
 * Watches the drizzle config and every file matching the config's `schema`
 * globs, and reports changes so the diagram can be regenerated.
 *
 * Deliberately dependency-free: `fs.watch` is not recursive on Linux and
 * cannot watch files that do not exist yet, so we poll a pruned walk of the
 * project instead. Polling is also what makes newly added schema files
 * visible without restarting the CLI. The interval is short enough to feel
 * live; the debounce coalesces editor save bursts into one reload.
 */

export interface SchemaWatchOptions {
  /** Directory that holds the drizzle config; globs resolve against it. */
  projectRoot: string;
  /** Absolute path to the drizzle config file. */
  configPath: string;
  /** `schema` globs from the config, relative to `projectRoot`. */
  schemas: string[];
  /** Poll cadence. Default 500ms. */
  intervalMs?: number;
  /** Quiet period between the last detected change and the callback. Default 400ms. */
  debounceMs?: number;
  /** Called (after debouncing) with absolute paths of changed files. */
  onChanged: (changed: string[]) => void;
}

export interface SchemaWatchHandle {
  close: () => void;
}

/** Directory names never worth walking when looking for schema files. */
const PRUNED_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  ".idea",
  ".vscode",
  ".next",
  ".nuxt",
  ".turbo",
  ".cache",
  "coverage",
]);

interface GlobTarget {
  /** Closest directory that can contain the glob's matches. */
  dir: string;
  /** The glob compiled to an anchored RegExp over absolute posix paths. */
  pattern: RegExp;
}

export function startSchemaWatch(options: SchemaWatchOptions): SchemaWatchHandle {
  const root = resolve(options.projectRoot);
  const configPath = resolve(options.configPath);
  const intervalMs = options.intervalMs ?? 500;
  const debounceMs = options.debounceMs ?? 400;
  const targets = new Map<string, GlobTarget[]>();

  for (const glob of options.schemas) {
    const pattern = globToRegExp(resolve(root, toPosix(glob)));
    const dir = globBaseDir(root, glob);
    const existing = targets.get(dir) ?? [];
    existing.push({ dir, pattern });
    targets.set(dir, existing);
  }

  let fingerprints = new Map<string, string>();
  let baseline = true;
  let debounceTimer: NodeJS.Timeout | undefined;
  const pending = new Set<string>();
  let closed = false;

  const scan = (): void => {
    if (closed) return;

    const next = new Map<string, string>();

    for (const [dir, globs] of targets) {
      for (const file of walkMatches(dir, globs)) {
        next.set(file, fingerprint(file));
      }
    }

    // The config is watched explicitly: a changed dialect or `schema` glob
    // invalidates the whole pipeline, which only a restart can pick up.
    next.set(configPath, fingerprint(configPath));

    if (baseline) {
      baseline = false;
      fingerprints = next;
      return;
    }

    const changed = new Set<string>();
    for (const [file, mark] of next) {
      if (fingerprints.get(file) !== mark) changed.add(file);
    }
    // A deleted schema file changes the export too, so report removals.
    for (const file of fingerprints.keys()) {
      if (!next.has(file)) changed.add(file);
    }

    fingerprints = next;

    if (changed.size > 0) {
      for (const file of changed) pending.add(file);

      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = undefined;
        const batch = [...pending].sort();
        pending.clear();
        if (!closed && batch.length > 0) options.onChanged(batch);
      }, debounceMs);
    }
  };

  scan();
  const timer = setInterval(scan, intervalMs);
  timer.unref?.();

  return {
    close: () => {
      closed = true;
      if (debounceTimer) clearTimeout(debounceTimer);
      clearInterval(timer);
    },
  };
}

function fingerprint(file: string): string {
  try {
    const stat = statSync(file);
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return "missing";
  }
}

/**
 * Yields existing files under `dir` whose absolute path matches one of the
 * glob's patterns. Symlinked directories are skipped so a stray link cannot
 * send the walk into a cycle.
 */
function walkMatches(dir: string, globs: GlobTarget[]): string[] {
  const matches: string[] = [];
  const stack: string[] = [dir];

  while (stack.length > 0) {
    const current = stack.pop()!;

    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const path = join(current, entry.name);

      if (entry.isDirectory()) {
        if (entry.isSymbolicLink()) continue;
        if (PRUNED_DIRECTORIES.has(entry.name)) continue;
        stack.push(path);
        continue;
      }

      if (!entry.isFile()) continue;
      const posix = toPosix(path);
      if (globs.some((glob) => glob.pattern.test(posix))) {
        matches.push(path);
      }
    }
  }

  return matches;
}

/**
 * Resolves a glob to the closest directory that can contain its matches, so
 * a config like `schema: "./src/schema.ts"` never walks the whole repo.
 */
function globBaseDir(root: string, glob: string): string {
  const posix = toPosix(glob);
  const cutoff = posix.search(/[*?]/);
  const literal = cutoff === -1 ? posix : posix.slice(0, cutoff);
  const dir = literal.endsWith("/")
    ? literal
    : literal.slice(0, literal.lastIndexOf("/") + 1);
  return resolve(root, dir);
}

function toPosix(path: string): string {
  return path.replace(/\\/g, "/");
}

/**
 * Compiles a glob (`*`, `?`, `**`) into an anchored RegExp over posix-style
 * absolute paths. Kept tiny on purpose: drizzle schema globs are simple
 * paths, and a full glob engine is not worth a dependency here.
 */
export function globToRegExp(glob: string): RegExp {
  let source = "^";
  let i = 0;

  while (i < glob.length) {
    const char = glob[i]!;

    if (char === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          // `**/` matches zero or more whole directories.
          source += "(?:[^/]*/)*";
          i += 3;
        } else {
          source += ".*";
          i += 2;
        }
      } else {
        source += "[^/]*";
        i += 1;
      }
      continue;
    }

    if (char === "?") {
      source += "[^/]";
      i += 1;
      continue;
    }

    if ("\\^$.|+()[]{}".includes(char)) {
      source += `\\${char}`;
    } else {
      source += char;
    }
    i += 1;
  }

  return new RegExp(`${source}$`);
}
