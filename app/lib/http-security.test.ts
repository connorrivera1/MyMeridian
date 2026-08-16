import { expect, it } from "vitest";

import {
  addPublicDocumentSecurityHeaders,
  addSecurityHeaders,
  redirectWithSecurityHeaders,
} from "./http-security";

it("adds transport and browser-safety headers without weakening stricter routes", () => {
  const defaults = new Headers();
  addSecurityHeaders(defaults);

  expect(defaults.get("strict-transport-security")).toBe("max-age=31536000");
  expect(defaults.get("x-content-type-options")).toBe("nosniff");
  expect(defaults.get("referrer-policy")).toBe(
    "strict-origin-when-cross-origin",
  );

  const stricter = new Headers({ "referrer-policy": "no-referrer" });
  addSecurityHeaders(stricter);
  expect(stricter.get("referrer-policy")).toBe("no-referrer");
});

it("allows only the public document's hashed inline scripts", () => {
  const headers = new Headers();
  addPublicDocumentSecurityHeaders(headers, ["'sha256-example='"]);

  expect(headers.get("content-security-policy")).toBe(
    "default-src 'self'; base-uri 'self'; object-src 'none'; form-action 'self'; frame-ancestors 'none'; frame-src 'none'; img-src 'self' data:; font-src 'self' data: https://cdn.fontshare.com; style-src 'self' 'unsafe-inline' https://api.fontshare.com; script-src 'self' 'sha256-example='; connect-src 'self'; media-src 'self'; upgrade-insecure-requests",
  );
});

it("keeps security headers on redirect responses that bypass document rendering", () => {
  const response = redirectWithSecurityHeaders("/login", {
    headers: { "set-cookie": "pending=1; HttpOnly" },
  });

  expect(response.status).toBe(302);
  expect(response.headers.get("location")).toBe("/login");
  expect(response.headers.get("set-cookie")).toBe("pending=1; HttpOnly");
  expect(response.headers.get("strict-transport-security")).toBe(
    "max-age=31536000",
  );
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe(
    "strict-origin-when-cross-origin",
  );
});
