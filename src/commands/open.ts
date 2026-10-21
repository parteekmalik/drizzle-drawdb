import { relative } from "node:path";
import { CliError } from "../errors";
import { discoverConfig } from "../drizzle/discoverConfig";
import { exportSchema } from "../drizzle/exportSchema";
import { convertSqlToDiagram } from "../drawdb/convert";
import { resolveDrawDbCheckout } from "../drawdb/assets";
import { startAdapter } from "../drawdb/serve";
import { startSchemaWatch } from "../drawdb/watcher";
import { openInBrowser } from "../drawdb/launcher";
import type { ConversionResult, DiscoveredConfig } from "../types";

export interface OpenOptions {
  cwd: string;
  configPath?: string | undefined;
  title?: string | undefined;
  drawdbDir?: string | undefined;
  /** Force a theme via drawDB's `?theme=` parameter. Default is drawDB's own. */
  theme?: "light" | "dark" | undefined;
  /** Print the URL instead of launching a browser. */
  noOpen?: boolean;
  /** Serve the editor without launching a browser (used by tests). */
  serveOnly?: boolean;
  /**
   * Watch the schema files and update the diagram live as they change
   * (prisma-studio style). Default true.
   */
  watch?: boolean;
}

export interface OpenResult {
  config: DiscoveredConfig;
  conversion: ConversionResult;
  /** Base origin of the local adapter. */
  url: string;
  editorUrl: string;
  close: () => Promise<void>;
}

/**
 * Full pipeline: discover config -> export SQL -> convert with drawDB's own
 * importer -> serve the real editor with the diagram already loaded.
 *
 * The returned `close` must be called by the caller so the process can exit.
 */
export async function runOpen(options: OpenOptions): Promise<OpenResult> {
  const config = await discoverConfig({
    cwd: options.cwd,
    configPath: options.configPath,
  });

  const exported = await exportSchema({ config });
  const conversion = convertSqlToDiagram(exported.sql, {
    title: options.title ?? defaultTitle(config),
  });

  const checkout = await resolveDrawDbCheckout({ dir: options.drawdbDir });
  const adapter = await startAdapter({
    dist: checkout.dist,
    record: conversion.record,
    theme: options.theme,
  });

  const watcher = options.watch === false
    ? undefined
    : startSchemaWatch({
        projectRoot: config.projectRoot,
        configPath: config.configPath,
        schemas: config.schema,
        onChanged: (changed) => {
          void reloadDiagram(changed);
        },
      });

  if (watcher) {
    process.stdout.write(
      "Watching your schema files — save an edit and the diagram updates live.\n",
    );
  }

  if (!options.serveOnly && !options.noOpen) {
    const opened = await openInBrowser(adapter.editorUrl);
    if (!opened) {
      process.stderr.write(
        "Could not launch a browser automatically. Open this URL manually:\n",
      );
    }
  }

  // Reloads serialize through this chain so overlapping saves never race.
  let reloadChain: Promise<void> = Promise.resolve();

  /**
   * Re-exports the DDL and reconverts it, keeping the diagram id stable so the
   * editor URL does not change. Conversion failures (e.g. a syntax error
   * mid-edit) keep the previous diagram and report instead of crashing the
   * server.
   */
  const reloadDiagram = (changed: string[]): Promise<void> => {
    // The catch keeps the chain usable even if a reload ever threw.
    reloadChain = reloadChain.then(() => reloadNow(changed)).catch(() => {});
    return reloadChain;
  };

  async function reloadNow(changed: string[]): Promise<void> {
    if (changed.includes(config.configPath)) {
      process.stdout.write(
        "\nYour drizzle config changed — restart drizzle-drawdb to pick up new dialect or schema settings.\n",
      );
      return;
    }

    const files = changed
      .filter((file) => file !== config.configPath)
      .map((file) => relative(config.projectRoot, file) || file)
      .join(", ");

    try {
      const reexported = await exportSchema({ config });
      const reconverted = convertSqlToDiagram(reexported.sql, {
        title: options.title ?? defaultTitle(config),
        diagramId: conversion.record.diagramId,
      });

      adapter.updateDiagram(reconverted.record);

      process.stdout.write(
        `\nschema changed (${files}) — diagram updated: ${reconverted.record.tables.length} tables, ${reconverted.record.references.length} relationships\n`,
      );
      for (const warning of reconverted.warnings) {
        process.stdout.write(`warning: ${warning.message}\n`);
      }
    } catch (error) {
      process.stderr.write(
        `\nwarning: schema change could not be converted — keeping the previous diagram.\n  ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
  }

  return {
    config,
    conversion,
    url: adapter.url,
    editorUrl: adapter.editorUrl,
    close: async () => {
      watcher?.close();
      await adapter.close();
    },
  };
}

function defaultTitle(config: DiscoveredConfig): string {
  const project = config.projectRoot.split(/[\\/]/).filter(Boolean).pop();
  return project ? `${project} (drizzle)` : "drizzle schema";
}

/** Throws when a conversion produced nothing usable. */
export function assertUsableConversion(conversion: ConversionResult): void {
  if (conversion.record.tables.length === 0) {
    throw new CliError("The schema converted to zero tables.", {
      hint: "Run `drizzle-drawdb doctor` to inspect the generated SQL.",
    });
  }
}
