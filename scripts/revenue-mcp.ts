/**
 * Meridian revenue MCP server.
 *
 * Exposes Meridian's own subscription revenue — MRR, subscribers by plan and
 * interval, trials, and start/end movement — as MCP tools over stdio, so an
 * agent (Eevee) can ask "what's Meridian's MRR?" and get the truth from the
 * same database the billing webhooks write.
 *
 * This exists because the obvious off-the-shelf answer could not work:
 * RevenueCat's data sources are mobile store receipts and its SDK, and
 * Meridian's revenue is Shopify Billing API charges, which it cannot see. The
 * numbers here come from `Subscription` (current state) and
 * `SubscriptionEvent` (append-only history written by the
 * app_subscriptions/update webhook), computed by the pure functions in
 * app/lib/revenue.ts, which carry their own tests.
 *
 * Read-only by construction: this process holds no mutation path — it issues
 * only findMany/count. Connect it to an agent without worrying about what the
 * agent might do; there is nothing here to do.
 *
 * The cash side is different: `cash_summary` reads Shopify's Partner API
 * ledger (gross, Shopify's fee, net, refunds) — what actually moved, not what
 * subscriptions are worth. It needs SHOPIFY_PARTNER_ORG_ID and
 * SHOPIFY_PARTNER_API_TOKEN (see .env.example) and explains itself when
 * they're absent.
 *
 *   Run:      npx tsx scripts/revenue-mcp.ts        (from the Meridian root)
 *   Agents:   claude mcp add meridian-revenue -- npx tsx scripts/revenue-mcp.ts
 *   Eevee:    already wired via extra_mcp_servers.json in her runtime dir —
 *             her gateway runs --strict-mcp-config, so ~/.claude.json never
 *             reaches her; that file is the only door.
 *
 * DATABASE_URL comes from the environment, or from Meridian's own .env as a
 * fallback so the agent's MCP config never has to duplicate the secret.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PrismaClient } from "@prisma/client";
import { z } from "zod";

import { formatMoney } from "~/engine/money";
import { summariseCash, type CashTransactionRow } from "~/lib/cash";
import { PLANS, type PlanId } from "~/lib/plans";
import {
  summariseMovement,
  summariseRevenue,
  type SubscriptionEventRow,
  type SubscriptionRow,
} from "~/lib/revenue";

// --- environment -----------------------------------------------------------

const ENV_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");

function fromDotenv(key: string): string | undefined {
  try {
    const line = readFileSync(ENV_PATH, "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${key}=`));
    return line?.slice(key.length + 1).replace(/^"|"$/g, "") || undefined;
  } catch {
    return undefined;
  }
}

// Prisma's own missing-URL error is clearer than anything synthesised here.
process.env.DATABASE_URL ||= fromDotenv("DATABASE_URL") ?? "";

const prisma = new PrismaClient();

// --- data ------------------------------------------------------------------

async function loadRows(): Promise<SubscriptionRow[]> {
  return prisma.subscription.findMany({
    select: { plan: true, interval: true, status: true, trialEndsAt: true },
  });
}

async function loadEvents(days: number): Promise<SubscriptionEventRow[]> {
  return prisma.subscriptionEvent.findMany({
    where: { occurredAt: { gte: new Date(Date.now() - days * 86_400_000) } },
    orderBy: { occurredAt: "desc" },
    select: { plan: true, interval: true, status: true, occurredAt: true },
  });
}

const money = (cents: number) => formatMoney(cents, "USD", { decimals: false });

// --- server ----------------------------------------------------------------

const server = new McpServer({ name: "meridian-revenue", version: "1.0.0" });

server.tool(
  "revenue_summary",
  "Meridian's own subscription revenue right now: MRR, ARR, active subscribers " +
    "by plan and billing interval, and trials in flight. Annual subscribers are " +
    "amortised into MRR at annualPrice/12; live trials are counted separately " +
    "and contribute nothing to MRR, because uncharged revenue is a forecast.",
  {},
  async () => {
    const summary = summariseRevenue(await loadRows(), new Date());

    const lines = [
      `MRR ${money(summary.mrrCents)}   ARR ${money(summary.arrCents)}`,
      `${summary.activeSubscribers} paying subscriber(s), ${summary.trialing} in trial`,
      "",
      ...Object.entries(summary.byPlan).map(([id, b]) => {
        const plan = PLANS[id as PlanId];
        return `${plan.name.padEnd(8)} ${String(b.monthly).padStart(3)} monthly + ${String(b.annual).padStart(3)} annual  ->  ${money(b.mrrCents)}/mo`;
      }),
    ];

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      structuredContent: summary as unknown as Record<string, unknown>,
    };
  },
);

server.tool(
  "revenue_movement",
  "Subscription starts and ends over a trailing window (default 30 days), with " +
    "a blunt churn rate: ends in the window over current actives plus those " +
    "ends. Computed from the append-only SubscriptionEvent history.",
  { windowDays: z.number().int().min(1).max(365).default(30) },
  async ({ windowDays }) => {
    const now = new Date();
    const [rows, events] = await Promise.all([loadRows(), loadEvents(windowDays)]);
    const active = summariseRevenue(rows, now).activeSubscribers;
    const movement = summariseMovement(events, active, windowDays, now);

    const text =
      `Last ${movement.windowDays} days: ${movement.started} started, ` +
      `${movement.ended} ended` +
      (movement.churnRatePct === null
        ? " (no base to compute churn against)"
        : ` — churn ${movement.churnRatePct}%`);

    return {
      content: [{ type: "text" as const, text }],
      structuredContent: movement as unknown as Record<string, unknown>,
    };
  },
);

server.tool(
  "subscription_events",
  "The raw recent subscription events, newest first — each plan change, " +
    "cancellation and renewal exactly as the Shopify webhook delivered it. " +
    "For when the summary raises a question the aggregate cannot answer.",
  { windowDays: z.number().int().min(1).max(365).default(30) },
  async ({ windowDays }) => {
    const events = await loadEvents(windowDays);
    const text =
      events.length === 0
        ? `No subscription events in the last ${windowDays} days.`
        : events
            .map(
              (e) =>
                `${e.occurredAt.toISOString().slice(0, 16)}  ${e.plan.padEnd(8)} ${e.interval.padEnd(7)} ${e.status}`,
            )
            .join("\n");

    return { content: [{ type: "text" as const, text }] };
  },
);

// --- cash side: the Partner API ledger --------------------------------------
//
// Everything above is entitlements at list price. This is what money actually
// moved: gross charged, Shopify's fee, net to us, refunds included. Source is
// the Partner API's transaction ledger — a different system from the Admin
// API, with its own credential that only Connor's Partner account can mint.
//
// VERIFIED against the live Partner API on 2026-08-10 (org 5094596): the query
// below is accepted and returns an empty edge list, which is the correct answer
// while no merchant has subscribed. Any future schema disagreement comes back
// verbatim in the tool result.
//
// On the version: every dated version string from 2019-10 through 2025-07 was
// probed against this endpoint and every one answered `Invalid API version`;
// only `unstable` is served. So that default is measured, not lazy — override
// it once a dated version starts answering, since `unstable` may change
// without notice.

const PARTNER_API_VERSION =
  process.env.SHOPIFY_PARTNER_API_VERSION ||
  fromDotenv("SHOPIFY_PARTNER_API_VERSION") ||
  "unstable";

const TRANSACTIONS_QUERY = `
  query($createdAtMin: DateTime, $after: String) {
    transactions(createdAtMin: $createdAtMin, first: 100, after: $after) {
      edges {
        cursor
        node {
          __typename
          createdAt
          ... on AppSubscriptionSale {
            grossAmount { amount } shopifyFee { amount } netAmount { amount }
            shop { myshopifyDomain }
          }
          ... on AppOneTimeSale {
            grossAmount { amount } shopifyFee { amount } netAmount { amount }
            shop { myshopifyDomain }
          }
          ... on AppUsageSale {
            grossAmount { amount } shopifyFee { amount } netAmount { amount }
            shop { myshopifyDomain }
          }
          ... on AppSaleAdjustment { netAmount { amount } shop { myshopifyDomain } }
          ... on AppSaleCredit { netAmount { amount } shop { myshopifyDomain } }
        }
      }
      pageInfo { hasNextPage }
    }
  }
`;

interface PartnerCreds {
  orgId: string;
  token: string;
}

function partnerCreds(): PartnerCreds | null {
  const orgId = process.env.SHOPIFY_PARTNER_ORG_ID || fromDotenv("SHOPIFY_PARTNER_ORG_ID");
  const token = process.env.SHOPIFY_PARTNER_API_TOKEN || fromDotenv("SHOPIFY_PARTNER_API_TOKEN");
  return orgId && token ? { orgId, token } : null;
}

const CREDS_MISSING =
  "Partner API credentials are not configured, so the cash ledger is not " +
  "reachable yet. The subscription-side tools (revenue_summary etc.) still " +
  "work — they read Meridian's own database.\n\n" +
  "To enable: Connor creates a Partner API client at partners.shopify.com → " +
  "Settings → Partner API clients (read-only scope: 'View financials'), then " +
  `adds to ${ENV_PATH}:\n` +
  "  SHOPIFY_PARTNER_ORG_ID=<the number in the partners.shopify.com URL>\n" +
  "  SHOPIFY_PARTNER_API_TOKEN=<the client's access token>\n" +
  "No restart of anything else is needed; this server reads them per call.";

async function fetchPartnerTransactions(
  creds: PartnerCreds,
  since: Date,
): Promise<CashTransactionRow[]> {
  const rows: CashTransactionRow[] = [];
  let after: string | null = null;

  // 5 pages × 100 is bounded honesty: an app whose 30-day ledger overflows
  // that has outgrown this tool, and the truncation is reported, not silent.
  for (let page = 0; page < 5; page += 1) {
    const response = await fetch(
      `https://partners.shopify.com/${creds.orgId}/api/${PARTNER_API_VERSION}/graphql.json`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": creds.token,
        },
        body: JSON.stringify({
          query: TRANSACTIONS_QUERY,
          variables: { createdAtMin: since.toISOString(), after },
        }),
      },
    );
    if (!response.ok) {
      throw new Error(`Partner API HTTP ${response.status}: ${await response.text()}`);
    }
    const payload = (await response.json()) as {
      errors?: { message: string }[];
      data?: {
        transactions: {
          edges: {
            cursor: string;
            node: {
              __typename: string;
              createdAt: string;
              grossAmount?: { amount: string };
              shopifyFee?: { amount: string };
              netAmount?: { amount: string };
              shop?: { myshopifyDomain: string };
            };
          }[];
          pageInfo: { hasNextPage: boolean };
        };
      };
    };
    if (payload.errors?.length) {
      throw new Error(`Partner API: ${payload.errors.map((e) => e.message).join("; ")}`);
    }
    const connection = payload.data?.transactions;
    if (!connection) break;

    for (const { node } of connection.edges) {
      rows.push({
        type: node.__typename,
        createdAt: node.createdAt,
        grossAmount: node.grossAmount?.amount ?? null,
        shopifyFee: node.shopifyFee?.amount ?? null,
        netAmount: node.netAmount?.amount ?? null,
        shop: node.shop?.myshopifyDomain ?? null,
      });
    }
    if (!connection.pageInfo.hasNextPage) return rows;
    after = connection.edges.at(-1)?.cursor ?? null;
    if (!after) return rows;
  }

  throw new Error(
    `More than ${5 * 100} transactions in the window — totals would be silently wrong. Narrow windowDays.`,
  );
}

server.tool(
  "cash_summary",
  "What money actually moved, from Shopify's Partner API transaction ledger: " +
    "gross charged to merchants, Shopify's fee, and net to us over a trailing " +
    "window — refunds and credits included. This is cash truth, unlike " +
    "revenue_summary which is entitlements at list price. Requires Partner " +
    "API credentials; if missing, the result explains how to add them.",
  { windowDays: z.number().int().min(1).max(365).default(30) },
  async ({ windowDays }) => {
    const creds = partnerCreds();
    if (!creds) return { content: [{ type: "text" as const, text: CREDS_MISSING }] };

    const since = new Date(Date.now() - windowDays * 86_400_000);
    const summary = summariseCash(await fetchPartnerTransactions(creds, since), windowDays);

    const lines = [
      `Last ${windowDays} days: gross ${money(summary.grossCents)}, ` +
        `Shopify fee ${money(summary.feeCents)}, net ${money(summary.netCents)} ` +
        `(${summary.transactionCount} transaction(s))`,
      ...Object.entries(summary.byType).map(
        ([type, b]) => `  ${type}: ${b.count} -> net ${money(b.netCents)}`,
      ),
    ];

    return {
      content: [{ type: "text" as const, text: lines.join("\n") }],
      structuredContent: summary as unknown as Record<string, unknown>,
    };
  },
);

// --- go --------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
