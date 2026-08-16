import { beforeEach, expect, it, vi } from "vitest";

import { inlineScriptHashes } from "~/lib/public-document-security.server";

const canonicalDeploymentRedirect = vi.fn();
vi.mock("~/lib/public-origin.server", () => ({
  canonicalDeploymentRedirect: (...args: unknown[]) =>
    canonicalDeploymentRedirect(...args),
}));

const { loader: confirmed } = await import("./waitlist-confirmed");
const { loader: unsubscribed } = await import("./waitlist-unsubscribed");

beforeEach(() => {
  vi.clearAllMocks();
  canonicalDeploymentRedirect.mockReturnValue(null);
});

it("applies a strict CSP and baseline security headers to both static waitlist pages", async () => {
  const request = new Request("https://mymeridian.io/waitlist/confirmed");
  for (const loader of [confirmed, unsubscribed]) {
    const response = await loader({ request } as never);
    expect(response.headers.get("strict-transport-security")).toBe(
      "max-age=31536000",
    );
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("referrer-policy")).toBe(
      "strict-origin-when-cross-origin",
    );
    const policy = response.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy.match(/script-src ([^;]+)/)?.[1]).not.toContain(
      "'unsafe-inline'",
    );
    for (const hash of inlineScriptHashes(await response.clone().text())) {
      expect(policy).toContain(hash);
    }
  }
});

it("gives each static waitlist visitor an independent response body", async () => {
  const request = new Request("https://mymeridian.io/waitlist/confirmed");

  for (const loader of [confirmed, unsubscribed]) {
    const responses = Array.from({ length: 16 }, () =>
      loader({ request } as never),
    );
    await expect(
      Promise.all(responses).then((loaded) =>
        Promise.all(loaded.map((response) => response.text())),
      ),
    ).resolves.toEqual(
      Array.from({ length: 16 }, () =>
        expect.stringContaining("<!doctype html>"),
      ),
    );
  }
});
