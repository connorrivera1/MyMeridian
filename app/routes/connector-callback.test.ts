import { describe, expect, it, vi } from "vitest";

const finishConnectorOAuth = vi.fn();

vi.mock("~/lib/connector-oauth.server", () => ({
  connectorProviderForSlug: (slug: string) =>
    slug === "meta" ? "FACEBOOK_ADS" : null,
  finishConnectorOAuth: (...args: unknown[]) => finishConnectorOAuth(...args),
}));
vi.mock("~/lib/public-origin.server", () => ({
  publicAppOrigin: () => "https://meridian.example",
}));

const { loader } = await import("./connector-callback");

async function redirectLocation(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
    throw new Error("Expected redirect");
  } catch (error) {
    expect(error).toBeInstanceOf(Response);
    return (error as Response).headers.get("location") ?? "";
  }
}

describe("connector OAuth callback error boundary", () => {
  it("does not preserve provider-supplied error text in a browser-visible URL", async () => {
    const location = await redirectLocation(
      loader({
        request: new Request(
          "https://meridian.example/connections/meta/callback?error_description=token%3Dsecret-value",
        ),
        params: { provider: "meta" },
      } as never),
    );

    expect(location).toContain("Provider+authorization+was+cancelled+or+failed");
    expect(location).not.toContain("secret-value");
  });

  it("returns a generic error when code exchange fails", async () => {
    finishConnectorOAuth.mockRejectedValueOnce(new Error("provider token=secret-value"));

    const location = await redirectLocation(
      loader({
        request: new Request(
          "https://meridian.example/connections/meta/callback?code=code&state=state",
        ),
        params: { provider: "meta" },
      } as never),
    );

    expect(location).toContain("Connector+setup+failed");
    expect(location).not.toContain("secret-value");
  });
});
