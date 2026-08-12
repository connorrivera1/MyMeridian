import type { Shop, User } from "@prisma/client";
import { redirect } from "react-router";

import { loadDemoShop } from "~/lib/demo-access.server";
import { authenticate, hasShopifyCredentials } from "~/shopify.server";
import { resolveAccessibleShop } from "./shop-access.server";
import { readSessionToken, requestOriginIsSelf } from "./web-session.server";
import {
  resolvePendingSession,
  resolveSession,
  type ResolvedPendingSession,
} from "./webauth.server";
import { safeReturnPath } from "./web-oauth.server";
import { recordMerchantAccess } from "./security-audit.server";
import {
  firstDeniedRequestLimit,
  RATE_LIMIT_MESSAGE,
  rateLimitHeaders,
} from "./rate-limit.server";
import { withTenantDatabase } from "~/db.server";

const demoModeRequested = process.env.MERIDIAN_DEMO_MODE === "true";

// The build mode is compile-time state, unlike NODE_ENV. Checking both keeps a
// production artifact closed even if an operator accidentally starts it with a
// development NODE_ENV; the bundle verifier also proves the demo lookup itself
// was tree-shaken out.
if (
  demoModeRequested &&
  (import.meta.env.PROD || process.env.NODE_ENV === "production")
) {
  throw new Error(
    "MERIDIAN_DEMO_MODE must not be enabled in a production build or when NODE_ENV=production. " +
      "It bypasses Shopify session authentication.",
  );
}

export const demoAvailable =
  import.meta.env.DEV &&
  demoModeRequested &&
  process.env.NODE_ENV !== "production";

type AdminContext = Awaited<
  ReturnType<NonNullable<typeof authenticate>["admin"]>
>;
type AdminClient = AdminContext["admin"];
type BillingClient = AdminContext["billing"];

export interface ShopContext {
  shop: Shop;
  /**
   * Null in demo mode, and null for a web session — neither has a Shopify
   * session token to call the Admin API with. No dashboard route reads it:
   * they render from the database, and the Admin API is reached from backfill
   * and webhook processing, which carry their own offline session.
   */
  admin: AdminClient | null;
  /**
   * Null in demo mode. Reads and requests Billing API charges; see
   * `plan.server.ts` for why this app bills through the Billing API rather
   * than Shopify App Pricing.
   *
   * Also null for a web session, and that one is a rule rather than a gap:
   * Shopify requires a subscription to be approved inside the admin, so a
   * charge can only ever be requested from the embedded app. `/app/plan`
   * sends a web visitor there instead of offering a button that cannot work.
   */
  billing: BillingClient | null;
  session: { shop: string; id: string } | null;
  isDemo: boolean;
  /**
   * The signed-in web account, or null when the request was authenticated by
   * Shopify. Present so routes can render the account menu and so the store
   * switcher knows whose memberships to offer.
   */
  user: User | null;
}

/**
 * Does this request come from Shopify?
 *
 * Shopify always opens an embedded app with `shop` and `host` in the query
 * string, and App Bridge attaches a session token as a bearer header on every
 * subsequent data request. Any of those means "this is a real merchant" and the
 * request must go through real authentication, never the demo.
 */
export function looksLikeShopifyRequest(request: Request): boolean {
  const url = new URL(request.url);

  for (const key of ["shop", "host", "embedded", "id_token", "session"]) {
    if (url.searchParams.has(key)) return true;
  }

  return request.headers.get("authorization")?.startsWith("Bearer ") ?? false;
}

/**
 * Should this document carry the App Bridge script?
 *
 * Shopify requires App Bridge to be the first script in the head of every page
 * an embedded app serves, so the decision has to be made in the root layout,
 * before any route module runs. It must NOT be loaded for the seeded demo:
 * App Bridge redirects a page it believes should be embedded back into the
 * admin, which would bounce a demo visitor straight out of the app.
 */
export function shouldLoadAppBridge(request: Request): boolean {
  // Publisher routes are a separate top-level security boundary. Loading App
  // Bridge here would make this look like a merchant surface and could let an
  // admin iframe influence navigation on the one route that must never trust a
  // merchant Shopify session.
  if (new URL(request.url).pathname.startsWith("/operator")) return false;
  if (!hasShopifyCredentials) return false;
  if (demoAvailable && !looksLikeShopifyRequest(request)) return false;
  return true;
}

/**
 * The single authentication entry point for every dashboard route.
 *
 * Real Shopify authentication is the primary path: whenever the app has
 * credentials and the request carries any Shopify signal, `authenticate.admin`
 * verifies the session token and redirects into OAuth when it is missing or
 * stale. The seeded demo is only ever reached by a genuinely unauthenticated
 * visitor, on a non-production build, with demo mode explicitly enabled.
 */
