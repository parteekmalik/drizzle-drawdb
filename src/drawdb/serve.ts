import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { AddressInfo } from "node:net";
import type { DiagramRecord } from "../types";

/** Namespace for the adapter's own endpoints, kept out of drawDB's way. */
export const API_PREFIX = "/__drizzle_drawdb";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".webp": "image/webp",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json; charset=utf-8",
};

export interface AdapterOptions {
  /** Directory holding drawDB's built assets. */
  dist: string;
  /** The diagram this session serves; replaced via `updateDiagram` on schema changes. */
  record: DiagramRecord;
  /**
   * Forces a theme via drawDB's own `?theme=` query parameter. drawDB's patched
   * default is already dark, so this is only needed to force light (or to force
   * dark over a previously stored preference).
   */
  theme?: "light" | "dark" | undefined;
}

export interface Adapter {
  server: Server;
  url: string;
  port: number;
  /** Full URL of the drawDB editor with the diagram already loaded. */
  editorUrl: string;
  /**
   * Replaces the served diagram and pushes the new revision to every SSE
   * subscriber, so open editors reload without manual refresh.
   *
   * @returns the new revision number.
   */
  updateDiagram: (record: DiagramRecord) => number;
  close: () => Promise<void>;
}

/** How often each SSE stream gets a heartbeat comment to stay alive behind proxies. */
const SSE_HEARTBEAT_MS = 25_000;

/**
 * Serves the real drawDB build over loopback, plus one read-only endpoint that
 * hands the pre-converted diagram to our drawDB extension.
 *
 * The adapter accepts no SQL, no file paths and no request bodies -- the diagram
 * is converted in the CLI process and held in memory, so there is nothing for a
 * request to inject. It binds to 127.0.0.1 only.
 */
export async function startAdapter(options: AdapterOptions): Promise<Adapter> {
  const dist = resolve(options.dist);
  const diagramId = options.record.diagramId;

  // The diagram is mutable: the CLI re-exports and reconverts when the schema
  // changes, and `updateDiagram` swaps it in while bumping the revision that
  // SSE subscribers listen for.
  let currentRecord = options.record;
  let revision = 0;
  const subscribers = new Set<import("node:http").ServerResponse>();
  let heartbeat: NodeJS.Timeout | undefined;

  const broadcast = (event: string, payload: unknown): void => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
    for (const response of subscribers) {
      try {
        response.write(frame);
      } catch {
        subscribers.delete(response);
      }
    }
  };

  const closeStream = (response: import("node:http").ServerResponse): void => {
    subscribers.delete(response);
    if (subscribers.size === 0 && heartbeat) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
  };

  // `origin` is filled in once the socket is bound; the /config.js handler needs
  // it to advertise the adapter's own origin back to the extension.
  const context: HandleContext = {
    dist,
    diagramId,
    origin: "",
    record: () => currentRecord,
    revision: () => revision,
    subscribe: (response) => {
      subscribers.add(response);

      if (!heartbeat) {
        heartbeat = setInterval(() => {
          for (const subscriber of subscribers) {
            try {
              subscriber.write(": ping\n\n");
            } catch {
              subscribers.delete(subscriber);
            }
          }
        }, SSE_HEARTBEAT_MS);
        heartbeat.unref?.();
      }

      return () => closeStream(response);
    },
  };

  const server = createServer((request, response) => {
    handle(request, response, context).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500, { "content-type": "text/plain" });
      }
      response.end("Internal error");
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });

  const address = server.address() as AddressInfo;
  const port = address.port;
  const url = `http://127.0.0.1:${port}`;
  context.origin = url;

  // drawDB reads `?theme=` through its existing queryConfig (utils/queryConfig.js).
  const query = options.theme ? `?theme=${options.theme}` : "";

  return {
    server,
    url,
    port,
    editorUrl: `${url}/editor/diagrams/${encodeURIComponent(diagramId)}${query}`,
    updateDiagram: (record: DiagramRecord): number => {
      revision += 1;
      currentRecord = record;
      broadcast("diagram", { revision, diagramId: record.diagramId });
      return revision;
    },
    close: () =>
      new Promise<void>((resolveClose) => {
        // Shutdown is best-effort and idempotent: closing twice, or closing a
        // server that already went away, must never reject.
        server.closeAllConnections?.();
        if (heartbeat) clearInterval(heartbeat);
        for (const response of subscribers) {
          try {
            response.end();
          } catch {
            // Already gone; nothing to clean up.
          }
        }
        subscribers.clear();
        server.close(() => resolveClose());
      }),
  };
}

