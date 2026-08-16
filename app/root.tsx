import {
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
  useRouteLoaderData,
} from "react-router";
import type { LoaderFunctionArgs } from "react-router";

import styles from "./design/meridian.css?url";
import { canonicalDeploymentRedirect } from "./lib/public-origin.server";

/**
 * App Bridge has to be resolved here rather than in the embedded layout.
 * Shopify's embedded requirement is that `app-bridge.js` is the first script in
 * the document head; `AppProvider` renders it from inside `<body>`, which is
 * where it sat before. The client id is public — it is the app's `client_id`
 * from the Partner Dashboard and appears in every OAuth URL — so returning it
 * from an unauthenticated loader discloses nothing.
 */
export async function loader({ request }: LoaderFunctionArgs) {
  const canonicalRedirect = canonicalDeploymentRedirect(request);
  if (canonicalRedirect) return canonicalRedirect;

  const { shouldLoadAppBridge } = await import("./lib/auth.server");

  return {
    appBridgeApiKey: shouldLoadAppBridge(request)
      ? (process.env.SHOPIFY_API_KEY ?? "")
      : "",
  };
}

export const links = () => [
  { rel: "stylesheet", href: styles },
  {
    rel: "icon",
    href: "/favicon-globe.svg?v=20260812",
    type: "image/svg+xml",
  },
  { rel: "preconnect", href: "https://cdn.shopify.com" },
];

export const meta = () => [
  { title: "MyMeridian — Qualified Profit From Available Inputs" },
  { name: "viewport", content: "width=device-width, initial-scale=1" },
  // Media-scoped so the browser chrome follows the sky. The toggle also
  // rewrites these at runtime, since data-theme can override the OS setting.
  { name: "theme-color", content: "#161c36", media: "(prefers-color-scheme: dark)" },
  { name: "theme-color", content: "#f4efe5", media: "(prefers-color-scheme: light)" },
];

/**
 * Applied before first paint so a merchant who chose light mode never sees a
 * dark flash on navigation. Small enough to inline; it only reads one key.
 */
const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem("meridian-theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t;var m=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<m.length;i++){m[i].setAttribute("content",t==="light"?"#f4efe5":"#161c36");m[i].removeAttribute("media")}}}catch(e){}})();`;

/**
 * The api key for a document whose root loader never produced one.
 *
 * `Layout` also wraps the error boundary, and the boundary renders in cases
 * where the loader above did not run at all: a 404 on an unmatched path
 * matches no route, so nothing calls it. `useRouteLoaderData("root")` is
 * `undefined` there, and the head went out with no `app-bridge.js` in it —
 * which breaks the merchant out of the admin iframe on the one page they most
 * need App Bridge to get back from. Shopify's wording is the script tag in the
 * head of *every* document.
 *
 * Server-side the key comes from the environment, exactly as the loader gets
 * it. Client-side it is read back out of the meta tag the server just wrote,
 * so both renders produce the same markup and hydration stays quiet — and if
 * the server emitted nothing, the client finds nothing and agrees.
 */
function errorDocumentApiKey(): string {
  if (typeof document === "undefined") {
    return typeof process === "undefined"
      ? ""
      : (process.env.SHOPIFY_API_KEY ?? "");
  }

  return (
    document
      .querySelector('meta[name="shopify-api-key"]')
      ?.getAttribute("content") ?? ""
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  // `Layout` also wraps the error boundary, which renders when the loader threw
  // and there is no data at all — hence the optional read.
  const data = useRouteLoaderData<typeof loader>("root");
  // `data.appBridgeApiKey` is deliberately "" for a request that must not load
  // App Bridge — the seeded demo, and the public legal pages — so the fallback
  // is keyed on the loader having produced nothing at all, not on the key
  // being empty. An error document is the only case that reaches it.
  const appBridgeApiKey = data ? data.appBridgeApiKey : errorDocumentApiKey();

  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        {/* App Bridge, first script in the head as Shopify's embedded app
            requirements state. The meta tag must precede the script — App
            Bridge reads the client id from it at load, and without it session
            tokens are never minted and Shopify collects no Web Vitals, which
            is a silent failure rather than a visible one. */}
        {appBridgeApiKey && (
          <>
            <meta name="shopify-api-key" content={appBridgeApiKey} />
            <script
              src="https://cdn.shopify.com/shopifycloud/app-bridge.js"
            />
          </>
        )}
        <Meta />
        <Links />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP }} />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: { error: unknown }) {
  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: number }).status
      : undefined;

  return (
    <main style={{ padding: 48, maxWidth: 640, margin: "0 auto" }}>
      <h1 className="auth-word" style={{ fontSize: 22, marginTop: 0, marginBottom: 8 }}>
        {status ? `${status} — ` : ""}MyMeridian hit a problem
      </h1>
      <p className="secondary" style={{ lineHeight: 1.6 }}>
        The request could not be completed. Please try again.
      </p>
      <p style={{ marginTop: 20 }}>
        <a className="btn" href="/app">
          Back to the dashboard
        </a>
      </p>
    </main>
  );
}
