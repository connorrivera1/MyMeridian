const SHOPIFY_REAUTHORIZE_URL_HEADER =
  "x-shopify-api-request-failure-reauthorize-url";

export type ShopifyBillingSubmission =
  | { kind: "redirect"; url: string }
  | { kind: "error"; message: string }
  | { kind: "not-embedded" };

export interface ShopifyBillingRequest {
  url: string;
  body: FormData;
  idToken: () => Promise<string>;
  fetchImpl?: typeof fetch;
}

interface ShopifyAppBridge {
  idToken?: () => Promise<string>;
}

declare global {
  interface Window {
    shopify?: ShopifyAppBridge;
  }
}

function isShopifyConfirmationUrl(value: string | null): value is string {
  if (!value) return false;

  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.hostname === "admin.shopify.com" ||
        url.hostname.endsWith(".myshopify.com"))
    );
  } catch {
    return false;
  }
}

async function messageFrom(response: Response): Promise<string> {
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const payload: unknown = await response.json();
      if (
        typeof payload === "object" &&
        payload !== null &&
        "error" in payload &&
        typeof payload.error === "string"
      ) {
        return payload.error;
      }
    } catch {
      // A generic message below avoids putting an unexpected server response
      // into the merchant-facing UI.
    }
  }

  return "Could not open Shopify's billing confirmation. No charge was created; try again shortly.";
}

/**
 * Billing confirmation must be an authenticated App Bridge request. React
 * Router document forms cannot attach the short-lived Shopify bearer token,
 * which leaves an embedded merchant with only the read-only bridge fallback.
 * The Billing API deliberately responds with Shopify's reauthorization header
 * so the browser can leave the iframe for Shopify's own confirmation screen.
 */
export async function requestShopifyBillingConfirmation({
  url,
  body,
  idToken,
  fetchImpl = fetch,
}: ShopifyBillingRequest): Promise<Exclude<ShopifyBillingSubmission, { kind: "not-embedded" }>> {
  let token: string;
  try {
    token = await idToken();
  } catch {
    return {
      kind: "error",
      message: "Could not confirm your Shopify session. Refresh the app and try again.",
    };
  }

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "POST",
      body,
      headers: { Authorization: `Bearer ${token}` },
      credentials: "same-origin",
      redirect: "manual",
    });
  } catch {
    return {
      kind: "error",
      message: "Could not reach MyMeridian. No charge was created; try again shortly.",
    };
  }

  const confirmationUrl = response.headers.get(
    SHOPIFY_REAUTHORIZE_URL_HEADER,
  );
  if (response.status === 401 && isShopifyConfirmationUrl(confirmationUrl)) {
    return { kind: "redirect", url: confirmationUrl };
  }

  return { kind: "error", message: await messageFrom(response) };
}

export async function submitShopifyBillingForm(
  form: HTMLFormElement,
): Promise<ShopifyBillingSubmission> {
  const idToken = window.shopify?.idToken;
  if (!idToken) return { kind: "not-embedded" };

  return requestShopifyBillingConfirmation({
    url: form.action,
    body: new FormData(form),
    idToken,
  });
}

export function navigateToShopifyBillingConfirmation(url: string): void {
  // A click is the user activation Shopify requires for an iframe to navigate
  // its top-level admin. The URL was constrained before reaching this point.
  if (window.top && window.top !== window) {
    window.top.location.href = url;
  } else {
    window.location.assign(url);
  }
}