interface HandleContext {
  dist: string;
  diagramId: string;
  /** Loopback origin, set once listening. */
  origin: string;
  /** Current diagram; swapped out by `Adapter.updateDiagram`. */
  record: () => DiagramRecord;
  /** Current diagram revision; bumped by `Adapter.updateDiagram`. */
  revision: () => number;
  /**
   * Registers an SSE subscriber and returns an unsubscribe function, used to
   * stop the stream when the client goes away.
   */
  subscribe: (response: import("node:http").ServerResponse) => () => void;
}

async function handle(
  request: import("node:http").IncomingMessage,
  response: import("node:http").ServerResponse,
  context: HandleContext,
): Promise<void> {
  if (request.method !== "GET" && request.method !== "HEAD") {
    sendJson(response, 405, { error: "Method not allowed" });
    return;
  }

  const path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;

  if (path === `${API_PREFIX}/health`) {
    sendJson(response, 200, {
      ok: true,
      diagramId: context.diagramId,
      drawdb: true,
    });
    return;
  }

  if (path === `${API_PREFIX}/events`) {
    // Server-Sent Events: the drawDB extension subscribes here so a schema
    // change in the CLI reloads the open editor without manual refresh.
    response.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
    });
    response.write(
      `event: ready\ndata: ${JSON.stringify({ revision: context.revision() })}\n\n`,
    );
    const unsubscribe = context.subscribe(response);
    request.once("close", unsubscribe);
    return;
  }

  if (path === `${API_PREFIX}/diagrams/${encodeURIComponent(context.diagramId)}`) {
    sendJson(response, 200, context.record());
    return;
  }

  if (path.startsWith(`${API_PREFIX}/`)) {
    sendJson(response, 404, { error: "Unknown endpoint" });
    return;
  }

  // Runtime config. drawDB's index.html already loads /config.js before the app
  // bundle, and our extension reads `localDiagramBase` from it.
  if (path === "/config.js") {
    send(
      response,
      200,
      `window.__DRAWDB_CONFIG__ = ${JSON.stringify({
        localDiagramBase: `${context.origin}${API_PREFIX}`,
      })};`,
      ".js",
    );
    return;
  }

  serveStatic(response, context.dist, path, request.headers.accept ?? "");
}

function serveStatic(
  response: import("node:http").ServerResponse,
  dist: string,
  path: string,
  acceptHeader: string,
): void {
  const candidate = safeJoin(dist, path);

  if (candidate && existsSync(candidate) && statSync(candidate).isFile()) {
    sendFile(response, candidate);
    return;
  }

  // SPA fallback only for navigations. Serving index.html for a missing .js
  // asset makes the browser fail with "Unexpected token '<'", which hides the
  // real problem, so anything that looks like a file gets a clean 404.
  const looksLikeFile = extname(path) !== "";
  const wantsHtml = acceptHeader.includes("text/html");

  if (!looksLikeFile && wantsHtml) {
    const index = join(dist, "index.html");
    if (existsSync(index)) {
      sendFile(response, index);
      return;
    }
  }

  response.writeHead(404, { "content-type": "text/plain" });
  response.end("Not found");
}

/** Guards against path traversal out of the drawDB dist directory. */
function safeJoin(dist: string, path: string): string | null {
  const decoded = decodeURIComponent(path);
  const target = normalize(join(dist, decoded));
  if (target !== dist && !target.startsWith(dist + sep)) return null;
  return target;
}

function sendFile(
  response: import("node:http").ServerResponse,
  file: string,
): void {
  const type = MIME_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
  response.writeHead(200, {
    "content-type": type,
    "cache-control": file.endsWith("index.html") ? "no-store" : "public, max-age=31536000",
  });
  createReadStream(file).pipe(response);
}

function send(
  response: import("node:http").ServerResponse,
  status: number,
  body: string,
  extension: string,
): void {
  response.writeHead(status, {
    "content-type": MIME_TYPES[extension] ?? "text/plain; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
}

function sendJson(
  response: import("node:http").ServerResponse,
  status: number,
  payload: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(payload));
}