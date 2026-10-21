import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { createJiti } from "jiti";
import { CliError } from "../errors";
import { SUPPORTED_DIALECTS } from "../types";
import type { DrizzleConfigFile, DiscoveredConfig, SupportedDialect } from "../types";

/** Config file names drizzle-kit itself recognises, in priority order. */
const CONFIG_FILENAMES = [
  "drizzle.config.ts",
  "drizzle.config.mts",
  "drizzle.config.cts",
  "drizzle.config.js",
  "drizzle.config.mjs",
  "drizzle.config.cjs",
  "drizzle.config.json",
] as const;

export interface DiscoverConfigOptions {
  cwd: string;
  /** Explicit `--config` path. Absolute or relative to `cwd`. */
  configPath?: string | undefined;
}

/**
 * Resolves the drizzle-kit config without touching a database.
 *
 * The config module is evaluated because drizzle configs routinely compute
 * values (globs, env-derived names) at import time -- this is the same thing
 * drizzle-kit itself does. Nothing here connects to a database or writes files.
 */
export async function discoverConfig(
  options: DiscoverConfigOptions,
): Promise<DiscoveredConfig> {
  const cwd = resolve(options.cwd);
  const configPath = resolveConfigPath(cwd, options.configPath);
  const config = await loadConfigFile(configPath);

  const dialect = typeof config.dialect === "string" ? config.dialect : undefined;

  if (!dialect) {
    throw new CliError(
      `No \`dialect\` found in ${configPath}.`,
      {
        hint:
          'Add it to your drizzle config, for example: defineConfig({ dialect: "postgresql", schema: "./src/schema.ts" })',
      },
    );
  }

  if (!(SUPPORTED_DIALECTS as readonly string[]).includes(dialect)) {
    throw new CliError(
      `Unsupported dialect "${dialect}". This tool only supports ${SUPPORTED_DIALECTS.join(", ")}.`,
      {
        hint:
          `Currently supported: ${SUPPORTED_DIALECTS.join(", ")}. ` +
          "Other dialects are not supported yet; drawDB itself can still import them manually.",
      },
    );
  }

  return {
    cwd,
    projectRoot: dirname(configPath),
    configPath,
    dialect,
    schema: normaliseSchema(config.schema),
  };
}

function resolveConfigPath(cwd: string, explicit?: string): string {
  if (explicit) {
    const absolute = isAbsolute(explicit) ? explicit : resolve(cwd, explicit);

    if (!existsSync(absolute)) {
      throw new CliError(`Config file not found: ${absolute}`, {
        hint: "Check the path passed to --config.",
      });
    }

    return absolute;
  }

  let dir = cwd;
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  throw new CliError(`No drizzle config found in ${cwd} or any parent directory.`, {
    hint: `Expected one of: ${CONFIG_FILENAMES.join(", ")}. Pass --config <path> to point at it explicitly.`,
  });
}

async function loadConfigFile(configPath: string): Promise<DrizzleConfigFile> {
  try {
    const jiti = createJiti(import.meta.url, { interopDefault: true });
    const loaded = (await jiti.import(configPath)) as
      | DrizzleConfigFile
      | { default?: DrizzleConfigFile }
      | undefined;

    const resolved =
      loaded && typeof loaded === "object" && "default" in loaded
        ? (loaded as { default?: DrizzleConfigFile }).default
        : (loaded as DrizzleConfigFile | undefined);

    if (!resolved || typeof resolved !== "object") {
      throw new Error("config module did not export an object");
    }

    return resolved;
  } catch (error) {
    throw new CliError(`Failed to load drizzle config at ${configPath}.`, {
      hint:
        error instanceof Error
          ? `Underlying error: ${error.message}`
          : "The config file could not be evaluated.",
    });
  }
}

function normaliseSchema(schema: DrizzleConfigFile["schema"]): string[] {
  if (typeof schema === "string") return [schema];
  if (Array.isArray(schema)) return schema.filter((s) => typeof s === "string");
  return [];
}

export type { SupportedDialect };