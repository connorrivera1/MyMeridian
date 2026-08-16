import { PeriodStatus, CostSource } from "@prisma/client";
import {
  Form,
  isRouteErrorResponse,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteError,
} from "react-router";
import { useEffect, useRef, useState } from "react";
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { z } from "zod";

import prisma from "~/db.server";
import { Badge, Banner, Card, Empty, Money } from "~/design/components";
import { toMicros } from "~/engine/money";
import { withShopContext, type ShopContext } from "~/lib/auth.server";
import { requireRecentReauthentication } from "~/lib/reauth.server";
import {
  confirmBundleComponent,
  enqueueBundleDetection,
  removeBundleComponent,
  upsertBundleComponent,
} from "~/lib/bundles.server";
import { recordVariantCost } from "~/lib/cost-history.server";
import { requireActivePlan } from "~/lib/plan.server";
import {
  closePeriod,
  enqueueRestatement,
  reopenPeriod,
} from "~/lib/restatement.server";

/**
 * Costs — the merchant-facing surface for cost history, bundles and restatement.
 *
 * The page is organised around one distinction the rest of the app depends on:
 * recording what something costs is not the same act as changing what you
 * already reported. Saving a cost never moves a published figure; restating is
 * a separate, explicitly-worded button that says how far back it reaches, and
 * refuses to touch a closed period.
 */

const VARIANT_LIMIT = 250;

export async function loader({ request }: LoaderFunctionArgs) {
  return withShopContext(request, (ctx) => loadCosts(request, ctx));
}

async function loadCosts(request: Request, ctx: ShopContext) {
  const { shop } = ctx;
  await requireActivePlan(ctx, request);

  const [
    variants,
    variantCount,
    missingCogsCount,
    edges,
    snapshots,
    restatements,
    jobs,
  ] =
    await Promise.all([
      prisma.variant.findMany({
        where: { shopId: shop.id },
        select: {
          id: true,
          title: true,
          sku: true,
          unitCost: true,
          costSource: true,
          product: { select: { title: true } },
          costHistory: {
            select: {
              id: true,
              unitCost: true,
              effectiveAt: true,
              source: true,
              note: true,
            },
            orderBy: { effectiveAt: "desc" },
            take: 12,
          },
        },
        orderBy: [{ product: { title: "asc" } }, { title: "asc" }],
        take: VARIANT_LIMIT,
      }),
      prisma.variant.count({ where: { shopId: shop.id } }),
      prisma.variant.count({ where: { shopId: shop.id, unitCost: null } }),
      prisma.bundleComponent.findMany({
        where: { shopId: shop.id },
        select: {
          id: true,
          quantity: true,
          source: true,
          evidence: true,
          confirmedAt: true,
          bundleVariant: {
            select: {
              id: true,
              title: true,
              sku: true,
              product: { select: { title: true } },
            },
          },
          componentVariant: {
            select: {
              id: true,
              title: true,
              sku: true,
              product: { select: { title: true } },
            },
          },
        },
        orderBy: [{ confirmedAt: "asc" }, { createdAt: "asc" }],
      }),
      prisma.periodSnapshot.findMany({
        where: { shopId: shop.id },
        orderBy: { periodKey: "desc" },
        take: 24,
      }),
      prisma.periodRestatement.findMany({
        where: { shopId: shop.id },
        orderBy: { appliedAt: "desc" },
        take: 25,
      }),
      prisma.recalcJob.findMany({
        where: { shopId: shop.id },
        orderBy: { createdAt: "desc" },
        take: 8,
      }),
    ]);

  const label = (v: {
    title: string;
    sku: string | null;
    product: { title: string };
  }) => `${v.product.title} — ${v.title}${v.sku ? ` (${v.sku})` : ""}`;

  return {
    currency: shop.currency,
    timezone: shop.timezone,
    variantCount,
    missingCogsCount,
    variantsShown: variants.length,
    variants: variants.map((variant) => ({
      id: variant.id,
      label: label(variant),
      unitCost: variant.unitCost ? variant.unitCost.toString() : null,
      needsCogs: variant.unitCost === null,
      costSource: variant.costSource,
      history: variant.costHistory.map((version) => ({
        id: version.id,
        unitCost: version.unitCost.toString(),
        effectiveAt: version.effectiveAt.toISOString(),
        source: version.source,
        note: version.note,
      })),
    })),
    proposals: edges
      .filter((edge) => edge.confirmedAt === null)
      .map((edge) => ({
        id: edge.id,
        bundle: label(edge.bundleVariant),
        component: label(edge.componentVariant),
        quantity: edge.quantity,
        source: edge.source,
        evidence: edge.evidence,
      })),
    mappings: edges
      .filter((edge) => edge.confirmedAt !== null)
      .map((edge) => ({
        id: edge.id,
        bundle: label(edge.bundleVariant),
        component: label(edge.componentVariant),
        quantity: edge.quantity,
        source: edge.source,
      })),
    periods: snapshots.map((snapshot) => ({
      periodKey: snapshot.periodKey,
      status: snapshot.status,
      orderCount: snapshot.orderCount,
      netRevenue: snapshot.netRevenue.toString(),
      cogs: snapshot.cogs.toString(),
      netProfit: snapshot.netProfit.toString(),
      restatementCount: snapshot.restatementCount,
      capturedAt: snapshot.capturedAt.toISOString(),
    })),
    restatements: restatements.map((row) => ({
      id: row.id,
      periodKey: row.periodKey,
      reason: row.reason,
      ordersAffected: row.ordersAffected,
      lineItemsAffected: row.lineItemsAffected,
      cogsBefore: row.cogsBefore.toString(),
      cogsAfter: row.cogsAfter.toString(),
      netProfitBefore: row.netProfitBefore.toString(),
      netProfitAfter: row.netProfitAfter.toString(),
      appliedAt: row.appliedAt.toISOString(),
    })),
    jobs: jobs.map((job) => ({
      id: job.id,
      kind: job.kind,
      status: job.status,
      attempts: job.attempts,
      error: job.error,
      createdAt: job.createdAt.toISOString(),
      finishedAt: job.finishedAt ? job.finishedAt.toISOString() : null,
    })),
  };
}

