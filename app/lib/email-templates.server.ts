/**
 * Email-safe MyMeridian templates.
 *
 * These are intentionally table-and-inline-style based: Gmail, Outlook and
 * Apple Mail each ignore a different subset of modern CSS. The layout keeps a
 * restrained dark Meridian surface while still reading cleanly when images or
 * dark-mode overrides are unavailable. Every renderer returns matching HTML
 * and plain text so delivery never depends on an image or a rich client.
 */

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export interface EmailCta {
  label: string;
  href: string;
}

const DEFAULT_ORIGIN = "https://mymeridian.io";
const EMAIL_FONT = "'Satoshi','Avenir Next','Helvetica Neue',Arial,sans-serif";

function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[char]!,
  );
}

function publicOrigin(env: NodeJS.ProcessEnv = process.env): string {
  const candidate = env.MERIDIAN_PUBLIC_ORIGIN?.trim() || DEFAULT_ORIGIN;
  try {
    const parsed = new URL(candidate);
    return parsed.protocol === "https:" || parsed.protocol === "http:"
      ? parsed.origin
      : DEFAULT_ORIGIN;
  } catch {
    return DEFAULT_ORIGIN;
  }
}

function emailHref(raw: string): string {
  try {
    const url = new URL(raw);
    if (url.protocol === "https:" || url.protocol === "http:") {
      return escapeHtml(url.toString());
    }
  } catch {
    // The template is a server boundary. Do not turn a malformed link into a
    // mail-client executable scheme merely because an upstream caller drifted.
  }
  throw new Error("Email links must be absolute http(s) URLs.");
}

function paragraphs(lines: string[]): string {
  return lines
    .map(
      (line) =>
        `<p style="margin:0 0 18px;color:#b8b8b8;font-family:${EMAIL_FONT};font-size:16px;font-weight:400;line-height:1.7;">${escapeHtml(line)}</p>`,
    )
    .join("");
}