export async function requireShopContext(
  request: Request,
): Promise<ShopContext> {
  const shopifyRequest = looksLikeShopifyRequest(request);

  /*
   * Shopify's own signal always wins, and is checked first.
   *
   * Ordering matters rather than being a style choice: a merchant can be
   * signed in to the web dashboard in the same browser that has their Shopify
   * admin open. If the cookie were consulted first, opening the embedded app
   * would render whichever store the web session last selected instead of the
   * store whose admin they are standing in.
   */
  if (hasShopifyCredentials && authenticate && shopifyRequest) {
    const { session, admin, billing } = await authenticate.admin(request);

    const { ensureShopProvisioned } = await import("./provision.server");
    const shop = await ensureShopProvisioned(session.shop);

    await recordMerchantAccess({
      shopId: shop.id,
      actorType: "shopify_session",
      actorId: session.id,
      request,
    });
    return { shop, admin, billing, session, isDemo: false, user: null };
  }

  /*
   * A signed-in web account. Costs nothing when there is no cookie: the token
   * read is a header parse, and a null token short-circuits before any query.
   */
  const pendingWebSession = await resolvePendingWebSession(request);
  if (pendingWebSession && !pendingWebSession.session.mfaVerifiedAt) {
    const returnTo = safeReturnPath(
      `${new URL(request.url).pathname}${new URL(request.url).search}`,
    );
    throw redirect(`/mfa?returnTo=${encodeURIComponent(returnTo)}`);
  }
  const user = pendingWebSession?.user ?? null;
  if (user) {
    const requested = new URL(request.url).searchParams.get("store");
    const shop = await resolveAccessibleShop(user, requested);

    // Authenticated, but no store has been connected yet. This is the normal
    // state immediately after signup, not an error.
    if (!shop) throw redirect("/connect");

    await recordMerchantAccess({
      shopId: shop.id,
      actorType: "web_account",
      actorId: user.id,
      request,
    });
    return {
      shop,
      admin: null,
      billing: null,
      session: null,
      isDemo: false,
      user,
    };
  }

  // No Shopify signal and no web session. Unchanged: hand it to Shopify, which
  // redirects to the install/login flow.
  if (hasShopifyCredentials && authenticate && !demoAvailable) {
    const { session, admin, billing } = await authenticate.admin(request);

    const { ensureShopProvisioned } = await import("./provision.server");
    const shop = await ensureShopProvisioned(session.shop);

    await recordMerchantAccess({
      shopId: shop.id,
      actorType: "shopify_session",
      actorId: session.id,
      request,
    });
    return { shop, admin, billing, session, isDemo: false, user: null };
  }

  if (!demoAvailable) {
    throw new Response(
      "MyMeridian is not configured. Set SHOPIFY_API_KEY and SHOPIFY_API_SECRET " +
        "to install on a store, or run with MERIDIAN_DEMO_MODE=true outside " +
        "production to explore the seeded demo.",
      { status: 503, statusText: "Not configured" },
    );
  }

  const shop = await loadDemoShop();

  return {
    shop,
    admin: null,
    billing: null,
    session: null,
    isDemo: true,
    user: null,
  };
}

/**
 * Authenticate first through the system boundary, then execute all merchant
 * data work under PostgreSQL's transaction-local tenant role and shop id.
 */
export async function withShopContext<T>(
  request: Request,
  work: (context: ShopContext) => Promise<T>,
): Promise<T> {
  const context = await requireShopContext(request);
  requireStandaloneMutationOrigin(request, context);
  await requireMerchantMutationAllowance(request, context);
  return withTenantDatabase(
    { shopId: context.shop.id, userId: context.user?.id ?? null },
    () => work(context),
  );
}

/**
 * A durable baseline for every merchant-side unsafe request. Individual high
 * impact routes (billing, exports, connector OAuth) use stricter scoped
 * limits as well. Keeping this at the authentication boundary prevents a new
 * mutation route from accidentally shipping without an anti-abuse control.
 */
export async function requireMerchantMutationAllowance(
  request: Request,
  context: Pick<ShopContext, "shop" | "user">,
): Promise<void> {
  if (["GET", "HEAD", "OPTIONS"].includes(request.method)) return;
  const limited = await firstDeniedRequestLimit({
    request,
    scope: "merchant_mutation",
    windowMs: 15 * 60 * 1_000,
    ipLimit: 120,
    subject: context.user?.id ?? context.shop.id,
    subjectLimit: 30,
  });
  if (limited) {
    throw new Response(RATE_LIMIT_MESSAGE, {
      status: 429,
      headers: rateLimitHeaders(limited),
    });
  }
}

/**
 * Shopify-embedded mutations carry a short-lived, signed session token and are
 * deliberately not cookie-authenticated. Standalone accounts are different:
 * their session is a browser cookie, so every unsafe request gets an explicit
 * same-origin check in addition to SameSite=Lax. Keeping this here makes it
 * impossible for a new merchant mutation route to forget the protection.
 */
export function requireStandaloneMutationOrigin(
  request: Request,
  context: { user: unknown },
): void {
  if (!context.user || ["GET", "HEAD", "OPTIONS"].includes(request.method)) {
    return;
  }
  if (!requestOriginIsSelf(request)) {
    throw new Response("Invalid request origin.", { status: 403 });
  }
}

/**
 * The signed-in web account on this request, if any.
 *
 * Separate from `requireShopContext` because the login, signup and connect
 * screens need to know who someone is before any store exists to authorise
 * them against.
 */
export async function resolveWebUser(request: Request): Promise<User | null> {
  return resolveSession(readSessionToken(request));
}

/** Restricted primary-auth session, used only to complete mandatory MFA. */
export async function resolvePendingWebSession(
  request: Request,
): Promise<ResolvedPendingSession | null> {
  return resolvePendingSession(readSessionToken(request));
}
