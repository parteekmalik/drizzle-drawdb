import { describe, expect, test } from "bun:test";
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractSql, exportSchema } from "../src/drizzle/exportSchema";
import { discoverConfig } from "../src/drizzle/discoverConfig";
import { convertSqlToDiagram } from "../src/drawdb/convert";
import { CliError } from "../src/errors";

const blogFixture = join(import.meta.dir, "..", "fixtures", "blog");
const enumsFixture = join(import.meta.dir, "..", "fixtures", "enums");

describe("extractSql", () => {
  test("strips tool noise and keeps the DDL", () => {
    const raw = [
      "Using esbuild-kit",
      "Read schema ./src/schema.ts",
      "",
      'CREATE TABLE "users" (',
      '\t"id" serial PRIMARY KEY NOT NULL',
      ");",
    ].join("\n");

    expect(extractSql(raw)).toBe(
      'CREATE TABLE "users" (\n\t"id" serial PRIMARY KEY NOT NULL\n);',
    );
  });

  test("returns an empty string when there is no DDL", () => {
    expect(extractSql("nothing to see here")).toBe("");
  });
});

describe("exportSchema (real drizzle-kit, no database)", () => {
  test("exports the blog fixture and converts it into two related tables", async () => {
    const config = await discoverConfig({ cwd: blogFixture });
    const exported = await exportSchema({ config });

    expect(exported.dialect).toBe("postgresql");
    expect(exported.sql).toContain('CREATE TABLE "users"');

    const conversion = convertSqlToDiagram(exported.sql);

    expect(conversion.record.tables.map((t) => t.name).sort()).toEqual([
      "posts",
      "users",
    ]);
    expect(conversion.record.references).toHaveLength(1);
    expect(conversion.warnings).toHaveLength(0);
  });

  test("exports enums, composite keys and reports dropped indexes", async () => {
    const config = await discoverConfig({ cwd: enumsFixture });
    const exported = await exportSchema({ config });
    const conversion = convertSqlToDiagram(exported.sql);

    expect(conversion.record.tables.map((t) => t.name).sort()).toEqual([
      "memberships",
      "posts",
      "users",
    ]);

    expect(conversion.record.enums[0]).toMatchObject({
      name: "role",
      values: ["admin", "user", "guest"],
    });

    const memberships = conversion.record.tables.find(
      (t) => t.name === "memberships",
    )!;
    expect(memberships.fields.filter((f) => f.primary)).toHaveLength(2);

    // drizzle-kit emits CREATE INDEX; drawDB's importer drops it, and we say so.
    const warnings = conversion.warnings.map((w) => w.message).join(" ");
    expect(warnings).toContain("CREATE INDEX");
  });

  test("never writes to the project directory", async () => {
    const config = await discoverConfig({ cwd: blogFixture });
    const before = await readdir(blogFixture);

    await exportSchema({ config });

    const after = await readdir(blogFixture);

    expect(after.sort()).toEqual(before.sort());
  });

  test("reports an empty result when no schema files match", async () => {
    // drizzle-kit prints an error to stderr but still exits 0 when the schema
    // glob matches nothing, so the empty payload must be caught here.
    // The scratch project lives inside fixtures/blog so that drizzle-kit
    // resolves from the fixture's node_modules.
    const scratch = join(blogFixture, ".tmp-empty-schema");

    await mkdir(scratch, { recursive: true });
    await writeFile(
      join(scratch, "drizzle.config.ts"),
      `export default { dialect: "postgresql", schema: "./src/does-not-exist.ts" };`,
      "utf8",
    );

    try {
      const config = await discoverConfig({ cwd: scratch });
      const error = await exportSchema({ config }).catch((e: unknown) => e);

      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).message).toBeTruthy();
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  });
});