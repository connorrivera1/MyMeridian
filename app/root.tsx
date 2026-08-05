import { Links, Meta, Outlet, Scripts, ScrollRestoration } from "react-router";

import "@fontsource-variable/inter";
import styles from "./design/meridian.css?url";

export const links = () => [
  { rel: "stylesheet", href: styles },
  { rel: "icon", href: "/favicon.svg", type: "image/svg+xml" },
  { rel: "preconnect", href: "https://cdn.shopify.com" },
];

export const meta = () => [
  { title: "Meridian — true profit for your store" },
  { name: "viewport", content: "width=device-width, initial-scale=1" },
  // Media-scoped so the browser chrome follows the sky. The toggle also
  // rewrites these at runtime, since data-theme can override the OS setting.
  { name: "theme-color", content: "#06080b", media: "(prefers-color-scheme: dark)" },
  { name: "theme-color", content: "#f6f8fa", media: "(prefers-color-scheme: light)" },
];

/**
 * Applied before first paint so a merchant who chose light mode never sees a
 * dark flash on navigation. Small enough to inline; it only reads one key.
 */
const THEME_BOOTSTRAP = `(function(){try{var t=localStorage.getItem("meridian-theme");if(t==="light"||t==="dark"){document.documentElement.dataset.theme=t;var m=document.querySelectorAll('meta[name="theme-color"]');for(var i=0;i<m.length;i++){m[i].setAttribute("content",t==="light"?"#f6f8fa":"#06080b");m[i].removeAttribute("media")}}}catch(e){}})();`;

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark">
      <head>
        <meta charSet="utf-8" />
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
  const message =
    error instanceof Error ? error.message : "Something went wrong.";

  const status =
    typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: number }).status
      : undefined;

  const detail =
    typeof error === "object" && error !== null && "data" in error
      ? String((error as { data?: unknown }).data ?? "")
      : "";

  return (
    <main style={{ padding: 48, maxWidth: 640, margin: "0 auto" }}>
      <h1 className="auth-word" style={{ fontSize: 22, marginTop: 0, marginBottom: 8 }}>
        {status ? `${status} — ` : ""}Meridian hit a problem
      </h1>
      <p className="secondary" style={{ lineHeight: 1.6 }}>
        {detail || message}
      </p>
      <p style={{ marginTop: 20 }}>
        <a className="btn" href="/app">
          Back to the dashboard
        </a>
      </p>
    </main>
  );
}
