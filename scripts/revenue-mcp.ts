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
 *   Run:      npx tsx scripts/revenue-mcp.ts        (from the Meridian root)
 *   Wire in:  claude mcp add meridian-revenue -- npx tsx scripts/revenue-mcp.ts
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
import { PLANS, type PlanId } from "~/lib/plans";
import {
  summariseMovement,
  summariseRevenue,
  type SubscriptionEventRow,
  type SubscriptionRow,
} from "~/lib/revenue";

// --- environment -----------------------------------------------------------

if (!process.env.DATABASE_URL) {
  const envPath = join(dirname(fileURLToPath(import.meta.url)), "..", ".env");
  try {
    const line = readFileSync(envPath, "utf8")
      .split("\n")
      .find((l) => l.startsWith("DATABASE_URL="));
    if (line) {
      process.env.DATABASE_URL = line.slice("DATABASE_URL=".length).replace(/^"|"$/g, "");
    }
  } catch {
    // No .env — Prisma's own missing-URL error below is clearer than anything
    // synthesised here.
  }
}

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

// --- go --------------------------------------------------------------------

const transport = new StdioServerTransport();
await server.connect(transport);
