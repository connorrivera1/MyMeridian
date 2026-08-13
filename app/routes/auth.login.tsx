import { data, Form, useActionData, useLoaderData } from "react-router";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { LoginErrorType } from "@shopify/shopify-app-react-router/server";

import { BrandMark } from "~/design/components";
import { demoAvailable } from "~/lib/auth.server";
import { hasShopifyCredentials, login } from "~/shopify.server";
import {
  firstDeniedRequestLimit,
  RATE_LIMIT_MESSAGE,
  rateLimitHeaders,
} from "~/lib/rate-limit.server";

/**
 * Shop-domain entry point.
 *
 * Reached when someone opens the app without Shopify telling us which store
 * they are. Normally the merchant arrives from the admin with `?shop=` already
 * set and never sees this.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  if (!hasShopifyCredentials || !login) {
    return { errors: {}, configured: false, demoAvailable };
  }

  const errors = await login(request);
  return { errors: errorMessages(errors), configured: true, demoAvailable };
}

export async function action({ request }: ActionFunctionArgs) {
  if (!hasShopifyCredentials || !login) {
    return { errors: { shop: "Shopify credentials are not configured." } };
  }

  const limited = await firstDeniedRequestLimit({
    request,
    scope: "shopify-auth-start",
    windowMs: 15 * 60 * 1_000,
    ipLimit: 30,
  });
  if (limited) {
    return data(
      { errors: { shop: RATE_LIMIT_MESSAGE } },
      { status: 429, headers: rateLimitHeaders(limited) },
    );
  }

  const errors = await login(request);
  return { errors: errorMessages(errors) };
}

function errorMessages(errors: unknown): { shop?: string } {
  const shopError = (errors as { shop?: LoginErrorType } | undefined)?.shop;
  if (!shopError) return {};

  return {
    shop:
      shopError === LoginErrorType.MissingShop
        ? "Enter your store's myshopify.com domain."
        : "That doesn't look like a valid myshopify.com domain.",
  };
}

export default function Login() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const errors = result?.errors ?? data.errors;

  return (
    <main className="auth-hero">
      <div className="auth-panel">
        <div style={{ display: "flex", justifyContent: "center" }}>
          <BrandMark size={116} orbit />
        </div>

        <h1 className="auth-word">Meridian</h1>
        <p className="auth-tag">
          Revenue, COGS, fulfilment, fees and overhead —<br />
          qualified profit from the inputs available.
        </p>

        {data.configured ? (
          <Form
            method="post"
            className="stack"
            style={{ gap: 10, textAlign: "left" }}
          >
            <label className="stack" style={{ gap: 5 }}>
              <span className="tiny muted">Store Domain</span>
              <input
                className="field-input"
                type="text"
                name="shop"
                placeholder="my-store.myshopify.com"
                autoComplete="off"
                style={{ width: "100%" }}
              />
              {errors.shop && (
                <span
                  className="tiny"
                  style={{ color: "var(--status-critical)" }}
                >
                  {errors.shop}
                </span>
              )}
            </label>
            <button
              className="btn primary"
              type="submit"
              style={{ justifyContent: "center" }}
            >
              Continue To Shopify
            </button>
          </Form>
        ) : (
          <div className="banner warn" style={{ textAlign: "left" }}>
            <div>
              The server-side Shopify connection is not configured. Finish the
              private environment setup, then restart MyMeridian.
            </div>
          </div>
        )}

        {data.demoAvailable && (
          <p className="tiny muted" style={{ marginTop: 24, lineHeight: 1.6 }}>
            Or{" "}
            <a href="/app" style={{ color: "var(--accent)", fontWeight: 600 }}>
              Explore The Demo Store
            </a>{" "}
            — six months of generated orders, computed by the same engine.
          </p>
        )}
      </div>
    </main>
  );
}
