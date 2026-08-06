import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * App Bridge in the head of the *error* document.
 *
 * Shopify's embedded requirement is that `app-bridge.js` is the first script
 * in the head of every document. `Layout` wraps the error boundary as well as
 * the app, and on an error document the root loader may never have run — a
 * 404 matches no route, so nothing calls it — leaving `useRouteLoaderData`
 * undefined and the script absent. That is the one page a merchant most needs
 * App Bridge on: without it the page breaks out of the admin iframe and there
 * is no way back into the app.
 *
 * Rendered through `renderToStaticMarkup` rather than a router, because what
 * is being asserted is the markup of the head and nothing else.
 */

const useRouteLoaderData = vi.fn();

vi.mock("react-router", () => ({
  useRouteLoaderData: (...args: unknown[]) => useRouteLoaderData(...args),
  Links: () => null,
  Meta: () => null,
  Outlet: () => null,
  Scripts: () => null,
  ScrollRestoration: () => null,
}));

const { Layout } = await import("./root");

function render(): string {
  return renderToStaticMarkup(createElement(Layout, { children: null }));
}

const ORIGINAL_KEY = process.env.SHOPIFY_API_KEY;

beforeEach(() => {
  vi.clearAllMocks();
  process.env.SHOPIFY_API_KEY = "test-api-key";
});

afterEach(() => {
  if (ORIGINAL_KEY === undefined) delete process.env.SHOPIFY_API_KEY;
  else process.env.SHOPIFY_API_KEY = ORIGINAL_KEY;
});

describe("root Layout", () => {
  it("emits App Bridge on the happy path, meta tag before the script", () => {
    useRouteLoaderData.mockReturnValue({ appBridgeApiKey: "live-key" });

    const html = render();

    expect(html).toContain('<meta name="shopify-api-key" content="live-key"/>');
    expect(html).toContain(
      '<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"',
    );
    // App Bridge reads the client id from the meta tag as it loads. After it,
    // the tag is never read and session tokens are never minted.
    expect(html.indexOf('name="shopify-api-key"')).toBeLessThan(
      html.indexOf("app-bridge.js"),
    );
  });

  // The gap this test exists for.
  it("still emits App Bridge when the root loader produced nothing", () => {
    // What `useRouteLoaderData("root")` returns on a document whose root
    // loader never ran — an unmatched path, or a loader that threw.
    useRouteLoaderData.mockReturnValue(undefined);

    const html = render();

    expect(html).toContain('<meta name="shopify-api-key" content="test-api-key"/>');
    expect(html).toContain(
      '<script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"',
    );
  });

  // The loader deliberately returns "" for a request that must not load App
  // Bridge — the seeded demo, and the unauthenticated legal pages, which App
  // Bridge would redirect back into the admin. The fallback must not override
  // that decision; it only covers the case where no decision was made.
  it("respects a loader that decided against App Bridge", () => {
    useRouteLoaderData.mockReturnValue({ appBridgeApiKey: "" });

    const html = render();

    expect(html).not.toContain("app-bridge.js");
    expect(html).not.toContain("shopify-api-key");
  });

  it("emits nothing rather than an empty key when none is configured", () => {
    delete process.env.SHOPIFY_API_KEY;
    useRouteLoaderData.mockReturnValue(undefined);

    const html = render();

    expect(html).not.toContain("app-bridge.js");
  });
});
