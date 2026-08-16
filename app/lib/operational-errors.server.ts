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

function safeOperationalCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = Reflect.get(error, "code");
  // Provider/database error codes are safe operational classifications. Never
  // record messages because they can contain URLs, headers, or response data.
  return typeof code === "string" && /^(?:P\d{4}|[A-Z][A-Z0-9_]{1,63})$/.test(code)
    ? code
    : null;
}

export function safeOperationalFailure(error: unknown): string {
  const code = safeOperationalCode(error);
  return `Operation failed (${operationalErrorKind(error)}${code ? `, ${code}` : ""}).`;
}

export function logOperationalFailure(scope: string, error: unknown): void {
  console.error("[%s] %s", scope, safeOperationalFailure(error));
}