const CostEdit = z.object({
  variantId: z.string().min(1),
  unitCost: z.coerce.number().min(0).max(1_000_000),
  effectiveAt: z.string().min(1),
  note: z.string().max(200).optional(),
});

const BundleEdit = z.object({
  bundleVariantId: z.string().min(1),
  componentVariantId: z.string().min(1),
  quantity: z.coerce.number().int().min(1).max(1000),
});

const BulkCostEdit = z.object({
  variantIds: z.array(z.string().min(1)).min(1).max(VARIANT_LIMIT),
  unitCost: z.coerce.number().positive().max(1_000_000),
  effectiveAt: z.string().min(1),
});

const COGS_CSV_MAX_BYTES = 2_000_000;
const COGS_CSV_MAX_ROWS = 2_000;

export interface CsvCogsRow {
  sku: string;
  cogsUsd: number;
  line: number;
}

/**
 * Parse the deliberately tiny COGS import format without treating commas in a
 * quoted SKU as separate columns. We accept only the two documented columns;
 * silently accepting a shifted or wider file could apply a supplier price to
 * the wrong item.
 */
export function parseCogsCsv(input: string): CsvCogsRow[] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < input.length; index += 1) {
    const character = input[index]!;
    if (quoted) {
      if (character === '"') {
        if (input[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"') {
      if (field.length !== 0) throw new Error("CSV quotes must wrap a whole cell.");
      quoted = true;
    } else if (character === ",") {
      row.push(field.trim());
      field = "";
    } else if (character === "\n") {
      row.push(field.trim());
      rows.push(row);
      row = [];
      field = "";
    } else if (character !== "\r") {
      field += character;
    }
  }
  if (quoted) throw new Error("CSV has an unclosed quoted value.");
  if (field.length > 0 || row.length > 0) {
    row.push(field.trim());
    rows.push(row);
  }

  const nonEmptyRows = rows.filter((entry) => entry.some((value) => value !== ""));
  const header = nonEmptyRows.shift()?.map((value) => value.replace(/^\uFEFF/, "").toLowerCase());
  if (!header || header.length !== 2 || header[0] !== "sku" || header[1] !== "cogs_usd") {
    throw new Error("CSV must begin with exactly: sku,cogs_usd");
  }
  if (nonEmptyRows.length === 0) throw new Error("CSV does not contain any COGS rows.");
  if (nonEmptyRows.length > COGS_CSV_MAX_ROWS) {
    throw new Error(`CSV can contain at most ${COGS_CSV_MAX_ROWS.toLocaleString()} COGS rows.`);
  }

  const seen = new Set<string>();
  return nonEmptyRows.map((entry, index) => {
    const line = index + 2;
    const [sku, rawCogs] = entry;
    if (entry.length !== 2 || !sku || !rawCogs) {
      throw new Error(`CSV line ${line} must include both sku and cogs_usd.`);
    }
    if (!/^\d+(?:\.\d{1,4})?$/.test(rawCogs)) {
      throw new Error(`CSV line ${line} has an invalid cogs_usd value.`);
    }
    const cogsUsd = Number(rawCogs);
    if (!Number.isFinite(cogsUsd) || cogsUsd <= 0 || cogsUsd > 1_000_000) {
      throw new Error(
        `CSV line ${line} must have a positive cogs_usd value no larger than 1,000,000.`,
      );
    }
    if (seen.has(sku)) throw new Error(`CSV includes SKU ${sku} more than once.`);
    seen.add(sku);
    return { sku, cogsUsd, line };
  });
}

function validEffectiveAt(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export async function action({ request }: ActionFunctionArgs) {
  return withShopContext(request, (ctx) => updateCosts(request, ctx));
}

async function updateCosts(request: Request, ctx: ShopContext) {
  await requireRecentReauthentication(request, ctx.user);
  await requireActivePlan(ctx, request);
  const { shop } = ctx;
  const form = await request.formData();
  const intent = form.get("intent");

  try {
    if (intent === "bulk-assign-missing-cogs") {
      const parsed = BulkCostEdit.safeParse({
        variantIds: [...new Set(form.getAll("variantIds").map(String))],
        unitCost: form.get("unitCost"),
        effectiveAt: form.get("effectiveAt"),
      });
      if (!parsed.success) {
        return { ok: false, message: "Choose missing variants, a positive COGS value and a valid date." };
      }
      const effectiveAt = validEffectiveAt(parsed.data.effectiveAt);
      if (!effectiveAt) return { ok: false, message: "That effective date isn't a real date." };

      const variants = await prisma.$transaction(async (tx) => {
        const selected = await tx.variant.findMany({
          where: { shopId: shop.id, id: { in: parsed.data.variantIds } },
          select: { id: true, unitCost: true },
        });
        if (
          selected.length !== parsed.data.variantIds.length ||
          selected.some((variant) => variant.unitCost !== null)
        ) {
          throw new Error(
            "One or more selected variants already has COGS or is not in this store. Refresh before trying again.",
          );
        }

        for (const variant of selected) {
          await recordVariantCost(
            {
              shopId: shop.id,
              variantId: variant.id,
              unitCostMicros: toMicros(parsed.data.unitCost),
              effectiveAt,
              source: CostSource.MANUAL,
              note: "Bulk COGS assignment",
            },
            tx,
          );
        }
        return selected;
      });
      return {
        ok: true,
        message: `${variants.length.toLocaleString()} missing COGS ${variants.length === 1 ? "value was" : "values were"} saved. ${effectiveAt.getTime() < Date.now() ? "Use Restate History to apply this correction to prior orders." : "New orders will use this cost from the effective date."}`,
      };
    }

    if (intent === "upload-missing-cogs") {
      const upload = form.get("cogsFile");
      const effectiveAt = validEffectiveAt(String(form.get("effectiveAt") ?? ""));
      if (!(upload instanceof File) || upload.size === 0) {
        return { ok: false, message: "Choose a CSV file to upload." };
      }
      if (upload.size > COGS_CSV_MAX_BYTES) {
        return { ok: false, message: "That CSV is too large. Upload at most 2 MB at a time." };
      }
      if (!effectiveAt) return { ok: false, message: "That effective date isn't a real date." };

      const rows = parseCogsCsv(await upload.text());
      await prisma.$transaction(async (tx) => {
        const variants = await tx.variant.findMany({
          where: { shopId: shop.id, sku: { in: rows.map((row) => row.sku) } },
          select: { id: true, sku: true, unitCost: true },
        });
        const bySku = new Map<string, typeof variants>();
        for (const variant of variants) {
          if (!variant.sku) continue;
          const matches = bySku.get(variant.sku);
          if (matches) matches.push(variant);
          else bySku.set(variant.sku, [variant]);
        }
        const problems: string[] = [];
        for (const row of rows) {
          const matches = bySku.get(row.sku) ?? [];
          if (matches.length === 0) problems.push(`SKU ${row.sku} was not found`);
          else if (matches.length > 1) problems.push(`SKU ${row.sku} matches multiple variants`);
          else if (matches[0]!.unitCost !== null) problems.push(`SKU ${row.sku} already has COGS`);
        }
        if (problems.length > 0) {
          throw new Error(
            `No COGS were imported. ${problems.slice(0, 3).join("; ")}${problems.length > 3 ? `; and ${problems.length - 3} more.` : "."}`,
          );
        }

        for (const row of rows) {
          const variant = bySku.get(row.sku)?.[0];
          if (!variant) throw new Error(`SKU ${row.sku} disappeared before it could be updated.`);
          await recordVariantCost(
            {
              shopId: shop.id,
              variantId: variant.id,
              unitCostMicros: toMicros(row.cogsUsd),
              effectiveAt,
              source: CostSource.MANUAL,
              note: `CSV COGS import (line ${row.line})`,
            },
            tx,
          );
        }
      });
      return {
        ok: true,
        message: `${rows.length.toLocaleString()} SKU ${rows.length === 1 ? "was" : "were"} assigned COGS. ${effectiveAt.getTime() < Date.now() ? "Use Restate History to apply this correction to prior orders." : "New orders will use these costs from the effective date."}`,
      };
    }

    if (intent === "save-cost") {
      const parsed = CostEdit.safeParse({
        variantId: form.get("variantId"),
        unitCost: form.get("unitCost"),
        effectiveAt: form.get("effectiveAt"),
        note: form.get("note") || undefined,
      });
      if (!parsed.success) {
        return { ok: false, message: "That cost or date doesn't look right." };
      }

      // Scoped to the shop so a variant id from elsewhere cannot be edited.
      const variant = await prisma.variant.findFirst({
        where: { id: parsed.data.variantId, shopId: shop.id },
        select: { id: true },
      });
      if (!variant) return { ok: false, message: "Variant not found." };

      const effectiveAt = new Date(parsed.data.effectiveAt);
      if (Number.isNaN(effectiveAt.getTime())) {
        return { ok: false, message: "That effective date isn't a real date." };
      }

      const result = await recordVariantCost({
        shopId: shop.id,
        variantId: variant.id,
        unitCostMicros: toMicros(parsed.data.unitCost),
        effectiveAt,
        source: CostSource.MANUAL,
        note: parsed.data.note ?? null,
      });

      if (!result.divergedFrom) {
        return { ok: true, message: "Saved. That cost was already in effect." };
      }

      const reachesBack = result.divergedFrom.getTime() < Date.now();
      return {
        ok: true,
        message: reachesBack
          ? `Saved. This changes the cost basis from ${result.divergedFrom
              .toISOString()
              .slice(
                0,
                10,
              )}. Reported figures have not moved — use Restate History to apply it.`
          : "Saved. It takes effect from the date you chose; nothing historical has changed.",
        divergedFrom: result.divergedFrom.toISOString(),
      };
    }

    if (intent === "restate") {
      const from = new Date(String(form.get("from") ?? ""));
      if (Number.isNaN(from.getTime())) {
        return { ok: false, message: "Pick a date to restate from." };
      }
      await enqueueRestatement({
        shopId: shop.id,
        from,
        reason: String(form.get("reason") || "Merchant cost correction"),
        includeClosedPeriods: form.get("includeClosed") === "on",
      });
      return {
        ok: true,
        message:
          "Restatement queued. Each affected month is frozen as it stands before anything moves.",
      };
    }

    if (intent === "detect-bundles") {
      await enqueueBundleDetection(shop.id);
      return {
        ok: true,
        message: "Scanning the catalog. Anything found appears here to review.",
      };
    }

    if (intent === "confirm-bundle") {
      await confirmBundleComponent(shop.id, String(form.get("id")));
      return { ok: true, message: "Mapping confirmed. Costs are re-deriving." };
    }

    if (intent === "remove-bundle") {
      await removeBundleComponent(shop.id, String(form.get("id")));
      return { ok: true, message: "Mapping removed." };
    }

    if (intent === "add-bundle") {
      const parsed = BundleEdit.safeParse({
        bundleVariantId: form.get("bundleVariantId"),
        componentVariantId: form.get("componentVariantId"),
        quantity: form.get("quantity"),
      });
      if (!parsed.success) {
        return {
          ok: false,
          message: "Pick two variants and a whole quantity.",
        };
      }
      await upsertBundleComponent({ shopId: shop.id, ...parsed.data });
      return { ok: true, message: "Mapping saved. Costs are re-deriving." };
    }

    if (intent === "close-period") {
      await closePeriod(shop.id, String(form.get("periodKey")));
      return {
        ok: true,
        message: "Period closed. Its figures are now locked.",
      };
    }

    if (intent === "reopen-period") {
      await reopenPeriod(shop.id, String(form.get("periodKey")));
      return { ok: true, message: "Period reopened." };
    }
  } catch (error) {
    return {
      ok: false,
      message: error instanceof Error ? error.message : "That didn't work.",
    };
  }

  return { ok: false, message: "Unrecognised request." };
}

export default function Costs() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return <CostsView data={data} result={result ?? null} busy={busy} />;
}

export function ErrorBoundary() {
  const error = useRouteError();
  const detail = isRouteErrorResponse(error)
    ? error.status === 403
      ? "You no longer have permission to edit costs for this store."
      : error.status === 404
        ? "This cost record is no longer available."
        : "Costs could not be loaded right now."
    : "Costs could not be loaded right now. Your saved COGS values have not changed.";
  return (
    <Card title="Costs Unavailable">
      <p className="muted" style={{ margin: 0 }}>{detail}</p>
      <p style={{ marginBottom: 0 }}><a className="btn sm" href="/app/costs">Try Again</a></p>
    </Card>
  );
}

type CostsData = Awaited<ReturnType<typeof loader>>;
type CostsResult = { ok: boolean; message: string } | null;

function money(value: string | null, currency: string): string {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
    // Costs are stored at 4dp, and a landed cost of $1.2375 is a real number a
    // merchant typed. Rounding it to $1.24 on the page it is edited on would
    // make them think it had been rounded in the maths too.
    maximumFractionDigits: 4,
  }).format(Number(value));
}

