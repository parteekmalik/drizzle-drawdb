import { runOpen } from "./commands/open";
import { runExport } from "./commands/export";
import { formatDoctorResult, runDoctor } from "./commands/doctor";
import { isCliError } from "./errors";
import type { ConversionResult } from "./types";

const HELP = `drizzle-drawdb — open the real drawDB editor with your Drizzle schema

Usage
  drizzle-drawdb [open] [options]     Export the schema and open drawDB (default)
  drizzle-drawdb export [options]     Write a drawDB JSON file instead
  drizzle-drawdb doctor [options]     Show what the tool can detect, launch nothing

Options
  -c, --config <path>   Path to the drizzle config (default: auto-discover upward)
  -o, --out <path>      Output file for \`export\` (default: ./schema.drawdb.json)
      --title <title>   Diagram title
      --drawdb-dir <p>  Path to a drawDB checkout carrying the extension patch
      --theme <t>       Force the editor theme: light | dark (default: dark)
      --no-open         Print the editor URL instead of launching a browser
      --no-watch        Do not update the diagram when schema files change
  -h, --help            Show this help
  -v, --version         Show version

The default command watches your schema files (like \`prisma studio\`): saving an
edit re-exports the schema and reloads the diagram in the open editor.

Examples
  drizzle-drawdb
  drizzle-drawdb --config ./drizzle.config.ts
  drizzle-drawdb export --out ./schema.drawdb.json
  drizzle-drawdb doctor
`;

interface ParsedArgs {
  command: "open" | "export" | "doctor" | "help" | "version";
  configPath?: string | undefined;
  out?: string | undefined;
  title?: string | undefined;
  drawdbDir?: string | undefined;
  theme?: "light" | "dark" | undefined;
  noOpen: boolean;
  watch: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { command: "open", noOpen: false, watch: true };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;

    switch (arg) {
      case "-h":
      case "--help":
        return { ...parsed, command: "help" };
      case "-v":
      case "--version":
        return { ...parsed, command: "version" };
      case "--no-open":
        parsed.noOpen = true;
        break;
      case "--no-watch":
        parsed.watch = false;
        break;
      case "-c":
      case "--config":
        parsed.configPath = requireValue(argv, (i += 1), arg);
        break;
      case "-o":
      case "--out":
        parsed.out = requireValue(argv, (i += 1), arg);
        break;
      case "--title":
        parsed.title = requireValue(argv, (i += 1), arg);
        break;
      case "--drawdb-dir":
        parsed.drawdbDir = requireValue(argv, (i += 1), arg);
        break;
      case "--theme": {
        const value = requireValue(argv, (i += 1), arg);
        if (value !== "light" && value !== "dark") {
          throw new UsageError(`--theme must be "light" or "dark", got: ${value}`);
        }
        parsed.theme = value;
        break;
      }
      default:
        if (arg.startsWith("-")) {
          throw new UsageError(`Unknown option: ${arg}`);
        }
        positional.push(arg);
    }
  }

  const [first] = positional;
  if (first === "open" || first === "export" || first === "doctor") {
    parsed.command = first;
  } else if (first !== undefined) {
    throw new UsageError(`Unknown command: ${first}`);
  }

  if (parsed.command === "export" && parsed.out === undefined) {
    parsed.out = "schema.drawdb.json";
  }

  return parsed;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("-")) {
    throw new UsageError(`${flag} requires a value`);
  }
  return value;
}

export class UsageError extends Error {}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: ParsedArgs;

  try {
    args = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n\n${HELP}`);
    return 2;
  }

  if (args.command === "help") {
    process.stdout.write(HELP);
    return 0;
  }

  if (args.command === "version") {
    process.stdout.write(`${await readVersion()}\n`);
    return 0;
  }

  const cwd = process.cwd();

  if (args.command === "doctor") {
    const result = await runDoctor({
      cwd,
      configPath: args.configPath,
      drawdbDir: args.drawdbDir,
    });

    process.stdout.write(`drizzle-drawdb doctor\n${formatDoctorResult(result)}\n`);

    if (!result.ok) {
      process.stdout.write("\nSome checks failed.\n");
      return 1;
    }

    process.stdout.write("\nAll checks passed.\n");
    return 0;
  }

  if (args.command === "export") {
    const result = await runExport({
      cwd,
      configPath: args.configPath,
      out: args.out ?? "schema.drawdb.json",
      title: args.title,
    });

    process.stdout.write(
      `Wrote ${result.outPath}\n  ${result.tableCount} tables, ${result.relationshipCount} relationships\n`,
    );
    process.stdout.write("Import it in drawDB via Import → JSON.\n");
    return 0;
  }

  const open = await runOpen({
    cwd,
    configPath: args.configPath,
    title: args.title,
    drawdbDir: args.drawdbDir,
    theme: args.theme,
    noOpen: args.noOpen,
    watch: args.watch,
  });

  reportConversion(open.conversion);
  process.stdout.write(`\n${open.editorUrl}\n`);

  if (!args.noOpen) {
    process.stdout.write(
      "\nEditor is running. Press Ctrl+C to stop the local server.\n",
    );
  } else {
    process.stdout.write(
      "\nServer is running. Press Ctrl+C to stop it.\n",
    );
  }

  await waitForShutdown();
  await open.close();
  return 0;
}

function reportConversion(conversion: ConversionResult): void {
  const { tables, references } = conversion.record;

  process.stdout.write(
    `Converted ${tables.length} tables and ${references.length} relationships using drawDB's importer.\n`,
  );

  for (const warning of conversion.warnings) {
    process.stdout.write(`\nwarning: ${warning.message}\n`);
  }
}

function waitForShutdown(): Promise<void> {
  return new Promise<void>((resolveSignal) => {
    const stop = () => resolveSignal();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function readVersion(): Promise<string> {
  try {
    const { readFile } = await import("node:fs/promises");
    const { fileURLToPath } = await import("node:url");
    const { dirname, join } = await import("node:path");

    const here = dirname(fileURLToPath(import.meta.url));
    const manifest = JSON.parse(
      await readFile(join(here, "..", "package.json"), "utf8"),
    ) as { version?: string };

    return manifest.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const isDirectRun =
  process.argv[1] !== undefined &&
  (import.meta.url.endsWith(process.argv[1].replace(/^.*?(?=\/)/, "")) ||
    import.meta.url === `file://${process.argv[1]}`);

if (isDirectRun) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error: unknown) => {
      if (isCliError(error)) {
        process.stderr.write(`error: ${error.message}\n`);
        if (error.hint) process.stderr.write(`\n${error.hint}\n`);
        process.exitCode = error.exitCode;
        return;
      }

      process.stderr.write(`error: ${(error as Error)?.message ?? String(error)}\n`);
      if (process.env.DEBUG) process.stderr.write(`${(error as Error)?.stack}\n`);
      process.exitCode = 1;
    });
}