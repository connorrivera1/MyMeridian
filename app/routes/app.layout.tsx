import { useEffect } from "react";
import {
  Link,
  NavLink,
  Outlet,
  useLoaderData,
  useLocation,
  useNavigate,
  useRevalidator,
  useRouteError,
} from "react-router";
import { redirect } from "react-router";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";

import { ThemeToggle } from "~/design/charts";
import {
  BrandMark,
  IconChannels,
  IconFulfilment,
  IconOrders,
  IconOverview,
  IconPlan,
  IconPricing,
  IconProducts,
  IconSettings,
  Splash,
} from "~/design/components";
import { loadShopAnalytics, resolveRange } from "~/data/analytics.server";
import { requireShopContext } from "~/lib/auth.server";
import { planAllows, resolvePlan } from "~/lib/plan.server";
import { parseRangePreset, RANGE_PRESETS, type RangePreset } from "~/lib/ranges";
import { PLANS } from "~/lib/plans";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireShopContext(request);
  const { shop, isDemo } = ctx;

  // Resolved here rather than per route so the answer is read once per
  // navigation, and so a store with no active charge cannot reach a paid screen
  // by typing its URL.
  const plan = await resolvePlan(ctx);
  const url = new URL(request.url);

  if (!plan.planId && url.pathname !== "/app/plan") {
    throw redirect(`/app/plan${url.search}`);
  }

  const preset = parseRangePreset(new URL(request.url).searchParams.get("range"));

  // A store still importing has nothing to analyse yet; asking for analytics
  // would just be an expensive way to compute zeroes. The demo store is never
  // importing — its data is seeded, not fetched.
  const importing =
    !isDemo && (shop.syncStatus === "RUNNING" || shop.syncStatus === "PENDING");

  const alertCount = importing || !planAllows(plan, "capacity")
    ? 0
    : (
        await loadShopAnalytics(
          shop,
          resolveRange(shop, preset, { anchorToData: isDemo }),
        )
      ).capacity.alerts.filter(
        (a) => a.severity === "CRITICAL" || a.severity === "WARNING",
      ).length;

  return {
    shopName: shop.name,
    shopDomain: shop.domain,
    isDemo,
    preset,
    alertCount,
    plan: {
      id: plan.planId,
      name: plan.planId ? PLANS[plan.planId].name : null,
    },
    sync: {
      status: shop.syncStatus,
      stage: shop.syncStage,
      orders: shop.syncedOrders,
      products: shop.syncedProducts,
      error: shop.syncError,
      completedAt: shop.syncCompletedAt,
      hasAllOrdersScope: shop.hasAllOrdersScope,
      earliestOrderAt: shop.earliestOrderAt,
    },
  };
}

/**
 * Embedded apps must return Shopify's document headers, including the
 * frame-ancestors directive naming the merchant's admin. Without these the
 * iframe is blocked outright.
 */
export const headers: HeadersFunction = (args) => boundary.headers(args);

/**
 * Auth failures inside the admin iframe arrive as thrown responses that only
 * App Bridge can act on — a plain error page would strand the merchant on a
 * blank frame instead of re-running OAuth.
 */
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

const NAV = [
  { to: "/app", label: "Overview", Icon: IconOverview, end: true },
  { to: "/app/orders", label: "Profit per order", Icon: IconOrders },
  { to: "/app/products", label: "Products", Icon: IconProducts },
  { to: "/app/acquisition", label: "Acquisition", Icon: IconChannels },
  { to: "/app/pricing", label: "Pricing", Icon: IconPricing },
  { to: "/app/fulfilment", label: "Fulfilment", Icon: IconFulfilment, badge: true },
];

type SyncState = Awaited<ReturnType<typeof loader>>["sync"];

/**
 * Import progress, shown on every page rather than one.
 *
 * A merchant who has just installed lands wherever they land, and a dashboard
 * of zeroes with no explanation reads as "this app is broken" rather than
 * "this app is still reading your data".
 */
