export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 2,
    readonly details?: unknown,
  ) {
    super(message);
  }
}
export function errorInfo(error: unknown) {
  if (error instanceof CliError) return error;
  const message = error instanceof Error ? error.message : "Unknown error";
  const errno = (error as NodeJS.ErrnoException)?.code;
  if (errno === "ENOENT") return new CliError("NOT_FOUND", message, 6);
  if (/not found/i.test(message)) return new CliError("NOT_FOUND", message, 6);
  if (/Ambiguous/.test(message))
    return new CliError("AMBIGUOUS_ID", message, 2);
  if (/Another imagegen process/.test(message))
    return new CliError("ENGINE_BUSY", message, 5);
  if (/retry.*required|requires explicit retry/i.test(message))
    return new CliError("RETRY_CONFIRMATION_REQUIRED", message, 2);
  return new CliError("INVALID_INPUT", message, 2);
}
export function envelope(command: string, data: unknown, error?: CliError) {
  return {
    schemaVersion: 1,
    ok: !error,
    command,
    ...(data !== undefined ? { data } : {}),
    ...(error
      ? {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details !== undefined ? { details: error.details } : {}),
          },
        }
      : {}),
  };
}
