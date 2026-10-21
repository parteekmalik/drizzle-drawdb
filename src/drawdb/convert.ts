import { randomUUID } from "node:crypto";
// Bundled from the pinned drawDB checkout: drawDB's own SQL import pipeline,
// its dagre-based auto-layout, and the exact node-sql-parser version drawDB
// ships with.
import { importSQL, DB, Parser, autoArrange } from "../generated/drawdb-import.mjs";
import { CliError } from "../errors";
import type {
  ConversionResult,
  ConversionWarning,
  DiagramJson,
  DiagramRecord,
  DiagramRelationship,
  DiagramTable,
  ParsedDiagram,
  SupportedDialect,
} from "../types";

export interface ConvertOptions {
  title?: string;
  diagramId?: string;
  database?: string;
  /**
   * How to position tables.
   *
   * `auto` (default) re-runs drawDB's dagre-based `autoArrange()`, which is the
   * same layout drawDB applies from its own "Auto arrange" command.
   * `import` keeps the crude two-row grid that `importSQL()` produces.
   */
  layout?: "auto" | "import";
}

/**
 * Converts PostgreSQL DDL into a drawDB diagram using drawDB's *own* importer.
 *
 * drawDB's `importSQL()` already calls `arrangeTables()`, so the resulting tables
 * carry x/y coordinates and render with an automatic layout -- no extra layout
 * step is required here.
 */
export function convertSqlToDiagram(
  sql: string,
  options: ConvertOptions = {},
): ConversionResult {
  const trimmed = sql.trim();

  if (trimmed === "") {
    throw new CliError("Nothing to convert: the generated SQL was empty.");
  }

  const ast = parseSql(trimmed);
  const warnings = classifyUnsupportedStatements(ast);

  let diagram: ParsedDiagram;
  try {
    diagram = importSQL(ast, DB.POSTGRES, DB.POSTGRES) as ParsedDiagram;
  } catch (error) {
    throw new CliError("drawDB failed to convert the SQL into a diagram.", {
      hint: error instanceof Error ? error.message : String(error),
    });
  }

  const tables = diagram.tables ?? [];
  const relationships = diagram.relationships ?? [];

  if (options.layout !== "import" && tables.length > 0) {
    applyAutoLayout(tables, relationships);
  }

  if (tables.length === 0) {
    warnings.push({
      code: "no-tables",
      message:
        "No tables were found in the exported SQL. The schema may be empty or use constructs drawDB cannot parse.",
    });
  }

  const database = options.database ?? (DB.POSTGRES as string);
  const title = options.title ?? "Untitled Diagram";
  const diagramId = options.diagramId ?? randomUUID();
  const types = diagram.types ?? [];
  const enums = diagram.enums ?? [];

  return {
    record: toRecord({ diagram, diagramId, database, title }),
    json: toJson({ diagram, database, title }),
    warnings,
  };
}

/**
 * Re-runs drawDB's own dagre layout over the imported tables.
 *
 * `importSQL()` lays tables out in a simple two-row grid, which is fine for the
 * import dialog but leaves larger schemas unreadable. drawDB already ships a
 * relationship-aware dagre layout (the one behind its "Auto arrange" command),
 * so we reuse that rather than inventing a second layout. Coordinates are shifted
 * to be non-negative because drawDB opens the canvas at pan {0,0}.
 */