function SyncBanner({ sync, isDemo }: { sync: SyncState; isDemo: boolean }) {
  const revalidator = useRevalidator();
  const importing = sync.status === "RUNNING" || sync.status === "PENDING";

  // Poll while the import is in flight; the work happens in a background task
  // that cannot push to this page.
  useEffect(() => {
    if (isDemo || !importing) return;
    const timer = setInterval(() => {
      if (revalidator.state === "idle") revalidator.revalidate();
    }, 2500);
    return () => clearInterval(timer);
  }, [isDemo, importing, revalidator]);

  if (isDemo) return null;

  if (importing) {
    return (
      <div className="banner progress">
        <div>
          <strong style={{ color: "var(--ink-primary)" }}>
            Importing your store…
          </strong>{" "}
          {sync.stage ?? "Starting up"}. {sync.products.toLocaleString()} products
          and {sync.orders.toLocaleString()} orders so far. You can keep using the
          app — figures fill in as the import runs.
        </div>
      </div>
    );
  }

  if (sync.status === "FAILED") {
    return (
      <div className="banner warn">
        <div>
          <strong style={{ color: "var(--ink-primary)" }}>
            The import stopped early.
          </strong>{" "}
          {sync.error ?? "Unknown error."} Anything already imported is still
          shown below.{" "}
          <Link to="/app/settings" style={{ color: "var(--accent)" }}>
            Retry from settings
          </Link>
          .
        </div>
      </div>
    );
  }

  // Shopify caps order reads at 60 days without the read_all_orders scope, and
  // a store that has been trading longer would otherwise look like it launched
  // two months ago.
  if (sync.status === "COMPLETE" && !sync.hasAllOrdersScope) {
    return (
      <div className="banner">
        <div>
          Shopify limits order history to the last 60 days unless an app is
          granted the <code>read_all_orders</code> scope, so anything earlier is
          not included here. Request it from your Partner Dashboard under{" "}
          <em>App → API access</em> to analyse a longer history.
        </div>
      </div>
    );
  }

  return null;
}

export default function AppLayout() {
  const { shopName, shopDomain, isDemo, preset, alertCount, plan, sync } =
    useLoaderData<typeof loader>();
  const location = useLocation();

  // Keep whatever else the merchant has narrowed to. Rebuilding the query
  // string from scratch here silently dropped an active sort and channel
  // filter, so changing the date range on a filtered orders view threw the
  // filter away without saying so.
  const rangeLink = (next: RangePreset) => {
    const params = new URLSearchParams(location.search);
    params.set("range", next);
    return `${location.pathname}?${params.toString()}`;
  };

  const shell = (
    <div className="app-shell">
      {/* Eight nav items render before the content on every page; without this
          a keyboard user tabs the whole sidebar on each navigation. */}
      <a className="skip-link" href="#content">
        Skip to content
      </a>
      <aside className="sidebar">
        <div className="brand">
          <BrandMark />
          <div style={{ minWidth: 0 }}>
            <div className="brand-name">Meridian</div>
            <div className="brand-shop" title={shopDomain}>
              {shopName}
            </div>
          </div>
        </div>

        <nav className="nav" aria-label="Main">
          {NAV.map(({ to, label, Icon, end, badge }) => (
            <NavLink
              key={to}
              to={`${to}?range=${preset}`}
              end={end}
              className="nav-link"
            >
              <Icon />
              {label}
              {badge && alertCount > 0 && (
                <span className="nav-badge">{alertCount}</span>
              )}
            </NavLink>
          ))}

          <div className="nav-section">Configuration</div>
          <NavLink to={`/app/settings?range=${preset}`} className="nav-link">
            <IconSettings />
            Costs &amp; connections
          </NavLink>
          {/* An in-app route rather than a link out to the Shopify admin.
              Requirement 1.2.3 is that a merchant can change plans in both
              directions without leaving the app or contacting support. */}
          <NavLink to="/app/plan" className="nav-link">
            <IconPlan />
            {plan.name ? `Plan · ${plan.name}` : "Choose a plan"}
          </NavLink>
        </nav>

        {isDemo && (
          <div className="sidebar-footer">
            <div className="tiny muted" style={{ lineHeight: 1.5 }}>
              <strong style={{ color: "var(--ink-secondary)" }}>Demo data.</strong>{" "}
              A seeded store, computed by the same engine that runs on live
              Shopify data.
            </div>
          </div>
        )}
      </aside>

      <div className="main">
        {/* A floating HUD cluster rather than a bar — the page's own head sits
            as large type directly on the sky below it. */}
        <header className="topbar">
          <div className="topbar-actions">
            <div className="segmented" role="group" aria-label="Date range">
              {(Object.keys(RANGE_PRESETS) as RangePreset[]).map((key) => (
                <NavLink
                  key={key}
                  to={rangeLink(key)}
                  aria-current={key === preset ? "true" : undefined}
                  preventScrollReset
                >
                  {RANGE_PRESETS[key].label}
                </NavLink>
              ))}
            </div>
            <ThemeToggle />
          </div>
        </header>

        <main className="content" id="content">
          <RouteTitle />
          <SyncBanner sync={sync} isDemo={isDemo} />
          {/* keyed on the path so the entrance cascade replays per page */}
          <div key={location.pathname} className="page-enter">
            <Outlet />
          </div>
        </main>
      </div>
    </div>
  );

  // The demo runs outside the Shopify admin. AppProvider in embedded mode
  // redirects any page loaded outside the admin back into it, which would
  // bounce a demo visitor straight out of the app.
  if (isDemo) {
    return (
      <>
        <Splash />
        {shell}
      </>
    );
  }

  return (
    // `embedded` is deliberately off here. That prop is the only thing
    // AppProvider uses it for — emitting the App Bridge script tag — and it
    // emits it from inside <body>, which fails Shopify's "first script in the
    // head" requirement. root.tsx puts it in the head instead; loading it twice
    // would register two App Bridge instances against the same frame. Polaris
    // and the navigation bridge below are what remain of AppProvider's job.
    <AppProvider embedded={false}>
      <AppBridgeNavigation />
      <Splash />
      {shell}
    </AppProvider>
  );
}

