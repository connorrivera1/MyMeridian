import { redirect, type LoaderFunctionArgs } from "react-router";

import { BrandMark } from "~/design/components";
import { demoAvailable } from "~/lib/auth.server";
import { hasShopifyCredentials } from "~/shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);

  // Shopify always opens the app with ?shop=…; hand straight to OAuth.
  if (hasShopifyCredentials && url.searchParams.get("shop")) {
    throw redirect(`/auth/login?${url.searchParams.toString()}`);
  }

  // With credentials present, installing on a real store is the main path.
  if (hasShopifyCredentials) throw redirect("/auth/login");

  if (demoAvailable) throw redirect("/app");

  return { configured: hasShopifyCredentials };
}

export default function Home() {
  return (
    <main className="auth-hero">
      <div className="auth-panel">
        <div style={{ display: "flex", justifyContent: "center" }}>
          <BrandMark size={116} orbit />
        </div>
        <h1 className="auth-word">Meridian</h1>
        <p className="auth-tag">
          True profit for Shopify stores — revenue, ad spend, fulfilment and
          overhead in one number you can act on.
        </p>
        <div className="banner" style={{ textAlign: "left" }}>
          <div>
            Install Meridian from the Shopify App Store, or open it from your
            store&rsquo;s admin. To explore it locally with seeded data, run{" "}
            <code>npm run db:seed</code> with <code>MERIDIAN_DEMO_MODE=true</code>.
          </div>
        </div>
      </div>
    </main>
  );
}