export function applyAutoLayout(
  tables: DiagramTable[],
  relationships: DiagramRelationship[],
): boolean {
  try {
    const positions = autoArrange(tables, relationships, {
      showComments: false,
    }) as Array<{ id: string; x: number; y: number }>;

    const byId = new Map(positions.map((p) => [p.id, p]));

    for (const table of tables) {
      const position = byId.get(table.id);
      if (position) {
        table.x = position.x;
        table.y = position.y;
      }
    }

    let minX = Infinity;
    let minY = Infinity;

    for (const table of tables) {
      minX = Math.min(minX, table.x);
      minY = Math.min(minY, table.y);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return false;

    for (const table of tables) {
      table.x -= minX;
      table.y -= minY;
    }

    return true;
  } catch {
    // Keep the importer's own layout rather than losing the diagram entirely.
    return false;
  }
}

/**
 * Parses SQL with drawDB's parser, converting node-sql-parser's structured
 * syntax errors into the same style of message drawDB shows in its own import
 * dialog (see Modal.jsx).
 */
function parseSql(sql: string): unknown {
  try {
    return new Parser().astify(sql, { database: DB.POSTGRES });
  } catch (error) {
    const location = (
      error as { location?: { start?: { line?: number; column?: number } } }
    )?.location;
    const line = location?.start?.line;
    const column = location?.start?.column;
    const message = error instanceof Error ? error.message : String(error);

    throw new CliError(
      line && column
        ? `parse_error_at: ${message} (line ${line}, column ${column})`
        : `SQL could not be parsed: ${message}`,
      {
        hint: "This usually means drizzle-kit emitted DDL that drawDB's PostgreSQL parser does not understand.",
      },
    );
  }
}

/**
 * drawDB's PostgreSQL importer (utils/importSQL/postgres.js) handles exactly
 * four things: CREATE TABLE, CREATE TYPE ... AS ENUM, CREATE TYPE with column
 * definitions, and ALTER TABLE (foreign keys + COMMENT ON). Everything else is
 * dropped without a trace, so we report it rather than losing it silently.
 *
 * The conditions below mirror `parseSingleStatement` in postgres.js.
 */
export function classifyUnsupportedStatements(
  ast: unknown,
): ConversionWarning[] {
  const statements = Array.isArray(ast) ? ast : [ast];
  const unsupported = new Set<string>();

  for (const statement of statements) {
    if (!statement || typeof statement !== "object") continue;

    const node = statement as {
      type?: string;
      keyword?: string;
      resource?: string;
      create_definitions?: unknown;
    };

    if (node.type === "alter") continue;

    if (node.type === "create") {
      const keyword = (node.keyword ?? "").toLowerCase();
      const resource = (node.resource ?? "").toLowerCase();

      if (keyword === "table") continue;
      if (
        keyword === "type" &&
        (resource === "enum" || Array.isArray(node.create_definitions))
      ) {
        continue;
      }

      unsupported.add(`CREATE ${(node.keyword ?? "object").toUpperCase()}`);
      continue;
    }

    if (typeof node.type === "string") {
      unsupported.add(node.type.toUpperCase());
    }
  }

  if (unsupported.size === 0) return [];

  return [
    {
      code: "unsupported-statement",
      message:
        `drawDB's PostgreSQL importer ignored these statement types: ${[...unsupported]
          .sort()
          .join(", ")}. They are not represented in the diagram.`,
    },
  ];
}

/** drawDB's persisted/internal record shape (consumed by Workspace). */
export function toRecord(input: {
  diagram: ParsedDiagram;
  diagramId: string;
  database: string;
  title: string;
}): DiagramRecord {
  const { diagram, diagramId, database, title } = input;

  return {
    diagramId,
    database,
    name: title,
    tables: diagram.tables ?? [],
    references: diagram.relationships ?? [],
    notes: [],
    areas: [],
    views: [],
    types: diagram.types ?? [],
    enums: diagram.enums ?? [],
    pan: { x: 0, y: 0 },
    zoom: 1,
    gistId: "",
    loadedFromGistId: "",
    lastModified: new Date().toISOString(),
  };
}

/**
 * drawDB's JSON import/export shape. Field names deliberately differ from the
 * record shape (`relationships`/`subjectAreas`/`title`), matching ControlPanel's
 * JSON export and Modal's JSON import.
 */
export function toJson(input: {
  diagram: ParsedDiagram;
  database: string;
  title: string;
}): DiagramJson {
  const { diagram, database, title } = input;

  return {
    database,
    title,
    tables: diagram.tables ?? [],
    relationships: diagram.relationships ?? [],
    notes: [],
    subjectAreas: [],
    views: [],
    types: diagram.types ?? [],
    enums: diagram.enums ?? [],
  };
}

export type { SupportedDialect };