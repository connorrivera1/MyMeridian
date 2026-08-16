import { randomUUID } from "node:crypto";

import prisma from "../app/db.server.js";
import { generateTotp } from "../app/lib/operator-totp.js";

const origin = new URL(
  process.env.MERIDIAN_OPERATOR_ACCEPTANCE_ORIGIN ??
    "http://127.0.0.1:3130",
);
const allowRemote =
  process.env.MERIDIAN_OPERATOR_ACCEPTANCE_ALLOW_REMOTE === "true";
const forwardedProto =
  process.env.MERIDIAN_OPERATOR_ACCEPTANCE_FORWARDED_PROTO?.trim();
if (forwardedProto && !["http", "https"].includes(forwardedProto)) {
  throw new Error(
    "MERIDIAN_OPERATOR_ACCEPTANCE_FORWARDED_PROTO must be http or https.",
  );
}

if (
  !["127.0.0.1", "localhost", "::1"].includes(origin.hostname) &&
  !allowRemote
) {
  throw new Error(
    "Refusing to exercise operator authentication on a remote host without MERIDIAN_OPERATOR_ACCEPTANCE_ALLOW_REMOTE=true.",
  );
}

const email = required("MERIDIAN_OPERATOR_EMAIL");
const password = required("MERIDIAN_OPERATOR_ACCEPTANCE_PASSWORD");
const totpSecret = required("MERIDIAN_OPERATOR_TOTP_SECRET");
required("MERIDIAN_OPERATOR_SESSION_KEY");

const userAgent = `MyMeridian operator acceptance/${randomUUID()}`;
const startedAt = new Date();
const requestHeaders = {
  "user-agent": userAgent,
  ...(forwardedProto ? { "x-forwarded-proto": forwardedProto } : {}),
};

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

async function responseText(path: string, init: RequestInit = {}) {
  const response = await fetch(new URL(path, origin), {
    redirect: "manual",
    ...init,
    headers: {
      ...requestHeaders,
      ...init.headers,
    },
  });
  return { response, html: await response.text() };
}

function expectStatus(response: Response, status: number, context: string) {
  if (response.status !== status) {
    throw new Error(`${context} returned ${response.status}; expected ${status}.`);
  }
}

function expectSecurityHeaders(response: Response) {
  const expected = new Map([
    ["cache-control", "no-store"],
    ["content-security-policy", "frame-ancestors 'none'"],
    ["permissions-policy", "payment=()"],
    ["referrer-policy", "no-referrer"],
    ["x-content-type-options", "nosniff"],
    ["x-frame-options", "DENY"],
    ["x-robots-tag", "noindex"],
  ]);
  for (const [name, value] of expected) {
    if (!(response.headers.get(name) ?? "").includes(value)) {
      throw new Error(`Operator response is missing ${name}: ${value}.`);
    }
  }
}

