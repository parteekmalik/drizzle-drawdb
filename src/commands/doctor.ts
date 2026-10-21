import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { discoverConfig } from "../drizzle/discoverConfig";
import { exportSchema } from "../drizzle/exportSchema";
import { convertSqlToDiagram } from "../drawdb/convert";
import { PINNED_DRAWDB_COMMIT } from "../drawdb/assets";
import { packageRoot } from "../paths";

export interface DoctorOptions {
  cwd: string;
  configPath?: string | undefined;
  drawdbDir?: string | undefined;
}

export interface Check {
  label: string;
  ok: boolean;
  detail: string;
}

export interface DoctorResult {
  checks: Check[];
  ok: boolean;
}

const GREEN = "\u001B[32m";
const RED = "\u001B[31m";
const DIM = "\u001B[2m";
const RESET = "\u001B[0m";

const useColour = process.stdout.isTTY === true && !process.env.NO_COLOR;

/**
 * Reports what the tool can see about this project without launching anything.
 */
export async function runDoctor(options: DoctorOptions): Promise<DoctorResult> {
  const checks: Check[] = [];

  let config: Awaited<ReturnType<typeof discoverConfig>> | undefined;

  try {
    config = await discoverConfig({ cwd: options.cwd, configPath: options.configPath });
    checks.push({
      label: "drizzle config",
      ok: true,
      detail: `${config.configPath} (dialect: ${config.dialect}, schema: ${
        config.schema.join(", ") || "not set"
      })`,
    });
  } catch (error) {
    checks.push({
      label: "drizzle config",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
    return { checks, ok: false };
  }

  try {
    const exported = await exportSchema({ config });
    const conversion = convertSqlToDiagram(exported.sql, { title: "doctor" });

    checks.push({
      label: "drizzle-kit export",
      ok: true,
      detail: `${exported.sql.length} bytes of SQL`,
    });

    checks.push({
      label: "diagram conversion",
      ok: conversion.record.tables.length > 0,
      detail:
        `${conversion.record.tables.length} tables, ` +
        `${conversion.record.references.length} relationships, ` +
        `${conversion.record.enums.length} enums, ` +
        `${conversion.record.types.length} types`,
    });

    for (const warning of conversion.warnings) {
      checks.push({ label: `warning: ${warning.code}`, ok: true, detail: warning.message });
    }
  } catch (error) {
    checks.push({
      label: "drizzle-kit export",
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
    });
  }

  const configuredDir = options.drawdbDir ?? process.env.DRAWDB_DIR;
  const extensionPath = configuredDir
    ? join(resolve(configuredDir), "src", "extensions", "localDiagram.js")
    : join(defaultDrawDbDir(), "src", "extensions", "localDiagram.js");

  const extensionPresent = existsSync(extensionPath);
  const distPresent = existsSync(
    join(dirname(extensionPath), "..", "..", "dist", "index.html"),
  );

  checks.push({
    label: "drawDB extension",
    ok: extensionPresent,
    detail: extensionPresent
      ? `found at ${extensionPath}`
      : `not applied in ${dirname(dirname(dirname(extensionPath)))} — apply patches/0001-local-diagram-extension.patch`,
  });

  checks.push({
    label: "drawDB build",
    ok: distPresent,
    detail: distPresent
      ? "built (dist/index.html present)"
      : "not built yet — it will be built on first `open`",
  });

  checks.push({
    label: "drawDB pin",
    ok: true,
    detail: `${PINNED_DRAWDB_COMMIT.slice(0, 12)} (pinned upstream revision)`,
  });

  return { checks, ok: checks.every((check) => check.ok) };
}

function defaultDrawDbDir(): string {
  return join(packageRoot(), "vendor", "drawdb");
}

export function formatDoctorResult(result: DoctorResult): string {
  const lines: string[] = [];

  for (const check of result.checks) {
    const mark = useColour
      ? check.ok
        ? `${GREEN}✓${RESET}`
        : `${RED}✗${RESET}`
      : check.ok
        ? "✓"
        : "✗";

    lines.push(`  ${mark} ${check.label}`);
    lines.push(`    ${useColour ? DIM : ""}${check.detail}${useColour ? RESET : ""}`);
  }

  return lines.join("\n");
}