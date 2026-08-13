import { beforeEach, describe, expect, it, vi } from "vitest";

const firstDeniedRequestLimit = vi.fn();
vi.mock("~/lib/rate-limit.server", () => ({
  firstDeniedRequestLimit: (...args: unknown[]) => firstDeniedRequestLimit(...args),
  RATE_LIMIT_MESSAGE: "Too many requests. Please try again later.",
  rateLimitHeaders: () => new Headers({ "retry-after": "60" }),
}));

const createWaitlistSignup = vi.fn();
const validateWaitlistSubmission = vi.fn();
vi.mock("~/lib/waitlist.server", () => ({
  createWaitlistSignup: (...args: unknown[]) => createWaitlistSignup(...args),
  validateWaitlistSubmission: (...args: unknown[]) => validateWaitlistSubmission(...args),
}));

const requestOriginIsSelf = vi.fn();
vi.mock("~/lib/web-session.server", () => ({
  requestOriginIsSelf: (...args: unknown[]) => requestOriginIsSelf(...args),
}));

const { action } = await import("./waitlist");

function post(fields: Record<string, string>) {
  const form = new FormData();
  for (const [name, value] of Object.entries(fields)) form.set(name, value);
  return new Request("https://mymeridian.io/waitlist", {
    method: "POST",
    headers: { origin: "https://mymeridian.io" },
    body: form,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  requestOriginIsSelf.mockReturnValue(true);
  firstDeniedRequestLimit.mockResolvedValue(null);
  validateWaitlistSubmission.mockReturnValue({
    ok: true,
    value: {
      email: "owner@example.com", storeUrl: null, source: "launch",
      utmSource: "youtube", utmMedium: null, utmCampaign: null,
      utmTerm: null, utmContent: null, marketingConsent: false,
    },
  });
  createWaitlistSignup.mockResolvedValue({ created: true });
});

describe("public waitlist action", () => {
  it("persists attributed valid submissions and always shows the same confirmation", async () => {
    await expect(action({ request: post({
      email: "OWNER@example.com", source: "launch", utm_source: "youtube",
    }) } as never)).rejects.toMatchObject({
      status: 302,
      headers: expect.any(Headers),
    });
    expect(createWaitlistSignup).toHaveBeenCalledWith(expect.objectContaining({
      email: "owner@example.com",
      source: "launch",
      utmSource: "youtube",
    }));
  });

  it("returns the same confirmation redirect when a normalized email already exists", async () => {
    createWaitlistSignup.mockResolvedValue({ created: false });
    let response: Response | undefined;
    try {
      await action({ request: post({ email: "owner@example.com" }) } as never);
    } catch (error) {
      response = error as Response;
    }
    expect(response?.headers.get("location")).toBe("/waitlist/confirmed");
  });

  it("rate limits public abuse before a database write", async () => {
    firstDeniedRequestLimit.mockResolvedValue({ retryAfterSeconds: 60 });
    const response = await action({ request: post({ email: "owner@example.com" }) } as never);
    expect(response).toMatchObject({ init: { status: 429 } });
    expect(createWaitlistSignup).not.toHaveBeenCalled();
  });

  it("does not mutate from a cross-site request", async () => {
    requestOriginIsSelf.mockReturnValue(false);
    const response = await action({ request: post({ email: "owner@example.com" }) } as never);
    expect(response).toMatchObject({ init: { status: 403 } });
    expect(firstDeniedRequestLimit).not.toHaveBeenCalled();
  });

  it("silently discards honeypot submissions", async () => {
    let response: Response | undefined;
    try {
      await action({ request: post({ email: "robot@example.com", website: "filled" }) } as never);
    } catch (error) {
      response = error as Response;
    }
    expect(response?.headers.get("location")).toBe("/waitlist/confirmed");
    expect(createWaitlistSignup).not.toHaveBeenCalled();
  });
});
