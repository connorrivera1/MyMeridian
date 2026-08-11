import { redirect, type LoaderFunctionArgs } from "react-router";

import { BrandMark } from "~/design/components";
import { demoAvailable } from "~/lib/auth.server";
import { hasShopifyCredentials } from "~/shopify.server";

export async function loader({ request }: LoaderFunctionArgs) {
  const url = new URL(request.url);

  // Shopify opens an embedded app at application_url with ?shop=&host=… inside
  // the admin iframe. Hand it to the app, which authenticates via session token
  // and starts managed install itself when there is no session yet.
  //
  // Not /auth/login: that calls login(), which for an App Store distribution
  // throws a redirect to https://admin.shopify.com/store/<shop>/oauth/install.
  // As a navigation inside the admin's own iframe that is frame-blocked, so an
  // already-installed merchant opening the app got a blank frame.
  if (hasShopifyCredentials && url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
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
          Qualified profit for Shopify stores — revenue against recorded and
          modeled costs, with missing inputs and unavailable ad spend called
          out.
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
