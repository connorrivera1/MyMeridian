import { redirect, type LoaderFunctionArgs } from "react-router";

import { withShopContext } from "~/lib/auth.server";
import { planAllows, requireActivePlan } from "~/lib/plan.server";
import {
  createProfitExportStream,
  profitExportRangeIsAllowed,
} from "~/lib/profit-export.server";
import {
  firstDeniedRequestLimit,
  RATE_LIMIT_MESSAGE,
  rateLimitHeaders,
} from "~/lib/rate-limit.server";
import { requireRecentReauthentication } from "~/lib/reauth.server";
import { recordSensitiveAction } from "~/lib/security-audit.server";

const DAY_MS = 24 * 60 * 60 * 1_000;

function dateParam(value: string | null, fallback: Date): Date {
  if (!value) return fallback;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : fallback;
}

export async function loader({ request }: LoaderFunctionArgs) {
  return withShopContext(request, async (ctx) => {
    await requireRecentReauthentication(request, ctx.user);
    const plan = await requireActivePlan(ctx, request);
    if (!planAllows(plan, "exports")) {
      throw redirect("/app/plan");
    }
    const url = new URL(request.url);
    const now = new Date();
    const from = dateParam(
      url.searchParams.get("from"),
      new Date(now.getTime() - 90 * DAY_MS),
    );
    const requestedTo = dateParam(url.searchParams.get("to"), now);
    const to = new Date(requestedTo);
    // A date-only upper bound means "through this day", not midnight before it.
    if (/^\d{4}-\d{2}-\d{2}$/.test(url.searchParams.get("to") ?? "")) {
      to.setUTCDate(to.getUTCDate() + 1);
    }
    if (from >= to) {
      return new Response(
        "The export start date must be before its end date.",
        {
          status: 400,
        },
      );
    }
    if (!profitExportRangeIsAllowed(from, to)) {
      return new Response("The selected export period is too large.", {
        status: 400,
        headers: { "cache-control": "private, no-store" },
      });
    }
    const limited = await firstDeniedRequestLimit({
      request,
      scope: "profit_export",
      windowMs: 15 * 60 * 1_000,
      ipLimit: 10,
      subject: ctx.user?.id ?? ctx.shop.id,
      subjectLimit: 3,
    });
    if (limited) {
      return new Response(RATE_LIMIT_MESSAGE, {
        status: 429,
        headers: rateLimitHeaders(limited),
      });
    }
    await recordSensitiveAction({
      shopId: ctx.shop.id,
      actorType: ctx.user ? "web_account" : "shopify_session",
      actorId: ctx.user?.id ?? ctx.session?.id ?? ctx.shop.id,
      request,
      action: "PROFIT_EXPORT_STARTED",
      resource: `profit_export:${from.toISOString().slice(0, 10)}:${new Date(to.getTime() - 1).toISOString().slice(0, 10)}`,
    });
    const filename = `mymeridian-profit-${from.toISOString().slice(0, 10)}-${new Date(to.getTime() - 1).toISOString().slice(0, 10)}.csv`;
    return new Response(
      createProfitExportStream({ shopId: ctx.shop.id, from, to }),
      {
        headers: {
          "content-type": "text/csv; charset=utf-8",
          "content-disposition": `attachment; filename="${filename}"`,
          "cache-control": "private, no-store",
          "x-content-type-options": "nosniff",
        },
      },
    );
  });
}
