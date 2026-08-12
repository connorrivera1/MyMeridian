/**
 * Error objects from HTTP clients, database drivers and provider SDKs can carry
 * request URLs, response bodies and headers. Keep durable job status and
 * console telemetry useful by recording a category, never the raw error.
 */
export function operationalErrorKind(error: unknown): string {
  if (!(error instanceof Error)) return "UnknownError";
  const name = error.name.trim();
  return /^[A-Za-z0-9_.-]{1,80}$/.test(name) ? name : "Error";
}

export function safeOperationalFailure(error: unknown): string {
  return `Operation failed (${operationalErrorKind(error)}).`;
}

export function logOperationalFailure(scope: string, error: unknown): void {
  console.error("[%s] %s", scope, safeOperationalFailure(error));
}
