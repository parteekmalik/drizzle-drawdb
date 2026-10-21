import { describe, expect, test } from "bun:test";
import { convertSqlToDiagram } from "../src/drawdb/convert";
import { CliError } from "../src/errors";

// Mirrors what `drizzle-kit export --sql=true` actually emits for the blog
// fixture (note the explicit NOT NULL and the schema-qualified REFERENCES).
const BASIC_SQL = `
CREATE TABLE "posts" (
	"id" serial PRIMARY KEY NOT NULL,
	"author_id" integer NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"created_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);

ALTER TABLE "posts" ADD CONSTRAINT "posts_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
`;

function table(result: ReturnType<typeof convertSqlToDiagram>, name: string) {
  const found = result.record.tables.find((t) => t.name === name);
  if (!found) throw new Error(`table "${name}" missing`);
  return found;
}

describe("convertSqlToDiagram", () => {
  test("creates one record per table, preserving columns and keys", () => {
    const result = convertSqlToDiagram(BASIC_SQL, { title: "blog" });

    expect(result.record.tables.map((t) => t.name).sort()).toEqual(["posts", "users"]);

    const users = table(result, "users");
    expect(users.fields.map((f) => f.name)).toEqual(["id", "email", "name"]);

    const id = users.fields[0]!;
    expect(id.primary).toBe(true);
    expect(id.notNull).toBe(true);

    const email = users.fields[1]!;
    expect(email.type).toBe("TEXT");
    expect(email.notNull).toBe(true);
    expect(email.primary).toBe(false);

    // Nullable because drizzle-kit emits no NOT NULL for it.
    expect(users.fields[2]!.notNull).toBe(false);
  });

  test("preserves column defaults", () => {
    const result = convertSqlToDiagram(BASIC_SQL);
    const createdAt = table(result, "posts").fields.find(
      (f) => f.name === "created_at",
    )!;

    expect(createdAt.default).toBe("now()");
  });

  test("resolves a foreign key into a relationship between the right tables", () => {
    const result = convertSqlToDiagram(BASIC_SQL);

    expect(result.record.references).toHaveLength(1);
    const rel = result.record.references[0]!;

    const users = table(result, "users");
    const posts = table(result, "posts");

    expect(rel.startTableId).toBe(posts.id);
    expect(rel.endTableId).toBe(users.id);
    expect(rel.startFieldId).toBe(
      posts.fields.find((f) => f.name === "author_id")!.id,
    );
    expect(rel.endFieldId).toBe(users.fields.find((f) => f.name === "id")!.id);
    expect(rel.cardinality).toBe("many_to_one");
  });

  test("applies drawDB's dagre auto-layout by default", () => {
    const result = convertSqlToDiagram(BASIC_SQL);
    const [posts, users] = result.record.tables;

    // Auto layout is relationship-aware: the two linked tables sit on
    // different ranks, so they no longer share the import grid's single x.
    expect(posts!.x).not.toBe(users!.x);

    // Coordinates are normalised to be non-negative for drawDB's {0,0} pan.
    for (const t of result.record.tables) {
      expect(t.x).toBeGreaterThanOrEqual(0);
      expect(t.y).toBeGreaterThanOrEqual(0);
    }
  });

  test("can keep the importer's own layout on request", () => {
    const result = convertSqlToDiagram(BASIC_SQL, { layout: "import" });
    const xs = new Set(result.record.tables.map((t) => t.x));

    // arrangeTables stacks tables into a single column, so x repeats.
    expect(xs.size).toBeLessThan(result.record.tables.length);
  });

  test("emits drawDB's JSON export shape with relationships/subjectAreas/title", () => {
    const result = convertSqlToDiagram(BASIC_SQL, { title: "blog (drizzle)" });

    expect(result.json.title).toBe("blog (drizzle)");
    expect(result.json.database).toBe("postgresql");
    expect(result.json.relationships).toHaveLength(1);
    expect(result.json.subjectAreas).toEqual([]);
    expect(result.json.notes).toEqual([]);
    expect(Array.isArray(result.json.types)).toBe(true);
    expect(Array.isArray(result.json.enums)).toBe(true);

    // The record shape deliberately uses different field names.
    expect(result.record.references).toHaveLength(1);
    expect(result.record).not.toHaveProperty("relationships");
  });

  test("preserves enums", () => {
    // drizzle-kit emits a schema-qualified CREATE TYPE but an unqualified
    // column type, so both shapes must survive.
    const sql = `
      CREATE TYPE "public"."role" AS ENUM('admin', 'user', 'guest');
      CREATE TABLE "users" (
        "id" serial PRIMARY KEY NOT NULL,
        "role" "role" DEFAULT 'user' NOT NULL
      );
    `;
    const result = convertSqlToDiagram(sql);

    expect(result.record.enums).toHaveLength(1);
    expect(result.record.enums[0]).toMatchObject({
      name: "role",
      values: ["admin", "user", "guest"],
    });

    const roleField = table(result, "users").fields.find((f) => f.name === "role")!;
    expect(roleField.type).toBe("role");
    // drawDB stores string defaults without their quotes (it takes
    // `single_quote_string.value` verbatim). Recorded as a known quirk rather
    // than worked around, so this test fails if upstream ever fixes it.
    expect(roleField.default).toBe("user");

    // CREATE TYPE is handled, so it must not be reported as unsupported.
    expect(result.warnings.map((w) => w.message).join(" ")).not.toContain(
      "CREATE TYPE",
    );
  });

  test("preserves composite primary keys", () => {
    const sql = `
      CREATE TABLE "memberships" (
        "user_id" serial NOT NULL,
        "team_id" serial NOT NULL,
        CONSTRAINT "memberships_user_id_team_id_pk" PRIMARY KEY("user_id","team_id")
      );
    `;
    const result = convertSqlToDiagram(sql);
    const memberships = table(result, "memberships");

    expect(memberships.fields.filter((f) => f.primary).map((f) => f.name)).toEqual([
      "user_id",
      "team_id",
    ]);
  });

  test("preserves defaults", () => {
    const sql = `
      CREATE TABLE "posts" (
        "id" serial PRIMARY KEY NOT NULL,
        "created_at" timestamp DEFAULT now() NOT NULL
      );
    `;
    const result = convertSqlToDiagram(sql);
    const createdAt = table(result, "posts").fields.find(
      (f) => f.name === "created_at",
    )!;

    expect(createdAt.default).toBe("now()");
  });

  test("warns instead of silently dropping unsupported statements", () => {
    const sql = `
      CREATE TABLE "users" ("id" serial PRIMARY KEY NOT NULL);
      CREATE SCHEMA "reporting";
      CREATE INDEX "users_id_idx" ON "users" ("id");
    `;
    const result = convertSqlToDiagram(sql);

    const messages = result.warnings.map((w) => w.message).join(" ");
    expect(messages).toContain("CREATE SCHEMA");
    expect(messages).toContain("CREATE INDEX");
    // Tables are still produced.
    expect(result.record.tables).toHaveLength(1);
  });

  test("does not warn when only supported statements are present", () => {
    const result = convertSqlToDiagram(BASIC_SQL);
    expect(result.warnings).toHaveLength(0);
  });

  test("reports a parse error with location rather than throwing raw", () => {
    expect(() => convertSqlToDiagram("CREATE TABLE oops")).toThrow(CliError);
  });

  test("rejects empty SQL", () => {
    expect(() => convertSqlToDiagram("   \n  ")).toThrow(CliError);
  });
});