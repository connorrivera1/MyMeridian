/**
 * The message shown when someone presses a sign-in provider that has no
 * credentials configured yet.
 *
 * Client-safe, so the login and signup components can render it without
 * dragging `web-oauth.server` — and its node crypto and network calls — into
 * the browser bundle.
 */

const NOTICES: Record<string, string> = {
  "google-unavailable":
    "Google sign-in isn't connected yet. Use your email and password for now.",
  "microsoft-unavailable":
    "Microsoft sign-in isn't connected yet. Use your email and password for now.",
  "apple-unavailable":
    "Apple sign-in isn't connected yet. Use your email and password for now.",
  oauth: "That sign-in didn't complete. Try again.",
  cancelled: "That sign-in was cancelled.",
};

export function providerNotice(code: string | null): string | null {
  if (!code) return null;
  return NOTICES[code] ?? null;
}
