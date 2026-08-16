import { CostRuleKind } from "@prisma/client";
import {
  Form,
  isRouteErrorResponse,
  redirect,
  useActionData,
  useLoaderData,
  useNavigation,
  useRouteError,
  type ActionFunctionArgs,
  type LoaderFunctionArgs,
} from "react-router";

import prisma from "~/db.server";
import { Banner, Card, Money, Stat } from "~/design/components";
import { withShopContext, type ShopContext } from "~/lib/auth.server";
import { requireRecentReauthentication } from "~/lib/reauth.server";
import { enqueueShopRecompute } from "~/lib/recompute-queue.server";

const DAY_MS = 24 * 60 * 60 * 1_000;

export async function loader({ request }: LoaderFunctionArgs) {
  return withShopContext(request, (ctx) => loadOnboarding(ctx));
}

async function loadOnboarding({ shop }: ShopContext) {
  if (shop.isDemo || shop.onboardingStep === "complete") {
    throw redirect("/app");
  }
  const since = new Date(Date.now() - 30 * DAY_MS);
  const [totals, missingCostLines, rules] = await Promise.all([
    prisma.order.aggregate({
      where: { shopId: shop.id, processedAt: { gte: since } },
      _count: { _all: true },
      _sum: { total: true, netProfit: true },
    }),
    prisma.orderLineItem.count({
      where: {
        shopId: shop.id,
        cogsKnown: false,
        quantity: { gt: 0 },
        order: { processedAt: { gte: since } },
      },
    }),
    prisma.costRule.findMany({
      where: { shopId: shop.id, active: true },
      orderBy: { kind: "asc" },
    }),
  ]);
  const rule = (kind: CostRuleKind) => rules.find((item) => item.kind === kind);
  return {
    shopName: shop.name,
    currency: shop.currency,
    syncStatus: shop.syncStatus,
    syncStage: shop.syncStage,
    orders: totals._count._all,
    awaitingFirstOrder:
      shop.syncStatus === "COMPLETE" && totals._count._all === 0,
    revenueCents: Math.round(Number(totals._sum.total ?? 0) * 100),
    profitCents: Math.round(Number(totals._sum.netProfit ?? 0) * 100),
    missingCostLines,
    defaults: {
      paymentPercent:
        Number(rule(CostRuleKind.PAYMENT_FEE)?.percentRate ?? 0.029) * 100,
      paymentFixed: Number(
        rule(CostRuleKind.PAYMENT_FEE)?.fixedPerOrder ?? 0.3,
      ),
      shipping: Number(
        rule(CostRuleKind.SHIPPING_DEFAULT)?.fixedPerOrder ?? 8.5,
      ),
      pickPackOrder: Number(
        rule(CostRuleKind.PICK_PACK)?.fixedPerOrder ?? 1.75,
      ),
      pickPackItem: Number(rule(CostRuleKind.PICK_PACK)?.fixedPerItem ?? 0.35),
      overhead: Number(rule(CostRuleKind.OVERHEAD_MONTHLY)?.monthlyAmount ?? 0),
    },
  };
}

function bounded(
  form: FormData,
  key: string,
  min: number,
  max: number,
): number | null {
  const value = Number(form.get(key));
  return Number.isFinite(value) && value >= min && value <= max ? value : null;
}

export async function action({ request }: ActionFunctionArgs) {
  return withShopContext(request, (ctx) => updateOnboarding(request, ctx));
}

async function updateOnboarding(request: Request, ctx: ShopContext) {
  await requireRecentReauthentication(request, ctx.user);
  const { shop } = ctx;
  const form = await request.formData();
  const paymentPercent = bounded(form, "paymentPercent", 0, 25);
  const paymentFixed = bounded(form, "paymentFixed", 0, 100_000);
  const shipping = bounded(form, "shipping", 0, 100_000);
  const pickPackOrder = bounded(form, "pickPackOrder", 0, 100_000);
  const pickPackItem = bounded(form, "pickPackItem", 0, 100_000);
  const overhead = bounded(form, "overhead", 0, 10_000_000);
  if (
    [
      paymentPercent,
      paymentFixed,
      shipping,
      pickPackOrder,
      pickPackItem,
      overhead,
    ].some((value) => value === null)
  ) {
    return { error: "Check the cost figures and try again." };
  }
  const confirmedAt = new Date();
  // withShopContext already places this action inside the tenant transaction.
  // Do not open a nested array transaction through the scoped Prisma proxy:
  // React Router actions must see the completed shop update before following
  // their data-navigation redirect.
  const [, , , , completedShop] = await Promise.all([
    prisma.costRule.updateMany({
      where: { shopId: shop.id, kind: CostRuleKind.PAYMENT_FEE, active: true },
      data: {
        percentRate: (paymentPercent! / 100).toFixed(5),
        fixedPerOrder: paymentFixed!.toFixed(4),
        confirmedAt,
      },
    }),
    prisma.costRule.updateMany({
      where: {
        shopId: shop.id,
        kind: CostRuleKind.SHIPPING_DEFAULT,
        active: true,
      },
      data: { fixedPerOrder: shipping!.toFixed(4), confirmedAt },
    }),
    prisma.costRule.updateMany({
      where: { shopId: shop.id, kind: CostRuleKind.PICK_PACK, active: true },
      data: {
        fixedPerOrder: pickPackOrder!.toFixed(4),
        fixedPerItem: pickPackItem!.toFixed(4),
        confirmedAt,
      },
    }),
    prisma.costRule.updateMany({
      where: {
        shopId: shop.id,
        kind: CostRuleKind.OVERHEAD_MONTHLY,
        active: true,
      },
      data: { monthlyAmount: overhead!.toFixed(2), confirmedAt },
    }),
    prisma.shop.update({
      where: { id: shop.id },
      data: { onboardingStep: "complete" },
    }),
  ]);
  if (completedShop.onboardingStep !== "complete") {
    throw new Error("Onboarding completion did not persist.");
  }
  await enqueueShopRecompute(shop.id, "onboarding_costs_confirmed");
  // The first embedded document carries Shopify's signed context in its query.
  // Preserve it across this action redirect: React Router follows redirects as
  // a data request, and dropping it creates an unauthenticated request before
  // App Bridge's fetch interceptor has a chance to mint a fresh token.
  throw redirect(`/app/plan${new URL(request.url).search}`);
}

