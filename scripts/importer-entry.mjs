// Re-exports drawDB's own SQL import pipeline so the CLI can convert SQL to a
// drawDB diagram without reimplementing a PostgreSQL DDL parser.
//
// drawDB's source uses bundler-style extensionless imports and is otherwise
// plain ESM with no DOM dependencies, so it can be bundled for both Node and
// Bun. `importSQL()` also calls `arrangeTables()` internally, which is what
// gives the diagram its automatic layout.
export { importSQL } from "../vendor/drawdb/src/utils/importSQL/index.js";
export { DB } from "../vendor/drawdb/src/data/constants.js";
export { autoArrange } from "../vendor/drawdb/src/utils/autoArrange.js";

// Pinned to the exact version used by the vendored drawDB checkout so parsing
// behaviour stays identical to drawDB's own SQL import dialog.
export { Parser } from "node-sql-parser";