function emailShell(input: {
  eyebrow: string;
  title: string;
  preheader: string;
  bodyHtml: string;
  cta?: EmailCta;
  footerHtml?: string;
  env?: NodeJS.ProcessEnv;
}): string {
  const origin = publicOrigin(input.env);
  const shield = `${origin}/favicon-globe.svg?v=20260812`;
  const cta = input.cta
    ? `<tr><td style="padding:8px 42px 8px;"><a href="${emailHref(input.cta.href)}" style="display:inline-block;background:#f5f5f5;border:1px solid #f5f5f5;border-radius:999px;color:#0a0a0a;font-family:${EMAIL_FONT};font-size:14px;font-weight:700;line-height:20px;padding:13px 20px;text-decoration:none;">${escapeHtml(input.cta.label)}</a></td></tr>`
    : "";
  const footer = input.footerHtml
    ? input.footerHtml
    : `<p style="margin:0;color:#888888;font-family:${EMAIL_FONT};font-size:12px;line-height:1.6;">MyMeridian<br />Know what you kept. Know what to fix.</p>`;

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="x-apple-disable-message-reformatting" />
    <title>${escapeHtml(input.title)}</title>
    <style>
      @import url("https://api.fontshare.com/v2/css?f[]=satoshi@400,500,600,700&display=swap");
    </style>
  </head>
  <body style="margin:0;padding:0;background:#0a0a0a;color:#f5f5f5;">
    <span style="display:none!important;color:transparent;font-size:1px;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">${escapeHtml(input.preheader)}&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;</span>
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" bgcolor="#0a0a0a" style="background:#0a0a0a;margin:0;padding:0;width:100%;">
      <tr><td align="center" style="padding:44px 16px;">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#101010;border:1px solid #303030;border-radius:28px;max-width:600px;overflow:hidden;width:100%;">
          <tr><td style="padding:40px 42px 18px;">
            <table role="presentation" cellspacing="0" cellpadding="0" border="0"><tr>
              <td style="padding:0 11px 0 0;"><img src="${escapeHtml(shield)}" width="30" height="30" alt="" style="border:0;display:block;height:30px;width:30px;outline:none;text-decoration:none;" /></td>
              <td style="color:#f5f5f5;font-family:${EMAIL_FONT};font-size:17px;font-weight:600;letter-spacing:0.01em;line-height:30px;">MyMeridian</td>
            </tr></table>
          </td></tr>
          <tr><td style="padding:16px 42px 8px;">
            <p style="color:#8c8c8c;font-family:${EMAIL_FONT};font-size:11px;font-weight:600;letter-spacing:1.8px;line-height:16px;margin:0 0 16px;text-transform:uppercase;"><span style="color:#f5f5f5;">&#9472;&#9472;</span>&nbsp;&nbsp;${escapeHtml(input.eyebrow)}</p>
            <h1 style="color:#f5f5f5;font-family:${EMAIL_FONT};font-size:36px;font-weight:500;letter-spacing:-1.25px;line-height:1.08;margin:0 0 23px;">${escapeHtml(input.title)}</h1>
          </td></tr>
          <tr><td style="padding:0 42px 16px;">${input.bodyHtml}</td></tr>
          ${cta}
          <tr><td style="padding:30px 42px 38px;border-top:1px solid #303030;">${footer}</td></tr>
        </table>
      </td></tr>
    </table>
  </body>
</html>`;
}

export function renderWaitlistWelcome(
  env: NodeJS.ProcessEnv = process.env,
): RenderedEmail {
  const subject = "You're early — MyMeridian";
  const text = [
    "You're early.",
    "",
    "Thanks for joining the MyMeridian waitlist.",
    "",
    "We're building Meridian to answer a question every Shopify business should be able to answer:",
    "",
    "You know what you sold. But how much did you actually keep?",
    "",
    "Meridian brings together your orders, product costs, shipping, fulfillment, payment fees, advertising and overhead to show where your money actually goes, then helps surface the orders, products, channels and operational problems that deserve attention.",
    "",
    "We're getting ready for launch now.",
    "",
    "You'll be among the first to know when early access opens.",
    "",
    "As a Founding Merchant, your server-side eligibility is reserved for 15% off the first 12 months of a monthly Meridian plan when the offer is activated at launch. Annual pricing is not automatically combined with this benefit.",
    "",
    "MyMeridian",
    "Know what you kept. Know what to fix.",
  ].join("\n");

  return {
    subject,
    text,
    html: emailShell({
      eyebrow: "Founding Merchant",
      title: "You're Early.",
      preheader: "Your MyMeridian early-access place is reserved.",
      bodyHtml: [
        ...[
          "Thanks for joining the MyMeridian waitlist.",
          "We're building Meridian to answer a question every Shopify business should be able to answer:",
        ].map((line) => paragraphs([line])),
        `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#171717;border:1px solid #303030;border-radius:18px;margin:4px 0 22px;"><tr><td style="border-left:2px solid #f5f5f5;padding:19px 20px;"><p style="color:#f5f5f5;font-family:${EMAIL_FONT};font-size:20px;font-weight:600;letter-spacing:-0.5px;line-height:1.38;margin:0;">You know what you sold. But how much did you actually keep?</p></td></tr></table>`,
        paragraphs([
          "Meridian brings together your orders, product costs, shipping, fulfillment, payment fees, advertising and overhead to show where your money actually goes, then helps surface the orders, products, channels and operational problems that deserve attention.",
          "We're getting ready for launch now.",
          "You'll be among the first to know when early access opens.",
        ]),
        `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#171717;border:1px solid #303030;border-radius:18px;margin:8px 0 13px;"><tr><td style="padding:20px 21px;"><p style="color:#8c8c8c;font-family:${EMAIL_FONT};font-size:11px;font-weight:600;letter-spacing:1.55px;line-height:15px;margin:0 0 8px;text-transform:uppercase;">Your Founding Merchant benefit</p><p style="color:#f5f5f5;font-family:${EMAIL_FONT};font-size:16px;font-weight:600;line-height:1.5;margin:0;">15% off your first 12 months on a monthly Meridian plan.</p><p style="color:#a7a7a7;font-family:${EMAIL_FONT};font-size:13px;font-weight:400;line-height:1.6;margin:8px 0 0;">Eligibility is held securely on our side and activated at launch. It is not automatically combined with annual pricing.</p></td></tr></table>`,
      ].join(""),
      env,
    }),
  };
}

