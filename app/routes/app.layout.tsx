import { useEffect, useLayoutEffect, useRef } from "react";
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
  IconPrivacy,
  IconCosts,
  IconProducts,
  IconSettings,
  Banner,
  Splash,
} from "~/design/components";
import { loadCapacityAnalysis, resolveRange } from "~/data/analytics.server";
import {
  loadAdSpendCoverage,
  type AdSpendCoverage,
} from "~/lib/ad-spend-coverage.server";
import {
  requireShopContext,
  resolveWebUser,
  type ShopContext,
} from "~/lib/auth.server";
import { withTenantDatabase } from "~/db.server";
import { completePendingLink } from "~/lib/store-link.server";
import { planAllows, resolvePlan } from "~/lib/plan.server";
import {
  parseRangePreset,
  RANGE_PRESETS,
  type RangePreset,
} from "~/lib/ranges";
import { PLANS } from "~/lib/plans";

export async function loader({ request }: LoaderFunctionArgs) {
  const ctx = await requireShopContext(request);
  let linkedUserId = ctx.user?.id ?? null;
  /*
   * A web account finishing Shopify's install lands here, and this is the only
   * place a ShopMembership is ever written. Shopify authentication has already
   * proved the store; the pending cookie grants nothing by itself. This link is
   * completed before the tenant role is entered because identity/membership
   * authorisation belongs to the system authentication boundary.
   */
  if (ctx.session) {
    const webUser = await resolveWebUser(request);
    if (webUser) {
      await completePendingLink(
        request,
        webUser.id,
        ctx.shop.domain,
        ctx.shop.id,
      );
      linkedUserId = webUser.id;
    }
  }
  return withTenantDatabase({ shopId: ctx.shop.id, userId: linkedUserId }, () =>
    loadAppLayout(request, ctx),
  );
}

async function loadAppLayout(request: Request, ctx: ShopContext) {
  const { shop, isDemo } = ctx;
  // Resolved here rather than per route so the answer is read once per
  // navigation, and so a store with no active charge cannot reach a paid screen
  // by typing its URL.
  const plan = await resolvePlan(ctx);
  const url = new URL(request.url);

  if (
    !isDemo &&
    shop.onboardingStep !== "complete" &&
    url.pathname.replace(/\/+$/, "") !== "/app/onboarding"
  ) {
    throw redirect(`/app/onboarding${url.search}`);
  }
  const operationalRoute =
    Boolean(plan.planId) && !isEntitlementExemptPath(url.pathname);

  if (!plan.planId && !isEntitlementExemptPath(url.pathname)) {
    throw redirect(`/app/plan${url.search}`);
  }

  const preset = parseRangePreset(
    new URL(request.url).searchParams.get("range"),
  );

  // A store still importing has nothing to analyse yet; asking for analytics
  // would just be an expensive way to compute zeroes. The demo store is never
  // importing — its data is seeded, not fetched.
  const importing =
    !isDemo && (shop.syncStatus === "RUNNING" || shop.syncStatus === "PENDING");

  // Capacity only — deliberately not `loadShopAnalytics`. This runs on every
  // navigation, and the badge needs an integer that `CapacityDay` rows alone
  // can produce; building the whole profit engine for it made the shell as
  // expensive as the heaviest screen. See loadCapacityAnalysis.
  const [capacity, adSpendCoverage] = await Promise.all([
    !operationalRoute || importing || !planAllows(plan, "capacity")
      ? Promise.resolve(null)
      : loadCapacityAnalysis(
          shop,
          resolveRange(shop, preset, { anchorToData: isDemo }),
        ),
    operationalRoute
      ? loadAdSpendCoverage(shop.id, isDemo)
      : Promise.resolve({
          mode: "unavailable" as const,
          syncedSourceCount: 0,
        }),
  ]);
  const alertCount =
    capacity?.alerts.filter(
      (alert) => alert.severity === "CRITICAL" || alert.severity === "WARNING",
    ).length ?? 0;

  return {
    shopName: shop.name,
    shopDomain: shop.domain,
    isDemo,
    preset,
    alertCount,
    adSpendCoverage,
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

export function isEntitlementExemptPath(pathname: string): boolean {
  const normalized = pathname.replace(/\/+$/, "");
  return (
    normalized === "/app/plan" ||
    normalized === "/app/onboarding" ||
    normalized === "/app/privacy-requests" ||
    /^\/app\/privacy-requests\/[^/]+\/download$/.test(normalized)
  );
}

/**
 * Every profit-bearing route needs the same missing-input boundary. Keeping it
 * in the shell prevents a merchant who lands directly on Orders, Products or
 * Pricing from missing the qualification shown on Overview.
 */
export function AdSpendCoverageBanner({
  coverage,
}: {
  coverage: AdSpendCoverage;
}) {
  return (
    <Banner tone="warn">
      <strong style={{ color: "var(--ink-primary)" }}>
        {coverage.mode === "unavailable"
          ? "Profit is before paid marketing."
          : "Profit includes recorded paid marketing only."}
      </strong>{" "}
      {coverage.mode === "unavailable" ? (
        <>
          No ad-spend source has completed a sync. If this store runs ads, every
          profit, contribution and margin figure excludes that cost and may be
          overstated; unavailable spend is shown as a dash, never as zero.
        </>
      ) : (
        <>
          {coverage.syncedSourceCount.toLocaleString()} paid source
          {coverage.syncedSourceCount === 1 ? " has" : "s have"} completed a
          sync. Spend from any other account or platform remains outside the
          calculation.
        </>
      )}
    </Banner>
  );
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
  { to: "/app/costs", label: "Costs & bundles", Icon: IconCosts },
  { to: "/app/acquisition", label: "Acquisition", Icon: IconChannels },
  { to: "/app/pricing", label: "Pricing", Icon: IconPricing },
  {
    to: "/app/fulfilment",
    label: "Fulfilment",
    Icon: IconFulfilment,
    badge: true,
  },
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
          {sync.stage ?? "Starting up"}. {sync.products.toLocaleString()}{" "}
          products and {sync.orders.toLocaleString()} orders so far. You can
          keep using the app — figures fill in as the import runs.
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
          not included in this release. The app publisher must obtain separate
          Shopify approval before a future update can request longer history;
          there is no merchant setting that can enable it today.
        </div>
      </div>
    );
  }

  return null;
}