try {
  const loginPage = await responseText("/operator/login");
  expectStatus(loginPage.response, 200, "Operator login page");
  expectSecurityHeaders(loginPage.response);
  if (
    !loginPage.html.includes('name="password"') ||
    !loginPage.html.includes('name="totp"')
  ) {
    throw new Error("Configured operator login did not require password and TOTP.");
  }

  const code = generateTotp({ secret: totpSecret });
  const form = new URLSearchParams({ email, password, totp: code });
  const login = await responseText("/operator/login", {
    method: "POST",
    headers: {
      origin: origin.origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  expectStatus(login.response, 302, "Operator login");
  if (login.response.headers.get("location") !== "/operator") {
    throw new Error("Operator login did not redirect to the control plane.");
  }
  const setCookie = login.response.headers.get("set-cookie") ?? "";
  const cookie = setCookie.split(";", 1)[0] ?? "";
  const expectedCookieName =
    forwardedProto === "https"
      ? "__Host-mymeridian_operator_session="
      : "mymeridian_operator_session=";
  if (
    !cookie.startsWith(expectedCookieName) ||
    !/HttpOnly/i.test(setCookie) ||
    !/SameSite=Strict/i.test(setCookie) ||
    (forwardedProto === "https" && !/;\s*Secure(?:;|$)/i.test(setCookie))
  ) {
    throw new Error("Operator session cookie controls are incomplete.");
  }

  const overview = await responseText("/operator", {
    headers: { cookie },
  });
  expectStatus(overview.response, 200, "Operator overview");
  expectSecurityHeaders(overview.response);
  if (
    !overview.html.includes("Business and system health") ||
    !overview.html.includes("Active paying stores") ||
    !overview.html.includes("Recent operational alerts")
  ) {
    throw new Error("Operator overview did not render required aggregate metrics.");
  }
  if (/app-bridge|shopify-app-init/i.test(overview.html)) {
    throw new Error("Operator control plane loaded merchant Shopify runtime code.");
  }

  const storePath = overview.html.match(
    /href="(\/operator\/stores\/[^"?]+)"/,
  )?.[1];
  if (!storePath) throw new Error("Operator store-support link is missing.");
  const store = await responseText(storePath, { headers: { cookie } });
  expectStatus(store.response, 200, "Operator store support");
  expectSecurityHeaders(store.response);
  if (
    !store.html.includes("Data completeness") ||
    !store.html.includes("Granted Shopify scopes") ||
    !store.html.includes("This view is read-only")
  ) {
    throw new Error("Operator store support did not render its safe status view.");
  }
  if (/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/.test(store.html)) {
    throw new Error("Operator store support rendered an email address.");
  }

  const replay = await responseText("/operator/login", {
    method: "POST",
    headers: {
      origin: origin.origin,
      "content-type": "application/x-www-form-urlencoded",
    },
    body: form,
  });
  expectStatus(replay.response, 401, "TOTP replay");

  const merchantCookieOnly = await responseText("/operator", {
    headers: { cookie: "mymeridian_web_session=fake-merchant-session" },
  });
  expectStatus(merchantCookieOnly.response, 302, "Merchant-cookie isolation");
  if (merchantCookieOnly.response.headers.get("location") !== "/operator/login") {
    throw new Error("A merchant cookie crossed the operator boundary.");
  }

  const logout = await responseText("/operator/logout", {
    method: "POST",
    headers: { origin: origin.origin, cookie },
  });
  expectStatus(logout.response, 302, "Operator logout");
  if (logout.response.headers.get("location") !== "/operator/login") {
    throw new Error("Operator logout did not return to the dedicated login.");
  }
  const afterLogout = await responseText("/operator", {
    headers: { cookie },
  });
  expectStatus(afterLogout.response, 302, "Revoked operator session");

  const events = await prisma.operatorAuditEvent.findMany({
    where: { occurredAt: { gte: startedAt } },
    select: {
      action: true,
      outcome: true,
      actorHash: true,
      ipHash: true,
      userAgentHash: true,
    },
  });
  const requiredEvents = [
    ["OPERATOR_LOGIN", "success"],
    ["OPERATOR_METRICS_VIEW", "success"],
    ["OPERATOR_STORE_VIEW", "success"],
    ["OPERATOR_LOGIN", "denied"],
    ["OPERATOR_LOGOUT", "success"],
  ];
  for (const [action, outcome] of requiredEvents) {
    if (
      !events.some(
        (event) => event.action === action && event.outcome === outcome,
      )
    ) {
      throw new Error(`Missing operator audit event ${action}/${outcome}.`);
    }
  }
  if (
    events.some(
      (event) =>
        !/^[a-f0-9]{64}$/.test(event.actorHash) ||
        !/^[a-f0-9]{64}$/.test(event.ipHash) ||
        !/^[a-f0-9]{64}$/.test(event.userAgentHash),
    )
  ) {
    throw new Error("Operator audit identities were not stored as keyed hashes.");
  }

  console.log("operator_live_acceptance=passed");
  console.log(`audit_events_observed=${events.length}`);
  console.log("password_totp=required");
  console.log("totp_replay=rejected");
  console.log("merchant_cookie=isolated");
  console.log("session_logout=revoked");
  console.log("privileged_reads=audited");
  console.log("customer_email=not_rendered");
} finally {
  await prisma.$disconnect();
}
