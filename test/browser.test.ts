import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runOpen } from "../src/commands/open";

const fixture = join(import.meta.dir, "..", "fixtures", "blog");
const screenshotDir = join(import.meta.dir, "__screenshots__");

let open: Awaited<ReturnType<typeof runOpen>> | undefined;
let browser: Browser | undefined;
let page: Page | undefined;
let pageErrors: string[] = [];

/**
 * End-to-end proof that the *real* drawDB canvas renders the diagram.
 *
 * This asserts on rendered DOM, not on the HTTP response: a 200 that produced
 * an empty canvas must fail the test.
 */
describe("drawDB editor (real browser)", () => {
  beforeAll(async () => {
    open = await runOpen({
      cwd: fixture,
      serveOnly: true,
      title: "browser e2e",
    });

    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    pageErrors = [];
    page.on("pageerror", (error) => pageErrors.push(String(error)));

    await mkdir(screenshotDir, { recursive: true });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await open?.close();
  });

  test("serves the adapter health endpoint and runtime config", async () => {
    const health = await fetch(`${open!.url}/__drizzle_drawdb/health`).then((r) =>
      r.json(),
    );
    expect(health.ok).toBe(true);

    const config = await fetch(`${open!.url}/config.js`).then((r) => r.text());
    expect(config).toContain("__DRAWDB_CONFIG__");
    expect(config).toContain("localDiagramBase");
  });

  test("returns the diagram record in drawDB's internal shape", async () => {
    const record = await fetch(
      `${open!.url}/__drizzle_drawdb/diagrams/${open!.conversion.record.diagramId}`,
    ).then((r) => r.json());

    // drawDB reads `references`/`areas`/`name` when hydrating the editor.
    expect(record.references).toHaveLength(1);
    expect(record.name).toBe("browser e2e");
    expect(record.database).toBe("postgresql");
    expect(record.tables).toHaveLength(2);
  });

  test("renders both tables on the canvas", async () => {
    await page!.goto(open!.editorUrl, { waitUntil: "domcontentloaded" });

    const canvas = page!.locator("#canvas");
    await canvas.waitFor({ state: "attached", timeout: 60_000 });

    const users = canvas.getByText("users", { exact: true }).first();
    await users.waitFor({ state: "visible", timeout: 30_000 });
    expect(await users.isVisible()).toBe(true);

    const posts = canvas.getByText("posts", { exact: true }).first();
    await posts.waitFor({ state: "visible", timeout: 30_000 });
    expect(await posts.isVisible()).toBe(true);

    // Columns from the Drizzle schema must be rendered too.
    const authorId = canvas.getByText("author_id", { exact: true }).first();
    await authorId.waitFor({ state: "visible", timeout: 30_000 });

    const email = canvas.getByText("email", { exact: true }).first();
    await email.waitFor({ state: "visible", timeout: 30_000 });

    expect(await canvas.locator("div").count()).toBeGreaterThan(0);
  }, 90_000);

  test("renders the foreign-key relationship", async () => {
    const paths = page!.locator("#canvas .relationship-path");
    await paths.first().waitFor({ state: "attached", timeout: 30_000 });

    const count = await paths.count();
    expect(count).toBe(open!.conversion.record.references.length);
    expect(count).toBeGreaterThan(0);
  }, 60_000);

  test("shows the diagram title and no uncaught page errors", async () => {
    const title = page!.getByText("browser e2e").first();
    await title.waitFor({ state: "visible", timeout: 15_000 });

    await page!.screenshot({
      path: join(screenshotDir, "editor.png"),
      fullPage: false,
    });

    expect(pageErrors).toEqual([]);
  }, 60_000);
});

/**
 * drawDB renders the pan/zoom transform as the SVG viewBox on `#diagram`, so
 * reading it is how we observe canvas scrolling.
 */
async function readViewBox(target: Page): Promise<[number, number]> {
  return target.evaluate(() => {
    const raw = document.getElementById("diagram")?.getAttribute("viewBox") ?? "";
    const parts = raw.trim().split(/\s+/).map(Number);
    return [parts[0] ?? NaN, parts[1] ?? NaN];
  });
}

describe("editor UI defaults and canvas scrolling", () => {
  beforeAll(async () => {
    open = await runOpen({ cwd: fixture, serveOnly: true, title: "ui e2e" });
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1400, height: 900 } });

    await page.goto(open.editorUrl, { waitUntil: "domcontentloaded" });
    await page.locator("#canvas").waitFor({ state: "attached", timeout: 60_000 });
    await page.locator("#canvas .relationship-path").first().waitFor({
      state: "attached",
      timeout: 60_000,
    });
  }, 120_000);

  afterAll(async () => {
    await browser?.close();
    await open?.close();
  });

  test("defaults to the dark theme", async () => {
    const mode = await page!.evaluate(
      () => document.body.getAttribute("theme-mode"),
    );
    expect(mode).toBe("dark");
  }, 30_000);

  test("pans diagonally when the wheel reports both axes", async () => {
    const canvas = page!.locator("#canvas");
    const box = await canvas.boundingBox();
    await page!.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    const [beforeX, beforeY] = await readViewBox(page!);

    await page!.mouse.wheel(120, 80);
    await page!.waitForTimeout(150);

    const [afterX, afterY] = await readViewBox(page!);

    expect(afterX).not.toBe(beforeX);
    expect(afterY).not.toBe(beforeY);
  }, 30_000);

  test("still pans only vertically for a plain wheel (regression)", async () => {
    const canvas = page!.locator("#canvas");
    const box = await canvas.boundingBox();
    await page!.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    const [beforeX, beforeY] = await readViewBox(page!);

    // A mouse wheel reports deltaX = 0.
    await page!.mouse.wheel(0, 100);
    await page!.waitForTimeout(150);

    const [afterX, afterY] = await readViewBox(page!);

    expect(afterY).not.toBe(beforeY);
    expect(afterX).toBe(beforeX);
  }, 30_000);

  test("still pans only horizontally with Shift held (regression)", async () => {
    const canvas = page!.locator("#canvas");
    const box = await canvas.boundingBox();
    await page!.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2);

    await page!.keyboard.down("Shift");
    const [beforeX, beforeY] = await readViewBox(page!);

    await page!.mouse.wheel(0, 100);
    await page!.waitForTimeout(150);

    const [afterX, afterY] = await readViewBox(page!);
    await page!.keyboard.up("Shift");

    expect(afterX).not.toBe(beforeX);
    expect(afterY).toBe(beforeY);
  }, 30_000);

  test("reloads the diagram live when the schema file changes", async () => {
    const schemaPath = join(fixture, "src/schema.ts");
    const original = await readFile(schemaPath, "utf8");

    try {
      // Saving this edit must propagate watcher -> drizzle-kit export ->
      // SSE -> extension reload without any manual refresh.
      await writeFile(
        schemaPath,
        `${original}\nexport const extraTable = pgTable("extra_table", {\n  id: serial("id").primaryKey(),\n});\n`,
      );

      const canvas = page!.locator("#canvas");
      const extra = canvas.getByText("extra_table", { exact: true }).first();
      await extra.waitFor({ state: "visible", timeout: 90_000 });
      expect(await extra.isVisible()).toBe(true);

      // The pre-existing tables survive the reload.
      const users = canvas.getByText("users", { exact: true }).first();
      await users.waitFor({ state: "visible", timeout: 30_000 });
    } finally {
      await writeFile(schemaPath, original, "utf8");
    }
  }, 150_000);
});