export default function AppLayout() {
  const {
    shopName,
    shopDomain,
    isDemo,
    preset,
    alertCount,
    adSpendCoverage,
    plan,
    sync,
  } = useLoaderData<typeof loader>();
  const location = useLocation();
  // Re-measured whenever the selected range changes, which is the only thing
  // that moves the pill between navigations.
  const rangeRef = useTravellingPill(preset);
  useSpatialField();

  // Keep whatever else the merchant has narrowed to. Rebuilding the query
  // string from scratch here silently dropped an active sort and channel
  // filter, so changing the date range on a filtered orders view threw the
  // filter away without saying so.
  const rangeLink = (next: RangePreset) => {
    const params = new URLSearchParams(location.search);
    params.set("range", next);
    return `${location.pathname}?${params.toString()}`;
  };
  const showOperationalBanners =
    Boolean(plan.id) && !isEntitlementExemptPath(location.pathname);

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
            <div className="brand-name">MyMeridian</div>
            <div className="brand-shop" title={shopDomain}>
              {shopName}
            </div>
          </div>
        </div>

        <nav className="nav" aria-label="Main">
          {plan.id &&
            NAV.map(({ to, label, Icon, end, badge }) => (
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
          {plan.id && (
            <NavLink to={`/app/settings?range=${preset}`} className="nav-link">
              <IconSettings />
              Costs &amp; connections
            </NavLink>
          )}
          <NavLink to="/app/privacy-requests" className="nav-link">
            <IconPrivacy />
            Privacy requests
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
              <strong style={{ color: "var(--ink-secondary)" }}>
                Demo data.
              </strong>{" "}
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
            <div
              className="segmented"
              role="group"
              aria-label="Date range"
              ref={rangeRef}
            >
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
          {showOperationalBanners && <SyncBanner sync={sync} isDemo={isDemo} />}
          {/* Overview carries the fuller, metric-specific version. Every other
              route gets this shell-level qualification. */}
          {showOperationalBanners && location.pathname !== "/app" && (
            <AdSpendCoverageBanner coverage={adSpendCoverage} />
          )}
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
/**
 * Publishes the pointer's position as `--px` / `--py`, in the range -1 to 1.
 *
 * One listener for the entire depth system. Every spatial rule in the
 * stylesheet — the sky's counter-drift, the two light blooms, the tilt of the
 * content plane, the highlight travelling along each hairline — reads these two
 * properties, so there is exactly one source of truth for "where is the light",
 * and adding a new depth-aware element costs no JavaScript at all.
 *
 * Written on a rAF tick rather than per event: pointermove fires far faster
 * than the compositor can use, and setting a custom property on the root
 * invalidates style for the document. Coalescing to one write per frame is the
 * difference between a smooth plane and a busy main thread.
 *
 * Pointer-only and motion-aware. On a touch device there is no persistent
 * pointer to track, and under `prefers-reduced-motion` a page that tilts as you
 * move is exactly what the preference exists to prevent — in both cases the
 * properties keep their neutral defaults and the page renders flat.
 */
function useSpatialField() {
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)");
    if (reduced.matches || !fine.matches) return;

    const root = document.documentElement;
    let x = 0;
    let y = 0;
    let frame = 0;

    const write = () => {
      frame = 0;
      root.style.setProperty("--px", x.toFixed(4));
      root.style.setProperty("--py", y.toFixed(4));
    };

    const onMove = (event: PointerEvent) => {
      x = (event.clientX / window.innerWidth) * 2 - 1;
      y = (event.clientY / window.innerHeight) * 2 - 1;
      if (!frame) frame = requestAnimationFrame(write);
    };

    // Returning to centre when the pointer leaves keeps the page from holding
    // a tilt nothing is causing any more.
    const onLeave = () => {
      x = 0;
      y = 0;
      if (!frame) frame = requestAnimationFrame(write);
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    document.addEventListener("pointerleave", onLeave);

    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener("pointermove", onMove);
      document.removeEventListener("pointerleave", onLeave);
      root.style.removeProperty("--px");
      root.style.removeProperty("--py");
    };
  }, []);
}

/**
 * Publishes the active range link's geometry so the pill can travel to it.
 *
 * The pill's position cannot be expressed in CSS: the labels are natural
 * language, so the four segments are genuinely different widths ("7 days"
 * against "6 months"), and no `:has()` rule can encode an offset that varies
 * with text. Measuring is the only correct answer.
 *
 * `useLayoutEffect` rather than `useEffect` so the properties are written
 * before the browser paints — with the latter, the pill would be visible for
 * one frame at its previous position after every range change.
 *
 * Setting `data-sliding` is what switches the CSS from the per-link fallback
 * pill to the travelling one, so the control is always correctly marked:
 * server-rendered HTML shows the classic pill, and it upgrades on hydration.
 *
 * A ResizeObserver covers the two ways the geometry moves without a
 * navigation: the variable font finishing loading (every label reflows) and
 * the window resizing.
 */
function useTravellingPill(activeKey: string) {
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;

    const place = () => {
      const active = el.querySelector<HTMLElement>('[aria-current="true"]');
      if (!active) {
        el.removeAttribute("data-sliding");
        return;
      }
      el.style.setProperty("--pill-x", `${active.offsetLeft}px`);
      el.style.setProperty("--pill-w", `${active.offsetWidth}px`);
      el.dataset.sliding = "true";
    };

    place();

    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, [activeKey]);

  return ref;
}