export function renderAuthenticationCode(input: {
  code: string;
  env?: NodeJS.ProcessEnv;
}): RenderedEmail {
  const code = escapeHtml(input.code);
  const subject = "Your MyMeridian authentication code";
  const text = `Your MyMeridian authentication code is ${input.code}. It expires in 10 minutes. If you did not request it, sign out of other sessions and reset your password.`;

  return {
    subject,
    text,
    html: emailShell({
      eyebrow: "Account security",
      title: "Your Authentication Code",
      preheader: "Use this code to continue securely.",
      bodyHtml: [
        paragraphs(["Use this one-time code to continue securely."]),
        `<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#171717;border:1px solid #303030;border-radius:18px;margin:4px 0 22px;"><tr><td style="border-left:2px solid #f5f5f5;padding:19px 20px;"><p style="color:#8c8c8c;font-family:${EMAIL_FONT};font-size:11px;font-weight:600;letter-spacing:1.55px;line-height:15px;margin:0 0 8px;text-transform:uppercase;">Your one-time code</p><p style="color:#f5f5f5;font-family:${EMAIL_FONT};font-size:30px;font-weight:700;letter-spacing:7px;line-height:1.2;margin:0;">${code}</p></td></tr></table>`,
        paragraphs([
          "It expires in 10 minutes. If you did not request it, sign out of other sessions and reset your password.",
        ]),
      ].join(""),
      env: input.env,
    }),
  };
}

export function renderProductLaunchAnnouncement(input: {
  previewUrl: string;
  env?: NodeJS.ProcessEnv;
}): RenderedEmail {
  const subject = "MyMeridian early access is open";
  return {
    subject,
    text: [
      "MyMeridian early access is open.",
      "",
      "You joined early. You can now connect your Shopify store and see what your business actually keeps.",
      "",
      `Open MyMeridian: ${input.previewUrl}`,
      "",
      "Your Founding Merchant eligibility is checked securely when you choose an eligible monthly plan.",
    ].join("\n"),
    html: emailShell({
      eyebrow: "Early access",
      title: "Meridian Is Ready When You Are.",
      preheader: "Early access is now open.",
      bodyHtml: paragraphs([
        "You joined early. You can now connect your Shopify store and see what your business actually keeps.",
        "Your Founding Merchant eligibility is checked securely when you choose an eligible monthly plan.",
      ]),
      cta: { label: "Open MyMeridian", href: input.previewUrl },
      env: input.env,
    }),
  };
}

export function renderWeeklyEeveeSummary(input: {
  shopName: string;
  periodLabel: string;
  rows: Array<{ label: string; value: string; detail?: string }>;
  dashboardUrl: string;
  env?: NodeJS.ProcessEnv;
}): RenderedEmail {
  const textRows = input.rows.map(
    (row) =>
      `${row.label}: ${row.value}${row.detail ? ` (${row.detail})` : ""}`,
  );
  const table = input.rows
    .map(
      (row) =>
        `<tr><td style="border-bottom:1px solid #303030;color:#bcbcbc;font-family:${EMAIL_FONT};font-size:14px;line-height:20px;padding:11px 0;">${escapeHtml(row.label)}</td><td align="right" style="border-bottom:1px solid #303030;color:#f5f5f5;font-family:${EMAIL_FONT};font-size:14px;font-weight:700;line-height:20px;padding:11px 0 11px 16px;">${escapeHtml(row.value)}${row.detail ? `<span style="color:#9a9a9a;font-size:12px;font-weight:400;"> ${escapeHtml(row.detail)}</span>` : ""}</td></tr>`,
    )
    .join("");
  return {
    subject: `${input.shopName}: weekly Meridian summary`,
    text: [
      `${input.shopName} — weekly Meridian summary`,
      input.periodLabel,
      "",
      ...textRows,
      "",
      `Open MyMeridian: ${input.dashboardUrl}`,
    ].join("\n"),
    html: emailShell({
      eyebrow: "E.E.V.E.E. summary",
      title: `${input.shopName}, This Week In Meridian.`,
      preheader: `${input.periodLabel} business summary.`,
      bodyHtml: `<p style="margin:0 0 16px;color:#b8b8b8;font-family:${EMAIL_FONT};font-size:16px;line-height:1.7;">${escapeHtml(input.periodLabel)}</p><table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">${table}</table>`,
      cta: { label: "Open MyMeridian", href: input.dashboardUrl },
      env: input.env,
    }),
  };
}