/**
 * A labelled control in the app's own chrome.
 *
 * Deliberately the same shape as the one in Settings: `.field-input` carries
 * the tinted surface, the focus ring and the tabular figures, so a cost typed
 * here looks like part of the app rather than a browser default dropped into it.
 */
function Field({
  label,
  name,
  type,
  defaultValue,
  step,
  min,
  maxLength,
  placeholder,
  required,
  width,
}: {
  label: string;
  name: string;
  type: "date" | "text" | "number";
  defaultValue?: string;
  step?: string;
  min?: string;
  maxLength?: number;
  placeholder?: string;
  required?: boolean;
  width?: number;
}) {
  if (type === "date") {
    return (
      <MeridianDateField
        label={label}
        name={name}
        defaultValue={defaultValue}
        required={required}
        width={width}
      />
    );
  }

  return (
    <label className="stack" style={{ gap: 4 }}>
      <span className="tiny muted">{label}</span>
      <input
        className="field-input"
        type={type}
        name={name}
        defaultValue={defaultValue}
        step={step}
        min={min}
        maxLength={maxLength}
        placeholder={placeholder}
        required={required}
        style={width ? { width } : undefined}
      />
    </label>
  );
}

function dateFromValue(value: string | undefined): Date {
  const [year, month, day] = (value ?? "").split("-").map(Number);
  if (!year || !month || !day) return new Date();
  return new Date(year, month - 1, day);
}

function toDateValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function displayDate(value: string): string {
  const date = dateFromValue(value);
  return new Intl.DateTimeFormat("en-US", {
    month: "2-digit",
    day: "2-digit",
    year: "numeric",
  }).format(date);
}

function MeridianDateField({
  label,
  name,
  defaultValue,
  required,
  width,
}: {
  label: string;
  name: string;
  defaultValue?: string;
  required?: boolean;
  width?: number;
}) {
  const initialValue = defaultValue ?? toDateValue(new Date());
  const [value, setValue] = useState(initialValue);
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => dateFromValue(initialValue));
  const rootRef = useRef<HTMLDivElement>(null);
  const labelId = `${name}-label`;

  useEffect(() => {
    const dismiss = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", dismiss);
    return () => document.removeEventListener("mousedown", dismiss);
  }, []);

  const year = month.getFullYear();
  const monthIndex = month.getMonth();
  const firstDay = new Date(year, monthIndex, 1).getDay();
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const monthName = new Intl.DateTimeFormat("en-US", {
    month: "long",
    year: "numeric",
  }).format(month);
  const selectedValue = dateFromValue(value);

  const changeMonth = (offset: number) => {
    setMonth((current) => new Date(current.getFullYear(), current.getMonth() + offset, 1));
  };

  const choose = (day: number) => {
    const next = new Date(year, monthIndex, day);
    setValue(toDateValue(next));
    setOpen(false);
  };

  return (
    <div
      className="stack meridian-date-field"
      style={{ gap: 4, width: width ? `${width}px` : undefined }}
      ref={rootRef}
    >
      <span id={labelId} className="tiny muted">{label}</span>
      <input type="hidden" name={name} value={value} required={required} />
      <button
        type="button"
        className="field-input meridian-date-trigger"
        aria-labelledby={labelId}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{displayDate(value)}</span>
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden="true">
          <rect x="4" y="5" width="16" height="15" rx="1" />
          <path d="M8 3v4M16 3v4M4 10h16" />
        </svg>
      </button>
      {open && (
        <div className="meridian-calendar" role="dialog" aria-label={`Choose date for ${label}`}>
          <div className="meridian-calendar-head">
            <button type="button" aria-label="Previous Month" onClick={() => changeMonth(-1)}>‹</button>
            <strong>{monthName}</strong>
            <button type="button" aria-label="Next Month" onClick={() => changeMonth(1)}>›</button>
          </div>
          <div className="meridian-calendar-grid" role="grid" aria-label={monthName}>
            {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, index) => (
              <span className="meridian-calendar-weekday" key={`${day}-${index}`}>{day}</span>
            ))}
            {Array.from({ length: firstDay }, (_, index) => (
              <span aria-hidden="true" key={`empty-${index}`} />
            ))}
            {Array.from({ length: daysInMonth }, (_, index) => {
              const day = index + 1;
              const isSelected =
                selectedValue.getFullYear() === year &&
                selectedValue.getMonth() === monthIndex &&
                selectedValue.getDate() === day;
              const today = new Date();
              const isToday =
                today.getFullYear() === year &&
                today.getMonth() === monthIndex &&
                today.getDate() === day;
              return (
                <button
                  type="button"
                  role="gridcell"
                  key={day}
                  className={isSelected ? "selected" : isToday ? "today" : undefined}
                  aria-label={`${monthName} ${day}`}
                  aria-pressed={isSelected}
                  onClick={() => choose(day)}
                >
                  {day}
                </button>
              );
            })}
          </div>
          <button
            type="button"
            className="meridian-calendar-today"
            onClick={() => {
              const today = new Date();
              setMonth(new Date(today.getFullYear(), today.getMonth(), 1));
              setValue(toDateValue(today));
              setOpen(false);
            }}
          >
            Today
          </button>
        </div>
      )}
    </div>
  );
}

