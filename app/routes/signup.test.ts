import { beforeEach, describe, expect, it, vi } from "vitest";

const resolveWebUser = vi.fn();
const resolvePendingWebSession = vi.fn();
const firstDeniedRequestLimit = vi.fn();
const createPasswordUser = vi.fn();
const createVerificationToken = vi.fn();
const createSession = vi.fn();
const requestOriginIsSelf = vi.fn();

vi.mock("~/lib/auth.server", () => ({
  resolveWebUser: (...args: unknown[]) => resolveWebUser(...args),
  resolvePendingWebSession: (...args: unknown[]) => resolvePendingWebSession(...args),
}));
vi.mock("~/lib/brand", () => ({ APP_NAME: "MyMeridian" }));
vi.mock("~/lib/web-oauth.server", () => ({
  safeReturnPath: (value: string) => (value.startsWith("/") ? value : "/app"),
}));
vi.mock("~/lib/rate-limit.server", () => ({
  firstDeniedRequestLimit: (...args: unknown[]) => firstDeniedRequestLimit(...args),
  RATE_LIMIT_MESSAGE: "Too many requests.",
  rateLimitHeaders: () => ({ "retry-after": "60" }),
}));
vi.mock("~/lib/web-session.server", () => ({
  requestIsSecure: () => true,
  requestOriginIsSelf: (...args: unknown[]) => requestOriginIsSelf(...args),
  serializeSessionCookie: () => "session=test",
}));
vi.mock("~/lib/webauth.server", () => ({
  SESSION_TTL_MS: 1_000,
  createPasswordUser: (...args: unknown[]) => createPasswordUser(...args),
  createSession: (...args: unknown[]) => createSession(...args),
  createVerificationToken: (...args: unknown[]) => createVerificationToken(...args),
  normalizeEmail: (email: string) => email.trim().toLowerCase(),
}));

const { action } = await import("./signup");

function post(fields: Record<string, string>) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return new Request("https://mymeridian.io/signup", {
    method: "POST",
    headers: { origin: "https://mymeridian.io" },
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requestOriginIsSelf.mockReturnValue(true);
  firstDeniedRequestLimit.mockResolvedValue(null);
  createPasswordUser.mockResolvedValue({ ok: true, user: { id: "user_1" } });
  createVerificationToken.mockResolvedValue("verification-token");
  createSession.mockResolvedValue("session-token");
});

describe("signup bot protection", () => {
  it("silently discards a honeypot submission before rate limiting or account creation", async () => {
    const response = await action({
      request: post({
        email: "robot@example.com",
        password: "long-enough-password",
        website: "filled",
      }),
    } as never);

    expect(response).toBeInstanceOf(Response);
    if (!(response instanceof Response)) throw new Error("Expected a redirect response.");
    expect(response.headers.get("location")).toBe("/welcome?pending=1");
    expect(firstDeniedRequestLimit).not.toHaveBeenCalled();
    expect(createPasswordUser).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
  });
});
