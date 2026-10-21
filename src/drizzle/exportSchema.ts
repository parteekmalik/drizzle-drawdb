import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { CliError } from "../errors";
import type { DiscoveredConfig, ExportedSchema, SupportedDialect } from "../types";

const execFileAsync = promisify(execFile);

export interface ExportSchemaOptions {
  /** Pre-resolved config from `discoverConfig`. */
  config: DiscoveredConfig;
}

/**
 * Runs `drizzle-kit export --sql=true` against the *project's own* installed
 * drizzle-kit, so the DDL always matches the version the project depends on.
 *
 * drizzle-kit resolves `schema` globs relative to its working directory, so it is
 * executed from the directory holding the config file (`config.projectRoot`)
 * rather than the shell's cwd.
 *
 * This is a code-first operation: it reads TypeScript schema files and prints
 * DDL. It does not connect to a database and does not write any files.
 */
export async function exportSchema(
  options: ExportSchemaOptions,
): Promise<ExportedSchema> {
  const { config } = options;
  const workDir = config.projectRoot;
  const bin = resolveDrizzleKitBin(workDir);

  let stdout: string;
  try {
    const result = await execFileAsync(
      process.execPath,
      [bin, "export", "--sql=true", `--config=${config.configPath}`],
      { cwd: workDir, maxBuffer: 64 * 1024 * 1024, encoding: "utf8" },
    );
    stdout = result.stdout;
  } catch (error) {
    throw describeDrizzleKitFailure(error, config);
  }

  const sql = extractSql(stdout);

  if (sql.trim() === "") {
    throw new CliError("drizzle-kit export produced no SQL.", {
      hint:
        config.schema.length > 0
          ? `Check that your schema globs match real files: ${config.schema.join(", ")}`
          : "Check that your schema globs match real files.",
    });
  }

  return {
    sql,
    dialect: config.dialect as SupportedDialect,
    config,
  };
}

/**
 * drizzle-kit prints progress/banner lines alongside the DDL. Keep only the
 * SQL payload so downstream parsing never sees tool noise.
 */
export function extractSql(raw: string): string {
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((line) => looksLikeSqlStart(line));

  if (start === -1) return "";

  return lines
    .slice(start)
    .filter((line) => !/^\s*(\[|Using|Read |Writing|Loaded|✓|✗)/.test(line))
    .join("\n")
    .trim();
}

function looksLikeSqlStart(line: string): boolean {
  return /^\s*(CREATE|ALTER|COMMENT|DROP)\s+(TABLE|TYPE|SCHEMA|INDEX|EXTENSION|SEQUENCE|MATERIALIZED)\b/i.test(
    line,
  );
}

interface DrizzleKitFailure {
  stdout?: string;
  stderr?: string;
  message?: string;
  code?: unknown;
}

function describeDrizzleKitFailure(
  error: unknown,
  config: DiscoveredConfig,
): CliError {
  const failure = error as DrizzleKitFailure;
  const stderr = (failure.stderr ?? "").trim();
  const stdout = (failure.stdout ?? "").trim();

  // drizzle-kit writes config/compile problems to stderr but still exits 0 in
  // some versions, so treat a missing payload as a failure too.
  const detail = stderr || stdout || failure.message || "unknown error";

  if (/cannot find|ENOENT|no such file/i.test(detail)) {
    return new CliError(`drizzle-kit could not read your schema (${config.configPath}).`, {
      hint: `Verify the \`schema\` glob(s) exist: ${config.schema.join(", ") || "(not set)"}`,
    });
  }

  return new CliError("drizzle-kit export failed.", { hint: truncate(detail, 1200) });
}

/** Locates the drizzle-kit CLI inside the *user's* project, not our own. */
function resolveDrizzleKitBin(cwd: string): string {
  const require = createRequire(join(cwd, "package.json"));

  try {
    const manifestPath = require.resolve("drizzle-kit/package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      bin?: string | Record<string, string>;
    };

    const binPath =
      typeof manifest.bin === "string"
        ? manifest.bin
        : manifest.bin?.["drizzle-kit"] ?? manifest.bin?.["drizzle-kit.cjs"];

    if (binPath) {
      const resolved = resolve(dirname(manifestPath), binPath);
      if (existsSync(resolved)) return resolved;
    }
  } catch {
    // fall through to the .bin probe below
  }

  const local = join(cwd, "node_modules", ".bin", "drizzle-kit");
  if (existsSync(local)) return local;

  throw new CliError("Could not find drizzle-kit in this project.", {
    hint: "Install it first, e.g. `npm i -D drizzle-kit`, then re-run.",
  });
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}\n…` : value;
}