function AppBridgeNavigation() {
  const navigate = useNavigate();

  useEffect(() => {
    const handleNavigate = (event: Event) => {
      const href = (event.target as HTMLElement | null)?.getAttribute("href");
      if (href) navigate(href);
    };

    document.addEventListener("shopify:navigate", handleNavigate);
    return () =>
      document.removeEventListener("shopify:navigate", handleNavigate);
  }, [navigate]);

  return null;
}

const TITLES: Record<string, { title: string; subtitle: string }> = {
  "/app": {
    title: "Overview",
    subtitle: "Profit from the inputs available",
  },
  "/app/orders": {
    title: "Profit per order",
    subtitle: "Available and missing costs, order by order",
  },
  "/app/products": {
    title: "Products",
    subtitle: "Qualified contribution by product",
  },
  "/app/acquisition": {
    title: "Acquisition",
    subtitle: "Revenue and qualified contribution by channel",
  },
  "/app/pricing": {
    title: "Pricing",
    subtitle: "Modelled from price history observed after install",
  },
  "/app/fulfilment": {
    title: "Fulfilment capacity",
    subtitle: "Bottlenecks before they become problems",
  },
  "/app/costs": {
    title: "Costs & bundles",
    subtitle: "What things cost, when they cost it, and what a pack is made of",
  },
  "/app/settings": {
    title: "Costs & connections",
    subtitle: "Cost assumptions and data availability",
  },
  "/app/privacy-requests": {
    title: "Privacy requests",
    subtitle: "Shopper exports, available regardless of subscription",
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