function VariantPicker({
  label,
  name,
  variants,
}: {
  label: string;
  name: string;
  variants: CostsData["variants"];
}) {
  return (
    <label className="stack" style={{ gap: 4 }}>
      <span className="tiny muted">{label}</span>
      <select
        className="field-input"
        name={name}
        required
        style={{ width: 260 }}
      >
        <option value="">Choose A Variant…</option>
        {variants.map((variant) => (
          <option key={variant.id} value={variant.id}>
            {variant.label}
          </option>
        ))}
      </select>
    </label>
  );
}

const SOURCE_LABEL: Record<string, string> = {
  SHOPIFY: "Shopify",
  MANUAL: "You",
  ESTIMATED: "Estimated",
  BUNDLE_ROLLUP: "Bundle rollup",
  SKU_PATTERN: "SKU pattern",
  TITLE_PATTERN: "Title pattern",
  SHOPIFY_BUNDLE: "Shopify bundle",
};

const JOB_LABEL: Record<string, string> = {
  COST_RESTATEMENT: "Restate History",
  BUNDLE_ROLLUP: "Re-derive bundle costs",
  BUNDLE_DETECTION: "Scan for bundles",
};

export function CostsView({
  data,
  result,
  busy,
}: {
  data: CostsData;
  result: CostsResult;
  busy: boolean;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const activeJobs = data.jobs.filter(
    (job) => job.status === "QUEUED" || job.status === "RUNNING",
  );
  // The fallback keeps the presentational component resilient to a cached
  // loader payload from immediately before this counter was added.
  const missingCogsVariants = data.variants.filter(
    (variant) => variant.needsCogs ?? variant.unitCost === null,
  );
  const missingCogsCount = data.missingCogsCount ?? missingCogsVariants.length;

  return (
    <>
      {result && (
        <Banner tone={result.ok ? "neutral" : "warn"}>{result.message}</Banner>
      )}

      <Banner tone="neutral">
        Saving a cost records what a variant cost from a date onward. It does
        not move a figure you have already reported — restating history is the
        separate action below, it freezes each affected month before it changes
        anything, and it refuses to touch a closed period.
      </Banner>

      {activeJobs.length > 0 && (
        <Banner tone="neutral">
          {activeJobs.length === 1
            ? "A recalculation is"
            : `${activeJobs.length} recalculations are`}{" "}
          running in the background:{" "}
          {activeJobs.map((job) => JOB_LABEL[job.kind] ?? job.kind).join(", ")}.
          Figures update when it finishes.
        </Banner>
      )}

      <Card
        title="Fix Missing COGS"
        hint="A missing Shopify cost_per_item is never counted as $0. Select variants to assign one shared COGS value, or upload a two-column CSV with the exact header sku,cogs_usd. Existing COGS are never overwritten by this bulk fixer."
      >
        {missingCogsCount === 0 ? (
          <Empty>Every Imported Variant Has A Current COGS Value.</Empty>
        ) : (
          <div className="stack" style={{ gap: 20 }}>
            <p className="tiny muted" style={{ margin: 0 }}>
              {missingCogsCount.toLocaleString()} variant{missingCogsCount === 1 ? " needs" : "s need"} COGS.
            </p>
            <Form method="post" className="stack">
              <input type="hidden" name="intent" value="bulk-assign-missing-cogs" />
              <label className="stack" style={{ gap: 4 }}>
                <span className="tiny muted">Missing Variants</span>
                <select className="field-input" name="variantIds" multiple required size={Math.min(8, Math.max(3, missingCogsVariants.length))}>
                  {missingCogsVariants.map((variant) => (
                    <option key={variant.id} value={variant.id}>{variant.label}</option>
                  ))}
                </select>
              </label>
              <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
                <Field label="COGS Per Item" name="unitCost" type="number" min="0.0001" step="0.0001" required width={160} />
                <Field label="Effective From" name="effectiveAt" type="date" defaultValue={today} required width={160} />
                <button className="btn primary" disabled={busy}>Assign COGS</button>
              </div>
            </Form>
            <Form method="post" encType="multipart/form-data" className="stack">
              <input type="hidden" name="intent" value="upload-missing-cogs" />
              <div className="row" style={{ gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
                <label className="stack" style={{ gap: 4, flex: "1 1 260px" }}>
                  <span className="tiny muted">CSV File</span>
                  <input className="field-input" type="file" name="cogsFile" accept=".csv,text/csv" required />
                </label>
                <Field label="Effective From" name="effectiveAt" type="date" defaultValue={today} required width={160} />
                <button className="btn sm" disabled={busy}>Upload COGS CSV</button>
              </div>
            </Form>
          </div>
        )}
      </Card>

      <Card
        title="Restate History"
        hint="Re-derives every order's COGS from the cost timeline as it stood on the day that order was placed, then re-materialises profit. Each affected month is frozen as-reported first."
      >
        <Form method="post" className="stack">
          <input type="hidden" name="intent" value="restate" />
          <span className="row" style={{ gap: 16, flexWrap: "wrap" }}>
            <Field
              label="Restate From"
              name="from"
              type="date"
              defaultValue={today}
              required
              width={150}
            />
            <Field
              label="Reason (Optional)"
              name="reason"
              type="text"
              maxLength={200}
              width={260}
            />
            <label
              className="row"
              style={{ gap: 6, alignSelf: "flex-end", paddingBottom: 8 }}
            >
              <input type="checkbox" name="includeClosed" />
              <span className="tiny muted">Include Closed Periods</span>
            </label>
          </span>
          <button className="btn primary" disabled={busy}>
            Restate History
          </button>
        </Form>
      </Card>

      <Card
        title="Cost History"
        hint={
          data.variantCount > data.variantsShown
            ? `Showing ${data.variantsShown.toLocaleString()} of ${data.variantCount.toLocaleString()} variants.`
            : "Each saved cost is effective from the date you give it. Backdating is how you correct a cost that was wrong at the time."
        }
        flush
      >
        {data.variants.length === 0 ? (
          <Empty>No Variants Have Been Imported Yet.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Variant</th>
                  <th className="right">Cost Today</th>
                  <th>Source</th>
                  <th>History</th>
                  <th>New Cost</th>
                </tr>
              </thead>
              <tbody>
                {data.variants.map((variant) => (
                  <tr key={variant.id}>
                    <td className="primary-cell">{variant.label}</td>
                    <td className="right num">
                      {money(variant.unitCost, data.currency)}
                    </td>
                    <td>
                      <Badge
                        tone={(variant.needsCogs ?? variant.unitCost === null) ? "critical" : variant.costSource === "ESTIMATED" ? "warning" : "neutral"}
                      >
                        {(variant.needsCogs ?? variant.unitCost === null)
                          ? "Needs COGS"
                          : SOURCE_LABEL[variant.costSource] ?? variant.costSource}
                      </Badge>
                    </td>
                    <td>
                      {variant.history.length === 0 ? (
                        <span className="cell-sub">No History</span>
                      ) : (
                        <div className="cell-sub">
                          {variant.history.slice(0, 4).map((version) => (
                            <div key={version.id}>
                              {version.effectiveAt.slice(0, 10)} ·{" "}
                              {money(version.unitCost, data.currency)} ·{" "}
                              {SOURCE_LABEL[version.source] ?? version.source}
                            </div>
                          ))}
                          {variant.history.length > 4 && (
                            <div>+{variant.history.length - 4} earlier</div>
                          )}
                        </div>
                      )}
                    </td>
                    <td>
                      <Form
                        method="post"
                        className="row"
                        style={{ gap: 6, flexWrap: "wrap" }}
                      >
                        <input type="hidden" name="intent" value="save-cost" />
                        <input
                          type="hidden"
                          name="variantId"
                          value={variant.id}
                        />
                        <input
                          className="field-input"
                          type="number"
                          name="unitCost"
                          step="0.0001"
                          min="0"
                          required
                          style={{ width: 96 }}
                          aria-label={`New Unit Cost For ${variant.label}`}
                        />
                        <input
                          className="field-input"
                          type="date"
                          name="effectiveAt"
                          defaultValue={today}
                          required
                          style={{ width: 140 }}
                          aria-label={`Effective From, For ${variant.label}`}
                        />
                        <input
                          className="field-input"
                          type="text"
                          name="note"
                          maxLength={200}
                          placeholder="Note"
                          style={{ width: 130 }}
                          aria-label={`Note for ${variant.label}`}
                        />
                        <button className="btn sm" disabled={busy}>
                          Save
                        </button>
                      </Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Bundles & Multi-Packs"
        hint="A multi-pack costs what its components cost. Map one once and every future component cost change flows through it automatically, at every level of nesting."
      >
        <Form method="post" className="stack">
          <input type="hidden" name="intent" value="detect-bundles" />
          <button className="btn" disabled={busy}>
            Scan the Catalog for Multi-Packs
          </button>
        </Form>

        {data.proposals.length > 0 && (
          <div className="table-wrap" style={{ marginTop: "1rem" }}>
            <table className="data">
              <thead>
                <tr>
                  <th>Proposed Bundle</th>
                  <th>Contains</th>
                  <th className="right">Qty</th>
                  <th>Why</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.proposals.map((proposal) => (
                  <tr key={proposal.id}>
                    <td className="primary-cell">{proposal.bundle}</td>
                    <td>{proposal.component}</td>
                    <td className="right num">{proposal.quantity}</td>
                    <td className="cell-sub">{proposal.evidence}</td>
                    <td>
                      <Form method="post" className="row" style={{ gap: 6 }}>
                        <input type="hidden" name="id" value={proposal.id} />
                        <button
                          className="btn sm primary"
                          name="intent"
                          value="confirm-bundle"
                          disabled={busy}
                        >
                          Confirm
                        </button>
                        <button
                          className="btn sm ghost"
                          name="intent"
                          value="remove-bundle"
                          disabled={busy}
                        >
                          Dismiss
                        </button>
                      </Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="table-wrap" style={{ marginTop: "1rem" }}>
          <table className="data">
            <thead>
              <tr>
                <th>Bundle</th>
                <th>Contains</th>
                <th className="right">Qty</th>
                <th>Source</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {data.mappings.length === 0 ? (
                <tr>
                  <td colSpan={5}>
                    <Empty>No Confirmed Bundle Mappings Yet.</Empty>
                  </td>
                </tr>
              ) : (
                data.mappings.map((mapping) => (
                  <tr key={mapping.id}>
                    <td className="primary-cell">{mapping.bundle}</td>
                    <td>{mapping.component}</td>
                    <td className="right num">{mapping.quantity}</td>
                    <td>{SOURCE_LABEL[mapping.source] ?? mapping.source}</td>
                    <td>
                      <Form method="post">
                        <input
                          type="hidden"
                          name="intent"
                          value="remove-bundle"
                        />
                        <input type="hidden" name="id" value={mapping.id} />
                        <button className="btn sm ghost" disabled={busy}>
                          Remove
                        </button>
                      </Form>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <Form method="post" className="stack" style={{ marginTop: 18 }}>
          <input type="hidden" name="intent" value="add-bundle" />
          <span className="row" style={{ gap: 16, flexWrap: "wrap" }}>
            <VariantPicker
              label="Bundle"
              name="bundleVariantId"
              variants={data.variants}
            />
            <VariantPicker
              label="Contains"
              name="componentVariantId"
              variants={data.variants}
            />
            <Field
              label="Quantity"
              name="quantity"
              type="number"
              min="1"
              step="1"
              defaultValue="3"
              required
              width={90}
            />
          </span>
          <button className="btn primary" disabled={busy}>
            Add Mapping
          </button>
        </Form>
      </Card>

      <Card
        title="Reported Periods"
        hint="What each month said when it was frozen. These figures never change; a restatement records its effect separately. Closing a month refuses any later restatement that would move it."
        flush
      >
        {data.periods.length === 0 ? (
          <Empty>
            No month has been frozen yet. The first restatement or period close
            captures one.
          </Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Month</th>
                  <th></th>
                  <th className="right">Orders</th>
                  <th className="right">Revenue as Reported</th>
                  <th className="right">COGS as Reported</th>
                  <th className="right">Net Profit as Reported</th>
                  <th className="right">Restatements</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {data.periods.map((period) => (
                  <tr key={period.periodKey}>
                    <td className="primary-cell">{period.periodKey}</td>
                    <td>
                      <Badge
                        tone={
                          period.status === PeriodStatus.CLOSED
                            ? "good"
                            : "neutral"
                        }
                      >
                        {period.status === PeriodStatus.CLOSED
                          ? "Closed"
                          : "Open"}
                      </Badge>
                    </td>
                    <td className="right num">
                      {period.orderCount.toLocaleString()}
                    </td>
                    <td className="right">
                      {money(period.netRevenue, data.currency)}
                    </td>
                    <td className="right muted">
                      {money(period.cogs, data.currency)}
                    </td>
                    <td className="right">
                      {money(period.netProfit, data.currency)}
                    </td>
                    <td className="right num">{period.restatementCount}</td>
                    <td>
                      <Form method="post">
                        <input
                          type="hidden"
                          name="periodKey"
                          value={period.periodKey}
                        />
                        <button
                          className="btn sm ghost"
                          name="intent"
                          value={
                            period.status === PeriodStatus.CLOSED
                              ? "reopen-period"
                              : "close-period"
                          }
                          disabled={busy}
                        >
                          {period.status === PeriodStatus.CLOSED
                            ? "Reopen"
                            : "Close"}
                        </button>
                      </Form>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      <Card
        title="Restatement History"
        hint="Append-only. Every correction that moved a month, and by how much."
        flush
      >
        {data.restatements.length === 0 ? (
          <Empty>No History Has Been Restated.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Applied</th>
                  <th>Month</th>
                  <th>Reason</th>
                  <th className="right">Orders</th>
                  <th className="right">COGS Before</th>
                  <th className="right">COGS After</th>
                  <th className="right">Net Profit Change</th>
                </tr>
              </thead>
              <tbody>
                {data.restatements.map((row) => {
                  const delta =
                    Number(row.netProfitAfter) - Number(row.netProfitBefore);
                  return (
                    <tr key={row.id}>
                      <td>{row.appliedAt.slice(0, 10)}</td>
                      <td className="primary-cell">{row.periodKey}</td>
                      <td className="cell-sub">{row.reason}</td>
                      <td className="right num">
                        {row.ordersAffected.toLocaleString()}
                      </td>
                      <td className="right muted">
                        {money(row.cogsBefore, data.currency)}
                      </td>
                      <td className="right muted">
                        {money(row.cogsAfter, data.currency)}
                      </td>
                      <td className="right">
                        <Money
                          cents={Math.round(delta * 100)}
                          currency={data.currency}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {data.jobs.length > 0 && (
        <Card
          title="Background Recalculations"
          hint="Restatements and bundle rollups run off the request thread and survive a deploy."
          flush
        >
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Queued</th>
                  <th>Work</th>
                  <th>Status</th>
                  <th className="right">Attempts</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {data.jobs.map((job) => (
                  <tr key={job.id}>
                    <td>{job.createdAt.slice(0, 16).replace("T", " ")}</td>
                    <td className="primary-cell">
                      {JOB_LABEL[job.kind] ?? job.kind}
                    </td>
                    <td>
                      <Badge
                        tone={
                          job.status === "FAILED"
                            ? "critical"
                            : job.status === "COMPLETE"
                              ? "good"
                              : "neutral"
                        }
                      >
                        {job.status}
                      </Badge>
                    </td>
                    <td className="right num">{job.attempts}</td>
                    <td className="cell-sub">{job.error ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}