/**
 * App Bridge turns admin-initiated navigation into a `shopify:navigate` event
 * on the document. Without a listener the merchant's browser back button and
 * any admin-side link into the app do a full page load instead of a client
 * transition. AppProvider installs this itself when `embedded` is on; it is
 * reproduced here because the script that makes it meaningful now lives in the
 * head.
 */
function AppBridgeNavigation() {
  const navigate = useNavigate();

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const href = (event.target as HTMLElement | null)?.getAttribute("href");
      if (href) navigate(href);
    };

    document.addEventListener("shopify:navigate", handleNavigate);
    return () => document.removeEventListener("shopify:navigate", handleNavigate);
  }, [navigate]);

  return null;
}

const TITLES: Record<string, { title: string; subtitle: string }> = {
  "/app": {
    title: "Overview",
    subtitle: "Where the money actually went",
  },
  "/app/orders": {
    title: "Profit per order",
    subtitle: "Every order, fully costed",
  },
  "/app/products": {
    title: "Products",
    subtitle: "What to scale, what to kill",
  },
  "/app/acquisition": {
    title: "Acquisition",
    subtitle: "Which channels buy profitable customers",
  },
  "/app/pricing": {
    title: "Pricing",
    subtitle: "Modelled from your own price history",
  },
  "/app/fulfilment": {
    title: "Fulfilment capacity",
    subtitle: "Bottlenecks before they become problems",
  },
  "/app/settings": {
    title: "Costs & connections",
    subtitle: "The inputs every number here depends on",
  },
  "/app/plan": {
    title: "Plan",
    subtitle: "Billed by Shopify, changeable at any time",
  },
};

function RouteTitle() {
  const { pathname } = useLocation();

  // The overview opens with the time-of-day greeting instead of a page title —
  // rendering both would say "Overview" over a line that already says it.
  if (pathname === "/app") return null;

  const entry = TITLES[pathname] ?? TITLES["/app"]!;

  return (
    <div className="page-head sky-text">
      <h1 className="page-title">{entry.title}</h1>
      <p className="page-subtitle">{entry.subtitle}</p>
    </div>
  );
}
