import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverConfig } from "../src/drizzle/discoverConfig";
import { CliError } from "../src/errors";

const created: string[] = [];

async function makeProject(
  files: Record<string, string>,
  root?: string,
): Promise<string> {
  const base = root ?? (await mkdtemp(join(tmpdir(), "drizzle-drawdb-")));
  if (!root) created.push(base);

  for (const [relative, contents] of Object.entries(files)) {
    const target = join(base, relative);
    await mkdir(join(target, ".."), { recursive: true });
    await writeFile(target, contents, "utf8");
  }

  return base;
}

afterEach(async () => {
  while (created.length > 0) {
    const dir = created.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

const PG_CONFIG = `export default {
  dialect: "postgresql",
  schema: "./src/schema.ts",
};
`;

describe("discoverConfig", () => {
  test("finds drizzle.config.ts in the given directory", async () => {
    const cwd = await makeProject({ "drizzle.config.ts": PG_CONFIG });

    const config = await discoverConfig({ cwd });

    expect(config.dialect).toBe("postgresql");
    expect(config.schema).toEqual(["./src/schema.ts"]);
    expect(config.configPath).toBe(join(cwd, "drizzle.config.ts"));
    expect(config.projectRoot).toBe(cwd);
  });

  test("walks up to find the config in a parent directory", async () => {
    const root = await makeProject({ "drizzle.config.ts": PG_CONFIG });
    const nested = join(root, "apps", "api");
    await mkdir(nested, { recursive: true });

    const config = await discoverConfig({ cwd: nested });

    expect(config.configPath).toBe(join(root, "drizzle.config.ts"));
    expect(config.projectRoot).toBe(root);
    // cwd stays where the user invoked the CLI, for resolving relative outputs.
    expect(config.cwd).toBe(nested);
  });

  test("honours an explicit --config outside the cwd", async () => {
    const root = await makeProject({ "custom/drizzle.config.ts": PG_CONFIG });
    const elsewhere = await makeProject({ "placeholder.txt": "" });

    const config = await discoverConfig({
      cwd: elsewhere,
      configPath: join(root, "custom", "drizzle.config.ts"),
    });

    expect(config.dialect).toBe("postgresql");
    expect(config.projectRoot).toBe(join(root, "custom"));
  });

  test("normalises an array of schema globs", async () => {
    const cwd = await makeProject({
      "drizzle.config.ts": `export default {
        dialect: "postgresql",
        schema: ["./src/user/schema.ts", "./src/posts/schema.ts"],
      };`,
    });

    const config = await discoverConfig({ cwd });

    expect(config.schema).toEqual([
      "./src/user/schema.ts",
      "./src/posts/schema.ts",
    ]);
  });

test("loads the defineConfig helper form from a real project", async () => {
    const fixture = join(import.meta.dir, "..", "fixtures", "blog");

    const config = await discoverConfig({ cwd: fixture });

    expect(config.dialect).toBe("postgresql");
    expect(config.schema).toEqual(["./src/schema.ts"]);
  });

  test("rejects an unsupported dialect with an actionable hint", async () => {
    const cwd = await makeProject({
      "drizzle.config.ts": `export default { dialect: "mysql", schema: "./src/schema.ts" };`,
    });

    const error = await discoverConfig({ cwd }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain('Unsupported dialect "mysql"');
    expect((error as CliError).hint).toContain("postgresql");
  });

  test("reports a missing config clearly", async () => {
    const cwd = await makeProject({ "readme.md": "" });

    const error = await discoverConfig({ cwd }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("No drizzle config found");
  });

  test("reports a missing --config path clearly", async () => {
    const cwd = await makeProject({ "placeholder.txt": "" });

    const error = await discoverConfig({
      cwd,
      configPath: "./does-not-exist.ts",
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("Config file not found");
  });

  test("reports a config with no dialect clearly", async () => {
    const cwd = await makeProject({
      "drizzle.config.ts": `export default { schema: "./src/schema.ts" };`,
    });

    const error = await discoverConfig({ cwd }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("No `dialect` found");
  });
});