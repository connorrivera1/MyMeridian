import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const contact = {
  supportEmail: "support@example.com",
  supportUrl: "https://example.com/help",
  legalEntity: "Example Analytics LLC",
  complete: true,
};

vi.mock("react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react-router")>()),
  useLoaderData: () => ({ contact }),
}));
vi.mock("~/lib/brand.server", () => ({
  contactDetails: () => contact,
}));

const privacy = await import("./legal.privacy");
const support = await import("./legal.support");

describe("public legal routes", () => {
  it("keeps privacy public, names every live data boundary, and renders contact", () => {
    expect(privacy.loader()).toEqual({ contact });

    const html = renderToStaticMarkup(createElement(privacy.default));

    expect(html).toContain("Privacy policy");
    expect(html).toContain("read_all_orders");
    expect(html).toContain("read_reports");
    expect(html).toContain("does not query or persist shopper name");
    expect(html).toContain("support@example.com");
  });

  it("keeps support public and describes the connectors that actually ship", () => {
    expect(support.loader()).toEqual({ contact });

    const html = renderToStaticMarkup(createElement(support.default));

    expect(html).toContain("Support");
    expect(html).toContain("connected Meta, Google or TikTok source");
    expect(html).toContain("never treats an unconnected account as zero spend");
    expect(html).toContain("support@example.com");
    expect(html).not.toContain("This release has no ad-spend connector");
  });
});
