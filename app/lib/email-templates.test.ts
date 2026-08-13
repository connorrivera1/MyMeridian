import { describe, expect, it } from "vitest";

import {
  renderHumanEmailSignature,
  renderNewsletterProductUpdate,
  renderWaitlistWelcome,
} from "./email-templates.server";

describe("MyMeridian email templates", () => {
  it("keeps the waitlist promise in an email-safe branded HTML and text pair", () => {
    const rendered = renderWaitlistWelcome({
      MERIDIAN_PUBLIC_ORIGIN: "https://mymeridian.io",
    });

    expect(rendered.subject).toContain("You're early");
    expect(rendered.text).toContain("how much did you actually keep?");
    expect(rendered.text).toContain("15% off the first 12 months");
    expect(rendered.html).toContain("mymeridian-email-logo.png");
    expect(rendered.html).toContain('role="presentation"');
    expect(rendered.html).not.toContain("data:image");
  });

  it("requires an unsubscribe URL for a marketing update and escapes untrusted copy", () => {
    const rendered = renderNewsletterProductUpdate({
      title: "<new & useful>",
      summary: "A safe update",
      articleUrl: "https://mymeridian.io/updates/one",
      unsubscribeUrl: "https://mymeridian.io/waitlist/unsubscribe?t=signed",
    });

    expect(rendered.html).toContain("Unsubscribe");
    expect(rendered.html).toContain("&lt;new &amp; useful&gt;");
    expect(rendered.text).toContain("Unsubscribe from product updates");
  });

  it("uses the real hosted mark in human sender signatures", () => {
    const signature = renderHumanEmailSignature({
      address: "support@mymeridian.io",
    });
    expect(signature).toContain("mymeridian-email-logo.png");
    expect(signature).toContain("support@mymeridian.io");
    expect(signature).toContain("Know what you kept. Know what to fix.");
  });
});
