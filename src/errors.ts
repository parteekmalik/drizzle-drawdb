/**
 * A user-facing failure. `hint` is printed on its own line under the message so
 * the actionable part is easy to spot.
 */
export class CliError extends Error {
  readonly hint: string | undefined;
  readonly exitCode: number;

  constructor(message: string, options?: { hint?: string; exitCode?: number }) {
    super(message);
    this.name = "CliError";
    this.hint = options?.hint;
    this.exitCode = options?.exitCode ?? 1;
  }
}

export function isCliError(error: unknown): error is CliError {
  return error instanceof CliError;
}