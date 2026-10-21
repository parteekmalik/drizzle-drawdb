# drizzle-drawdb

Open the **real [drawDB](https://github.com/drawdb-io/drawdb) editor** with a PostgreSQL schema exported from a [Drizzle ORM](https://orm.drizzle.team) project.

```bash
bunx drizzle-drawdb
```

No database connection, no credentials, no manual import dialog. The editor opens with your tables, columns, keys and relationships already laid out and editable.

---

## How it works

The important thing about this tool is what it **doesn't** do: it does not implement a second PostgreSQL DDL parser, and it does not reimplement drawDB's diagram model. It calls drawDB's own importer.

```
drizzle.config.ts ──► drizzle-kit export --sql=true ──► SQL DDL
                                                          │
                                     drawDB's importSQL() │  (bundled, runs headlessly)
                                                          ▼
                                          tables + relationships + enums, auto-laid-out
                                                          │
                                    local adapter (127.0.0.1) ──► drawDB editor
```

### Verified integration points

Everything below was read in drawDB source at commit
[`d9c0d39`](https://github.com/drawdb-io/drawdb/commit/d9c0d39c6ae85d30058f3c32fc1af571dc25e456) (Oct 8, 2026):

| Concern | Location in drawDB | What we rely on |
| --- | --- | --- |
| SQL import | `src/utils/importSQL/index.js` | `importSQL(ast, toDb, diagramDb)` — a pure function with no DOM dependency, so it runs under Node/Bun |
| SQL parsing | `node-sql-parser` | Same parser version drawDB pins (`5.4.0`), so behaviour matches drawDB's import dialog |
| Layout | `src/utils/autoArrange.js` | drawDB's own dagre layout; re-run after import because `importSQL()` only produces a crude two-row grid |
| Loading a diagram | `src/context/ExtensionsContext.jsx` | drawDB already has an extension registry with a `cloudLoad(diagramId)` hook, which `Workspace.fetchDiagram()` falls back to |
| Runtime config | `public/config.js` → `src/config/index.js` | `window.__DRAWDB_CONFIG__` is injected at deploy time; we use it to hand the editor the adapter's URL |

### The drawDB extension

drawDB ships a first-class extension seam, so the integration is a **99-line patch**, not a fork:

- new file `src/extensions/localDiagram.js` — registers a `cloudLoad` that fetches the diagram from the local adapter and caches it into drawDB's own IndexedDB, so the diagram behaves like any other local diagram (editable, autosaving, listed under *Open diagram*);
- `src/main.jsx` — wraps `<App />` in the existing `ExtensionsContext.Provider` (11 lines).

That is the entire integration change. drawDB's importer, canvas, state management and persistence are untouched.

```bash
# adopt against a fresh checkout
git clone https://github.com/drawdb-io/drawdb.git vendor/drawdb
git -C vendor/drawdb checkout d9c0d39c6ae85d30058f3c32fc1af571dc25e456
git -C vendor/drawdb apply /path/to/patches/0001-local-diagram-extension.patch
git -C vendor/drawdb apply /path/to/patches/0002-ui-defaults-and-diagonal-scroll.patch
cd vendor/drawdb && npm install && npm run build
```

Patches are independent, so `0002` can be skipped or reverted on its own:

| Patch | Files | What |
| --- | --- | --- |
| `0001-local-diagram-extension` | 2 | Registers the `cloudLoad` extension. **Required.** |
| `0002-ui-defaults-and-diagonal-scroll` | 3 | Dark default theme + diagonal canvas panning. UX only. |

To adopt a newer drawDB: re-checkout, re-apply, re-run the browser test.

## Commands

```bash
drizzle-drawdb                          # open the editor (default command)
drizzle-drawdb --config ./drizzle.config.ts
drizzle-drawdb export --out schema.drawdb.json
drizzle-drawdb doctor
```

| Command | Purpose |
| --- | --- |
| *(default)* / `open` | Export the schema, convert it, serve drawDB locally and open the browser. Runs until `Ctrl+C`. |
| `export` | Write a drawDB JSON file (`relationships` / `subjectAreas` / `title` shape) that drawDB's *Import → JSON* accepts, without running the adapter. |
| `doctor` | Report config discovery, drizzle-kit resolution, conversion results, unsupported statements, and the drawDB patch/build state. Launches nothing. |

Options: `--config/-c`, `--out/-o`, `--title`, `--drawdb-dir`, `--theme`, `--no-open`, `--no-watch`.

### Live schema sync

Like `prisma studio`, the default command watches your schema files: save an edit and the diagram updates in the open editor — no refresh, no restart.

```
drizzle-drawdb                 # edit src/schema.ts -> the editor reloads itself
```

Under the hood: the CLI polls the files matched by your config's `schema` globs (plus `drizzle.config.ts`), re-runs `drizzle-kit export` on change, reconverts with drawDB's importer, and pushes the new diagram to the editor over a server-sent-events stream. The drawDB extension persists the fresh diagram and reloads the page. A conversion failure (e.g. a syntax error mid-edit) keeps the previous diagram and prints a warning instead of killing the session.

Two behaviours worth knowing:

- **The schema is the source of truth.** When it changes, pan/zoom and any unsaved manual diagram edits are dropped — the reloaded diagram is the freshly converted one.
- **Config changes need a restart.** If `drizzle.config.ts` itself changes (dialect, schema globs), the CLI says so and keeps serving the current diagram; restart to pick them up.

Pass `--no-watch` to serve a static diagram without watching.

### Editor defaults

Two UX behaviours are applied by patch `0002`:

- **Dark theme by default.** drawDB's `defaultSettings.mode` becomes `dark`, and `<body theme-mode>` starts dark to avoid a light flash. Because this changes the *default* rather than forcing a value, a theme you pick in drawDB's own settings still persists. Use `--theme light|dark` to force one via drawDB's existing `?theme=` parameter.
- **Diagonal canvas panning.** drawDB previously read only `deltaY`: a plain wheel panned vertically and Shift+wheel panned horizontally, so trackpad panning was locked to one axis. The patch honours `deltaX` and `deltaY` together, while keeping the Shift fallback that browsers apply to mouse wheels. Verified against the canvas `viewBox`: a `(150, 90)` wheel moves both axes, `(0, 100)` moves only Y, and Shift+`(0, 100)` moves only X.

## Safety

- The adapter binds to `127.0.0.1` on an ephemeral port only.
- It accepts **no SQL, no request bodies and no file paths**. The diagram is converted in the CLI process and held in memory; the endpoint is a single `GET` of one known id. There is nothing in a request to inject, and no database is ever contacted.
- Static file serving is confined to drawDB's `dist/` (path-traversal guarded), and the SPA fallback only applies to navigation requests so a missing asset fails loudly instead of returning HTML to a script tag.
- Your Drizzle schema and migrations are never modified — `drizzle-kit export` is read-only, and a test asserts the project directory is unchanged.

## Fidelity

Handled by drawDB's importer (verified against real `drizzle-kit export` output):

| Construct | Status |
| --- | --- |
| Tables, columns, types, nullability | preserved |
| Primary keys (single and composite) | preserved |
| Foreign keys | preserved, with delete/update actions |
| Defaults | preserved (see caveat below) |
| Enums (`CREATE TYPE ... AS ENUM`) | preserved, including schema-qualified types |
| Unique constraints | preserved |
| Automatic layout | dagre layout, coordinates normalised to non-negative |
| Schemas | schema-qualified references resolve; drawDB has a single namespace, so same-named tables in two schemas collide |

Known limitations, all inherited from drawDB and reported rather than hidden:

- **`CREATE INDEX` / `CREATE UNIQUE INDEX` are dropped.** drawDB's PostgreSQL importer ignores them. The CLI reports `warning: … ignored these statement types: CREATE INDEX` instead of silently losing them.
- **String column defaults lose their quotes** (drawDB stores `user`, not `'user'`).
- **`CREATE SCHEMA`, `CREATE VIEW`, `CREATE EXTENSION`** are likewise ignored by drawDB.
- PostgreSQL only in this release; other dialects are rejected up front.

## Development

```bash
npm install
npm run build          # bundles drawDB's importer + the CLI
npm run typecheck
npm test               # unit + end-to-end (needs: npx playwright install chromium)
npm run test:browser   # browser suite only
```

Tests: `convert` (conversion, enums, composite keys, layout, warnings), `discoverConfig` (discovery, `--config`, dialect validation, error messages), `exportSchema` (real drizzle-kit, no database; asserts the project dir is untouched), `browser` (drives Chromium against the real editor and asserts both tables and the foreign-key path are rendered on the canvas — a successful HTTP response alone would fail this suite). The browser suite also covers the dark default and all three panning modes; each of those tests was confirmed to **fail against unpatched drawDB**, so they are not vacuous.

Fixtures under `fixtures/` are real Drizzle projects (`blog`, `enums`) with their own `drizzle.config.ts`.

## Licensing

drawDB is **AGPL-3.0**. This project bundles drawDB's SQL importer and builds against a patched drawDB checkout, so it is AGPL-3.0 as well. Before distributing a packaged build, note:

- the drawDB checkout is *not* vendored into this repo — you clone and patch it yourself, and the only thing shipped in the npm package is the patch file plus the bundled importer;
- AGPL §13 requires that users of a modified network-served version be offered its source. Our modified copy is drawDB plus `patches/0001-local-diagram-extension.patch`, which together reconstruct the complete source of what we serve;
- the bundled importer (`src/generated/drawdb-import.mjs`) is derived from drawDB source and carries the same obligation.

This is a legal-review item, not a solved one — get counsel before publishing.