export function renderSecurityAccountNotification(input: {
  title: string;
  detail: string;
  accountUrl: string;
  env?: NodeJS.ProcessEnv;
}): RenderedEmail {
  return {
    subject: `MyMeridian security: ${input.title}`,
    text: [
      `MyMeridian security notice: ${input.title}`,
      "",
      input.detail,
      "",
      `Review your account: ${input.accountUrl}`,
      "",
      "If this was not you, change your password and contact support.",
    ].join("\n"),
    html: emailShell({
      eyebrow: "Account security",
      title: input.title,
      preheader: "A MyMeridian account-security notice.",
      bodyHtml: paragraphs([
        input.detail,
        "If this was not you, change your password and contact support.",
      ]),
      cta: { label: "Review Account Security", href: input.accountUrl },
      env: input.env,
    }),
  };
}

export function renderNewsletterProductUpdate(input: {
  title: string;
  summary: string;
  articleUrl: string;
  unsubscribeUrl: string;
  env?: NodeJS.ProcessEnv;
}): RenderedEmail {
  const unsubscribe = emailHref(input.unsubscribeUrl);
  return {
    subject: `MyMeridian update: ${input.title}`,
    text: [
      `MyMeridian update: ${input.title}`,
      "",
      input.summary,
      "",
      `Read more: ${input.articleUrl}`,
      "",
      `Unsubscribe from product updates: ${input.unsubscribeUrl}`,
    ].join("\n"),
    html: emailShell({
      eyebrow: "MyMeridian update",
      title: input.title,
      preheader: input.summary,
      bodyHtml: paragraphs([input.summary]),
      cta: { label: "Read The Update", href: input.articleUrl },
      footerHtml: `<p style="margin:0;color:#8b8b8b;font-family:${EMAIL_FONT};font-size:12px;line-height:1.6;">You are receiving this because you opted in to MyMeridian product updates.<br /><a href="${unsubscribe}" style="color:#f5f5f5;text-decoration:underline;">Unsubscribe</a> from marketing updates. Transactional account and service notices may still be sent when needed.</p>`,
      env: input.env,
    }),
  };
}

export function renderHumanEmailSignature(input: {
  address: "welcome@mymeridian.io" | "support@mymeridian.io";
  env?: NodeJS.ProcessEnv;
}): string {
  const logo = `${publicOrigin(input.env)}/assets/mymeridian-email-logo.png`;
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse;font-family:Arial,Helvetica,sans-serif;"><tr><td style="padding:0 0 12px;"><img src="${escapeHtml(logo)}" width="174" height="47" alt="MyMeridian" style="border:0;display:block;height:auto;max-width:174px;" /></td></tr><tr><td style="border-left:2px solid #b68a33;color:#383838;font-size:13px;line-height:1.55;padding:0 0 0 11px;"><strong style="color:#111111;font-size:14px;">MyMeridian</strong><br /><a href="mailto:${escapeHtml(input.address)}" style="color:#383838;text-decoration:none;">${escapeHtml(input.address)}</a><br /><span style="color:#666666;">Know What You Kept. Know What To Fix.</span><br /><a href="https://mymeridian.io" style="color:#666666;text-decoration:none;">mymeridian.io</a></td></tr></table>`;
}
