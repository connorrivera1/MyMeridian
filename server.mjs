import compression from "compression";
import express from "express";
import morgan from "morgan";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { createRequestHandler } from "@react-router/express";
import * as build from "./build/server/index.js";

const port = Number(process.env.PORT ?? 8080);
const app = express();

app.disable("x-powered-by");
// Fly terminates TLS before forwarding a request to this process. Trusting that
// proxy is required for React Router's request adapter to retain the original
// HTTPS origin used by Shopify's embedded admin requests.
app.set("trust proxy", true);
app.use(compression());

/**
 * React Router attaches these headers to rendered responses, but files served
 * directly from the client build bypass that renderer. In particular the
 * hand-authored legal documents retain their card layout as static HTML, so
 * their transport and content-sniffing protections belong at this layer.
 */
function addBaselineSecurityHeaders(response) {
  if (!response.hasHeader("Strict-Transport-Security")) {
    response.setHeader("Strict-Transport-Security", "max-age=31536000");
  }
  if (!response.hasHeader("X-Content-Type-Options")) {
    response.setHeader("X-Content-Type-Options", "nosniff");
  }
  if (!response.hasHeader("Referrer-Policy")) {
    response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  }
}

const staticDocumentHashes = new Map();

function inlineScriptHashes(html) {
  return Array.from(
    html.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gi),
    (match) => match[1],
  )
    .filter((script) => script.trim().length > 0)
    .map(
      (script) =>
        `'sha256-${createHash("sha256").update(script, "utf8").digest("base64")}'`,
    );
}

function staticDocumentScriptHashes(filePath) {
  const cached = staticDocumentHashes.get(filePath);
  if (cached) return cached;

  const hashes = inlineScriptHashes(readFileSync(filePath, "utf8"));
  staticDocumentHashes.set(filePath, hashes);
  return hashes;
}

function addPublicDocumentSecurityHeaders(response, filePath) {
  addBaselineSecurityHeaders(response);
  const scriptSources = [
    "'self'",
    ...staticDocumentScriptHashes(filePath),
  ].join(" ");
  response.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "form-action 'self'",
      "frame-ancestors 'none'",
      "frame-src 'none'",
      "img-src 'self' data:",
      "font-src 'self' data: https://cdn.fontshare.com",
      "style-src 'self' 'unsafe-inline' https://api.fontshare.com",
      `script-src ${scriptSources}`,
      "connect-src 'self'",
      "media-src 'self'",
      "upgrade-insecure-requests",
    ].join("; "),
  );
}

function addStaticSecurityHeaders(response, filePath) {
  if (filePath.endsWith(".html")) {
    addPublicDocumentSecurityHeaders(response, filePath);
    return;
  }
  addBaselineSecurityHeaders(response);
}

// React Router returns redirect and error responses directly, without a
// document render pass. Apply the transport baseline immediately before the
// response is sent so route-specific policies can replace the defaults rather
// than being appended as duplicate header values.
app.use((_request, response, next) => {
  const writeHead = response.writeHead.bind(response);
  response.writeHead = function writeHeadWithBaseline(...args) {
    addBaselineSecurityHeaders(response);
    return writeHead(...args);
  };
  next();
});

app.use(
  build.publicPath + "assets",
  express.static(build.assetsBuildDirectory + "/assets", {
    immutable: true,
    maxAge: "1y",
    setHeaders: addBaselineSecurityHeaders,
  }),
);
app.use(
  express.static(build.assetsBuildDirectory, {
    setHeaders: addStaticSecurityHeaders,
  }),
);
app.use(
  express.static("public", {
    maxAge: "1h",
    setHeaders: addStaticSecurityHeaders,
  }),
);

/**
 * Shopify embeds its signed session and ID token in the initial query string.
 * The stock `react-router-serve` logger records the complete URL, which would
 * put those bearer credentials into provider logs. Keep request observability
 * without retaining any query values.
 */
function safeRequestPath(rawUrl) {
  try {
    return new URL(rawUrl, "http://request.local").pathname;
  } catch {
    return "/invalid-request-path";
  }
}

app.use(
  morgan((tokens, request, response) => {
    const method = tokens.method(request, response) ?? "-";
    const status = tokens.status(request, response) ?? "-";
    const length = tokens.res(request, response, "content-length") ?? "-";
    const duration = tokens["response-time"](request, response) ?? "-";
    return `${method} ${safeRequestPath(request.originalUrl)} ${status} ${length} ${duration} ms`;
  }),
);

app.all(
  "*",
  createRequestHandler({ build, mode: process.env.NODE_ENV }),
);

app.listen(port, "0.0.0.0", () => {
  console.log(`[mymeridian] listening on 0.0.0.0:${port}`);
});
