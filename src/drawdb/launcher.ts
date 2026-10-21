import { spawn } from "node:child_process";

/**
 * Opens `url` in the platform's default browser.
 *
 * Never throws: a failed launch is reported so the caller can print the URL
 * instead, which is still a perfectly usable outcome.
 */
export async function openInBrowser(url: string): Promise<boolean> {
  const [command, args] = resolveCommand(url);

  return new Promise<boolean>((resolveResult) => {
    try {
      const child = spawn(command, args, {
        stdio: "ignore",
        detached: true,
      });

      child.once("error", () => resolveResult(false));
      child.unref();
      resolveResult(true);
    } catch {
      resolveResult(false);
    }
  });
}

function resolveCommand(url: string): [string, string[]] {
  switch (process.platform) {
    case "darwin":
      return ["open", [url]];
    case "win32":
      return ["cmd", ["/c", "start", "", url]];
    default:
      return ["xdg-open", [url]];
  }
}