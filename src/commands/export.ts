import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { discoverConfig } from "../drizzle/discoverConfig";
import { exportSchema } from "../drizzle/exportSchema";
import { convertSqlToDiagram } from "../drawdb/convert";

export interface ExportOptions {
  cwd: string;
  configPath?: string | undefined;
  out: string;
  title?: string | undefined;
}

export interface ExportResult {
  outPath: string;
  tableCount: number;
  relationshipCount: number;
}

/**
 * Writes a drawDB JSON file that drawDB can import directly.
 *
 * Uses drawDB's *export* shape (`relationships`/`subjectAreas`/`title`), so the
 * output drops into drawDB's "Import from JSON" flow without the local adapter
 * running.
 */
export async function runExport(options: ExportOptions): Promise<ExportResult> {
  const config = await discoverConfig({
    cwd: options.cwd,
    configPath: options.configPath,
  });

  const exported = await exportSchema({ config });

  const project = config.projectRoot.split(/[\\/]/).filter(Boolean).pop();
  const conversion = convertSqlToDiagram(exported.sql, {
    title: options.title ?? (project ? `${project} (drizzle)` : "drizzle schema"),
  });

  const outPath = resolve(options.cwd, options.out);
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, `${JSON.stringify(conversion.json, null, 2)}\n`, "utf8");

  return {
    outPath,
    tableCount: conversion.record.tables.length,
    relationshipCount: conversion.record.references.length,
  };
}