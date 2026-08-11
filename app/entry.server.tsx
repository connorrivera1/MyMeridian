import { PassThrough } from "node:stream";

import { createReadableStreamFromReadable } from "@react-router/node";
import { isbot } from "isbot";
import { renderToPipeableStream } from "react-dom/server";
import { ServerRouter, type EntryContext } from "react-router";

import { addDocumentResponseHeaders } from "./shopify.server";
import { validateCustomerErasureConfiguration } from "./lib/customer-erasure.server";
import { startDataRetentionScheduler } from "./lib/data-retention.server";
import { registerRecalcHandlers } from "./lib/recalc-handlers.server";
import { startRecalcWorker } from "./lib/recalc-queue.server";
import { startWebhookDeliveryWorker } from "./lib/webhooks.server";
import { startIntegrationScheduler } from "./integrations/scheduler.server";

// This module is loaded with the server process, not when a merchant opens
// Settings. Retention therefore advances even when the app receives no page
// traffic; Fly keeps at least one machine running for background work.
// Validate first: accepting a redaction delivery while its stable guard key is
// missing would defer a deterministic configuration failure into the retry
// queue and let an otherwise-broken deploy pass its health checks.
validateCustomerErasureConfiguration();
startDataRetentionScheduler();
startWebhookDeliveryWorker();
startIntegrationScheduler();
// Handlers first: a worker that starts before its registry is populated would
// lease a queued restatement and immediately fail it as unhandled.
registerRecalcHandlers();
startRecalcWorker();

const ABORT_DELAY = 5000;

/**
 * Transport and content-sniffing hardening.
 *
 * Deliberately narrow. Three headers that cannot interact with the embedded
 * iframe, and nothing else:
 *
 *  - `X-Frame-Options` is NOT set. It would forbid framing outright and break
 *    the admin embed; Shopify's own `frame-ancestors` directive, applied by
 *    `addDocumentResponseHeaders` just above, is the correct control and is
 *    strictly more expressive.
 *  - `Content-Security-Policy` is NOT touched here for the same reason —
 *    Shopify owns that header, and overwriting it drops frame-ancestors.
 *  - HSTS carries neither `preload` nor `includeSubDomains`: the app is served
 *    from one host behind Fly's edge (`force_https` in fly.toml), and claiming
 *    subdomains this deployment does not control would be a promise the
 *    operator cannot keep.
 */
function addSecurityHeaders(headers: Headers) {
  headers.set("Strict-Transport-Security", "max-age=31536000");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
}

export default function handleRequest(
  request: Request,
  responseStatusCode: number,
  responseHeaders: Headers,
  routerContext: EntryContext,
) {
  // Shopify requires the embedded app to send frame-ancestors headers naming
  // the merchant's admin, otherwise the iframe is blocked.
  addDocumentResponseHeaders(request, responseHeaders);
  addSecurityHeaders(responseHeaders);

  const userAgent = request.headers.get("user-agent");
  const waitForAll = userAgent && isbot(userAgent);

  return new Promise((resolve, reject) => {
    let didError = false;

    const { pipe, abort } = renderToPipeableStream(
      <ServerRouter context={routerContext} url={request.url} />,
      {
        [waitForAll ? "onAllReady" : "onShellReady"]() {
          const body = new PassThrough();
          responseHeaders.set("Content-Type", "text/html");

          resolve(
            new Response(createReadableStreamFromReadable(body), {
              headers: responseHeaders,
              status: didError ? 500 : responseStatusCode,
            }),
          );

          pipe(body);
        },
        onShellError(error: unknown) {
          reject(error);
        },
        onError(error: unknown) {
          didError = true;
          console.error(error);
        },
      },
    );

    setTimeout(abort, ABORT_DELAY);
  });
}