export default function Onboarding() {
  const data = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";
  return (
    <>
      <Banner>
        <strong>{data.shopName} is connected.</strong>{" "}
        {data.awaitingFirstOrder
          ? "Awaiting your first live order. The preview below is illustrative and is not included in your store’s figures."
          : data.syncStatus === "COMPLETE"
          ? `Your first figures are ready. ${data.missingCostLines > 0 ? "Start with the orders and products already visible, then improve the result by filling the missing cost inputs below." : "You can review what is making and losing money before connecting any optional source."}`
          : `The Shopify import is ${data.syncStage ?? "still running"}; figures will keep filling in.`}
      </Banner>
      {data.awaitingFirstOrder && (
        <Card
          title="Awaiting First Live Order"
          hint="This is a clearly labelled demo preview. These example values are not part of your store’s profit calculation and will be replaced as soon as Shopify sends the first order."
        >
          <div className="grid cols-3">
            <Stat small label="Example Revenue" value={<Money cents={128_000} currency={data.currency} />} />
            <Stat small label="Example COGS" value={<Money cents={49_000} currency={data.currency} />} />
            <Stat small label="Example Contribution" value={<Money cents={38_500} currency={data.currency} />} />
          </div>
        </Card>
      )}
      <div className="grid cols-4">
        <Stat
          small
          label="Orders Found · 30D"
          value={data.orders.toLocaleString()}
        />
        <Stat
          small
          label="Revenue Found · 30D"
          value={<Money cents={data.revenueCents} currency={data.currency} />}
        />
        <Stat
          small
          label="Qualified Profit · 30D"
          value={<Money cents={data.profitCents} currency={data.currency} />}
        />
        <Stat
          small
          label="Lines Missing COGS"
          value={data.missingCostLines.toLocaleString()}
        />
      </div>
      <Card
        title="Confirm The Costs Behind Your Profit"
        hint="These are configured estimates, not measured costs. Set them now to avoid false 100% margins; later, connect a carrier or ad source only when you want Meridian to replace an estimate or include that spend."
      >
        {result?.error && <Banner tone="warn">{result.error}</Banner>}
        <Form method="post" className="stack">
          <div className="grid cols-2">
            <OnboardingField
              label="Payment Rate"
              name="paymentPercent"
              defaultValue={data.defaults.paymentPercent}
              suffix="%"
              step="0.01"
            />
            <OnboardingField
              label="Payment Fee Per Order"
              name="paymentFixed"
              defaultValue={data.defaults.paymentFixed}
              prefix="$"
            />
            <OnboardingField
              label="Shipping Per Order"
              name="shipping"
              defaultValue={data.defaults.shipping}
              prefix="$"
            />
            <OnboardingField
              label="Pick And Pack Per Order"
              name="pickPackOrder"
              defaultValue={data.defaults.pickPackOrder}
              prefix="$"
            />
            <OnboardingField
              label="Materials Per Item"
              name="pickPackItem"
              defaultValue={data.defaults.pickPackItem}
              prefix="$"
            />
            <OnboardingField
              label="Fixed Monthly Overhead"
              name="overhead"
              defaultValue={data.defaults.overhead}
              prefix="$"
            />
          </div>
          <button className="btn primary" disabled={busy}>
            {busy ? "Recomputing Your Store…" : "Save Costs And Choose A Plan"}
          </button>
        </Form>
      </Card>
    </>
  );
}

export function ErrorBoundary() {
  const error = useRouteError();
  const detail = isRouteErrorResponse(error)
    ? error.status === 403
      ? "You no longer have access to complete onboarding for this store."
      : "Onboarding could not be loaded right now."
    : "Onboarding could not be loaded right now. No cost settings were changed.";
  return (
    <Card title="Onboarding Unavailable">
      <p className="muted" style={{ margin: 0 }}>{detail}</p>
      <p style={{ marginBottom: 0 }}><a className="btn sm" href="/app/onboarding">Try Again</a></p>
    </Card>
  );
}

function OnboardingField({
  label,
  name,
  defaultValue,
  prefix,
  suffix,
  step = "0.01",
}: {
  label: string;
  name: string;
  defaultValue: number;
  prefix?: string;
  suffix?: string;
  step?: string;
}) {
  return (
    <label className="stack" style={{ gap: 4 }}>
      <span className="tiny muted">{label}</span>
      <span className="row">
        {prefix && <span className="muted">{prefix}</span>}
        <input
          className="field-input"
          type="number"
          name={name}
          min="0"
          step={step}
          required
          defaultValue={defaultValue}
        />
        {suffix && <span className="muted">{suffix}</span>}
      </span>
    </label>
  );
}
