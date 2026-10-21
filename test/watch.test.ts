import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globToRegExp, startSchemaWatch } from "../src/drawdb/watcher";

describe("globToRegExp", () => {
  test("matches a literal path", () => {
    const pattern = globToRegExp("/proj/src/schema.ts");

    expect(pattern.test("/proj/src/schema.ts")).toBe(true);
    expect(pattern.test("/proj/src/other.ts")).toBe(false);
  });

  test("* matches within one path segment only", () => {
    const pattern = globToRegExp("/proj/src/*.ts");

    expect(pattern.test("/proj/src/schema.ts")).toBe(true);
    expect(pattern.test("/proj/src/db/schema.ts")).toBe(false);
  });

  test("** matches across directories, including none", () => {
    const pattern = globToRegExp("/proj/src/**/*.ts");

    expect(pattern.test("/proj/src/schema.ts")).toBe(true);
    expect(pattern.test("/proj/src/db/schema.ts")).toBe(true);
    expect(pattern.test("/proj/src/db/deep/schema.ts")).toBe(true);
    expect(pattern.test("/proj/test/schema.ts")).toBe(false);
  });

  test("? matches exactly one character", () => {
    const twoChars = globToRegExp("/proj/src/schema.??");
    expect(twoChars.test("/proj/src/schema.ts")).toBe(true);
    expect(twoChars.test("/proj/src/schema.json")).toBe(false);

    const threeChars = globToRegExp("/proj/src/schema.???");
    expect(threeChars.test("/proj/src/schema.mts")).toBe(true);
    expect(threeChars.test("/proj/src/schema.ts")).toBe(false);
  });

  test("escapes regex metacharacters", () => {
    const pattern = globToRegExp("/proj/src/schema(1).ts");

    expect(pattern.test("/proj/src/schema(1).ts")).toBe(true);
    // Unescaped, `(1)` would match "schema1.ts"; escaping must prevent that.
    expect(pattern.test("/proj/src/schema1.ts")).toBe(false);
  });
});

describe("startSchemaWatch", () => {
  async function withTempDir(
    run: (dir: string) => Promise<void>,
  ): Promise<void> {
    const dir = await mkdtemp(join(tmpdir(), "dd-watch-"));
    try {
      await run(dir);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  async function waitFor<T>(
    read: () => T | undefined,
    timeoutMs: number,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = read();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error("timed out waiting for watcher");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function start(dir: string, onChanged: (changed: string[]) => void) {
    return startSchemaWatch({
      projectRoot: dir,
      configPath: join(dir, "drizzle.config.ts"),
      schemas: ["./src/**/*.ts"],
      intervalMs: 20,
      debounceMs: 30,
      onChanged,
    });
  }

  test("reports a modified schema file after the debounce window", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/schema.ts"), "a");
      await writeFile(join(dir, "drizzle.config.ts"), "cfg");

      const events: string[][] = [];
      const handle = start(dir, (changed) => events.push(changed));

      try {
        await writeFile(join(dir, "src/schema.ts"), "ab");
        const batch = await waitFor(
          () => events.length > 0 ? events[0] : undefined,
          5000,
        );
        expect(batch).toEqual([join(dir, "src/schema.ts")]);
      } finally {
        handle.close();
      }
    });
  });

  test("reports a newly added schema file", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "drizzle.config.ts"), "cfg");

      const events: string[][] = [];
      const handle = start(dir, (changed) => events.push(changed));

      try {
        await writeFile(join(dir, "src/new-table.ts"), "b");
        const batch = await waitFor(
          () => events.length > 0 ? events[0] : undefined,
          5000,
        );
        expect(batch).toEqual([join(dir, "src/new-table.ts")]);
      } finally {
        handle.close();
      }
    });
  });

  test("reports a deleted schema file", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/schema.ts"), "a");
      await writeFile(join(dir, "drizzle.config.ts"), "cfg");

      const events: string[][] = [];
      const handle = start(dir, (changed) => events.push(changed));

      try {
        await rm(join(dir, "src/schema.ts"));
        const batch = await waitFor(
          () => events.length > 0 ? events[0] : undefined,
          5000,
        );
        expect(batch).toEqual([join(dir, "src/schema.ts")]);
      } finally {
        handle.close();
      }
    });
  });

  test("reports a changed config file", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/schema.ts"), "a");
      await writeFile(join(dir, "drizzle.config.ts"), "cfg");

      const events: string[][] = [];
      const handle = start(dir, (changed) => events.push(changed));

      try {
        await writeFile(join(dir, "drizzle.config.ts"), "cfg2");
        const batch = await waitFor(
          () => events.length > 0 ? events[0] : undefined,
          5000,
        );
        expect(batch).toEqual([join(dir, "drizzle.config.ts")]);
      } finally {
        handle.close();
      }
    });
  });

  test("ignores files that match no schema glob", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/schema.ts"), "a");
      await writeFile(join(dir, "drizzle.config.ts"), "cfg");

      const events: string[][] = [];
      const handle = start(dir, (changed) => events.push(changed));

      try {
        await writeFile(join(dir, "README.md"), "not a schema");
        await writeFile(join(dir, "src/component.tsx"), "not a schema either");

        // Give the watcher several ticks to (wrongly) report the changes.
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(events).toEqual([]);
      } finally {
        handle.close();
      }
    });
  });

  test("close() stops reporting changes", async () => {
    await withTempDir(async (dir) => {
      await mkdir(join(dir, "src"), { recursive: true });
      await writeFile(join(dir, "src/schema.ts"), "a");
      await writeFile(join(dir, "drizzle.config.ts"), "cfg");

      const events: string[][] = [];
      const handle = start(dir, (changed) => events.push(changed));
      handle.close();

      await writeFile(join(dir, "src/schema.ts"), "ab");
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(events).toEqual([]);
    });
  });
});
