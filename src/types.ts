/** Dialects this tool currently supports. */
export const SUPPORTED_DIALECTS = ["postgresql"] as const;

export type SupportedDialect = (typeof SUPPORTED_DIALECTS)[number];

/** Shape of the fields we read out of a `drizzle.config.ts`. */
export interface DrizzleConfigFile {
  dialect?: string;
  schema?: string | string[];
  out?: string;
  dbCredentials?: unknown;
}

export interface DiscoveredConfig {
  /** Directory the user invoked the CLI from. Used to resolve relative outputs. */
  cwd: string;
  /**
   * Directory containing the config file. drizzle-kit runs here, because it
   * resolves `schema` globs relative to its working directory rather than to
   * the config file's location.
   */
  projectRoot: string;
  /** Absolute path to the resolved config file. */
  configPath: string;
  /** Dialect exactly as declared in the config file. */
  dialect: string;
  /** Normalised `schema` globs, always relative to `projectRoot`. */
  schema: string[];
}

export interface ExportedSchema {
  sql: string;
  dialect: SupportedDialect;
  config: DiscoveredConfig;
}

/** A drawDB table field, as produced by drawDB's own importer. */
export interface DiagramField {
  id: string;
  name: string;
  type: string;
  primary: boolean;
  unique: boolean;
  notNull: boolean;
  default: string;
  comment: string;
  [key: string]: unknown;
}

export interface DiagramTable {
  id: string;
  name: string;
  x: number;
  y: number;
  color: string;
  fields: DiagramField[];
  indices: unknown[];
  uniqueConstraints: unknown[];
  comment: string;
  collapsed: boolean;
  locked: boolean;
  [key: string]: unknown;
}

export interface DiagramRelationship {
  id: string;
  name: string;
  startTableId: string;
  endTableId: string;
  startFieldId: string;
  endFieldId: string;
  cardinality: string;
  [key: string]: unknown;
}

/** Raw output of drawDB's `importSQL()`. */
export interface ParsedDiagram {
  tables: DiagramTable[];
  relationships: DiagramRelationship[];
  types?: unknown[];
  enums?: unknown[];
}

/**
 * drawDB's *internal* persisted diagram record.
 *
 * Note the deliberately different field names versus the JSON export shape
 * (`references`/`areas`/`name` here). This is what `Workspace.applyDiagramState`
 * reads when hydrating the editor.
 */
export interface DiagramRecord {
  diagramId: string;
  database: string;
  name: string;
  tables: DiagramTable[];
  references: DiagramRelationship[];
  notes: unknown[];
  areas: unknown[];
  views: unknown[];
  types: unknown[];
  enums: unknown[];
  pan: { x: number; y: number };
  zoom: number;
  gistId: string;
  loadedFromGistId: string;
  lastModified: string;
}

/**
 * drawDB's JSON *import/export* shape, as produced by
 * `ControlPanel -> Export As -> JSON` and consumed by `Modal.overwriteDiagram`.
 */
export interface DiagramJson {
  database: string;
  title: string;
  tables: DiagramTable[];
  relationships: DiagramRelationship[];
  notes: unknown[];
  subjectAreas: unknown[];
  views: unknown[];
  types: unknown[];
  enums: unknown[];
}

/** Non-fatal issues found while converting. */
export interface ConversionWarning {
  code:
    | "no-tables"
    | "unparsed-statement"
    | "unsupported-statement"
    | "empty-sql";
  message: string;
}

export interface ConversionResult {
  record: DiagramRecord;
  json: DiagramJson;
  warnings: ConversionWarning[];
}