import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The historical recalculation engine and bundle rollup, against real Postgres.
 *
 * Every claim this feature makes is a claim about database state under
 * concurrent, effective-dated writes, and none of them can be proven against a
 * mock: that a backdated cost reaches exactly the months it should and no
 * further, that the figures a merchant already reported survive the correction
 * that changes them, that a closed month refuses to move, and that a component
 * cost rippling up through nested packs produces the right number at the right
 * instant.
 *
 * Skipped unless MERIDIAN_TEST_DATABASE_URL points at a migrated throwaway DB.
 */
const TEST_URL = process.env.MERIDIAN_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)(
  "cost history and restatement, against real Postgres",
  () => {
    let prisma: any;
    let recordVariantCost: any;
    let loadEffectiveCosts: any;
    let restateCosts: any;
    let closePeriod: any;
    let reopenPeriod: any;
    let readPeriodFigures: any;
    let periodsInWindow: any;
    let ClosedPeriodError: any;
    let recomputeShopProfitability: any;
    let detectBundlesForShop: any;
    let rollUpBundleCosts: any;
    let enqueueRecalcJob: any;
    let enqueueExclusiveRecalcJob: any;
    let leaseNextRecalcJob: any;
    let drainRecalcQueue: any;
    let registerRecalcHandlers: any;
    let toMicros: any;

    let shopId: string;
    let productId: string;
    let singleId: string;
    let packId: string;
    let caseId: string;
    let marchOrderId: string;
    let mayOrderId: string;

    const MARCH = new Date("2026-03-10T15:00:00.000Z");
    const MAY = new Date("2026-05-10T15:00:00.000Z");
    const EPOCH = new Date("1970-01-01T00:00:00.000Z");

    beforeAll(async () => {
      process.env.DATABASE_URL = TEST_URL;
      const { PrismaClient } = await import("@prisma/client");
      prisma = new PrismaClient({ datasources: { db: { url: TEST_URL } } });

      ({ recordVariantCost, loadEffectiveCosts } =
        await import("./cost-history.server"));
      ({
        restateCosts,
        closePeriod,
        reopenPeriod,
        readPeriodFigures,
        periodsInWindow,
        ClosedPeriodError,
      } = await import("./restatement.server"));
      ({ recomputeShopProfitability } = await import("./recompute.server"));
      ({ detectBundlesForShop, rollUpBundleCosts } =
        await import("./bundles.server"));
      ({
        enqueueRecalcJob,
        enqueueExclusiveRecalcJob,
        leaseNextRecalcJob,
        drainRecalcQueue,
      } = await import("./recalc-queue.server"));
      ({ registerRecalcHandlers } = await import("./recalc-handlers.server"));
      ({ toMicros } = await import("~/engine/money"));

      registerRecalcHandlers();

      const nonce = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
      const shop = await prisma.shop.create({
        data: {
          domain: `restate-${nonce}.myshopify.com`,
          name: "Restatement Integration",
          currency: "USD",
          // A non-UTC shop, so every month boundary in this file is a merchant
          // -local boundary rather than an accidental UTC one.
          timezone: "America/Los_Angeles",
        },
      });
      shopId = shop.id;

      const product = await prisma.product.create({
        data: {
          shopId,
          shopifyId: `gid://shopify/Product/${nonce}`,
          title: "Widget",
          handle: `widget-${nonce}`,
        },
      });
      productId = product.id;

      const [single, pack, caseOf] = await Promise.all([
        prisma.variant.create({
          data: {
            shopId,
            productId,
            shopifyId: `gid://shopify/ProductVariant/${nonce}-single`,
            sku: `WIDGET-${nonce}`,
            title: "Single",
            price: "20.00",
          },
        }),
        prisma.variant.create({
          data: {
            shopId,
            productId,
            shopifyId: `gid://shopify/ProductVariant/${nonce}-pack`,
            sku: `WIDGET-${nonce}-3PK`,
            title: "3-Pack",
            price: "54.00",
          },
        }),
        prisma.variant.create({
          data: {
            shopId,
            productId,
            shopifyId: `gid://shopify/ProductVariant/${nonce}-case`,
            sku: `WIDGET-${nonce}-3PK-X4`,
            title: "Case",
            price: "200.00",
          },
        }),
      ]);
      singleId = single.id;
      packId = pack.id;
      caseId = caseOf.id;

      await prisma.costRule.createMany({
        data: [
          {
            shopId,
            kind: "PAYMENT_FEE",
            label: "Processor",
            percentRate: "0.02900",
            fixedPerOrder: "0.3000",
          },
        ],
      });

      // The opening basis the migration would have seeded: $5.00 for all history.
      await prisma.variantCost.create({
        data: {
          shopId,
          variantId: singleId,
          unitCost: "5.0000",
          effectiveAt: EPOCH,
          source: "SHOPIFY",
        },
      });

      const orders = [
        { key: "march", processedAt: MARCH, orderNumber: 9001 },
        { key: "may", processedAt: MAY, orderNumber: 9002 },
      ];
      for (const spec of orders) {
        const order = await prisma.order.create({
          data: {
            shopId,
            shopifyId: `gid://shopify/Order/${nonce}-${spec.key}`,
            orderNumber: spec.orderNumber,
            processedAt: spec.processedAt,
            subtotal: "40.00",
            discountTotal: "0.00",
            shippingCharged: "0.00",
            taxTotal: "0.00",
            total: "40.00",
            refundedTotal: "0.00",
          },
        });
        if (spec.key === "march") marchOrderId = order.id;
        else mayOrderId = order.id;

        await prisma.orderLineItem.create({
          data: {
            shopId,
            orderId: order.id,
            shopifyId: `gid://shopify/LineItem/${nonce}-${spec.key}`,
            variantId: singleId,
            productId,
            title: "Widget",
            quantity: 2,
            unitPrice: "20.00",
            unitCost: "5.0000",
            costEffectiveAt: EPOCH,
          },
        });
      }

      await recomputeShopProfitability(shopId);
    }, 60_000);

    afterAll(async () => {
      if (!prisma) return;
      if (shopId)
        await prisma.shop.delete({ where: { id: shopId } }).catch(() => {});
      await prisma.$disconnect();
    });

    // -------------------------------------------------------------------------
    // Effective-dated resolution
    // -------------------------------------------------------------------------

    it("resolves a cost at an instant, in SQL, from the timeline", async () => {
      await recordVariantCost({
        shopId,
        variantId: singleId,
        unitCostMicros: toMicros("6.5000"),
        effectiveAt: new Date("2026-04-01T07:00:00.000Z"),
        source: "MANUAL",
        note: "April supplier increase",
      });

      const marchCosts = await loadEffectiveCosts([singleId], MARCH);
      const mayCosts = await loadEffectiveCosts([singleId], MAY);

      expect(Number(marchCosts.get(singleId).unitCost)).toBe(5);
      expect(Number(mayCosts.get(singleId).unitCost)).toBe(6.5);
    });

    it("publishes the current cost onto the catalog without disturbing history", async () => {
      const variant = await prisma.variant.findUnique({
        where: { id: singleId },
      });
      expect(Number(variant.unitCost)).toBe(6.5);
      expect(variant.costSource).toBe("MANUAL");

      // The line items still carry what they were sold at. Recording a cost is
      // not restating one.
      const marchLine = await prisma.orderLineItem.findFirst({
        where: { orderId: marchOrderId },
      });
      expect(Number(marchLine.unitCost)).toBe(5);
    });

    it("does not let a backdated correction overwrite a newer current cost", async () => {
      await recordVariantCost({
        shopId,
        variantId: singleId,
        unitCostMicros: toMicros("5.2500"),
        effectiveAt: new Date("2026-02-01T08:00:00.000Z"),
        source: "MANUAL",
        note: "Corrected opening freight",
      });

      const variant = await prisma.variant.findUnique({
        where: { id: singleId },
      });
      expect(Number(variant.unitCost)).toBe(6.5);
    });

    // -------------------------------------------------------------------------
    // Restatement
    // -------------------------------------------------------------------------

    it("freezes each affected month before it moves anything", async () => {
      const before = await readPeriodFigures(
        shopId,
        "America/Los_Angeles",
        await periodsInWindow("America/Los_Angeles", MARCH, MAY),
      );
      const marchBefore = before.get("2026-03");
      // 2 units × $5.00.
      expect(marchBefore.cogsCents).toBe(1_000);

      const summary = await restateCosts({
        shopId,
        from: new Date("2026-02-01T08:00:00.000Z"),
        reason: "Corrected supplier costs",
      });

      expect(summary.skipped).toBe(false);
      expect(summary.lineItemsAffected).toBe(2);

      const snapshots = await prisma.periodSnapshot.findMany({
        where: { shopId },
        orderBy: { periodKey: "asc" },
      });
      const marchSnapshot = snapshots.find(
        (s: any) => s.periodKey === "2026-03",
      );

      // Frozen at what March said, not at what it says now.
      expect(Number(marchSnapshot.cogs)).toBe(10);
      expect(marchSnapshot.restatementCount).toBe(1);
    }, 60_000);

    it("re-derives each order's COGS from the cost in effect on its own day", async () => {
      const [marchLine, mayLine] = await Promise.all([
        prisma.orderLineItem.findFirst({ where: { orderId: marchOrderId } }),
        prisma.orderLineItem.findFirst({ where: { orderId: mayOrderId } }),
      ]);

      // March gets the backdated February correction; May gets the April rise.
      expect(Number(marchLine.unitCost)).toBe(5.25);
      expect(Number(mayLine.unitCost)).toBe(6.5);

      expect(marchLine.costEffectiveAt.toISOString()).toBe(
        "2026-02-01T08:00:00.000Z",
      );
      expect(marchLine.costRestatedAt).not.toBeNull();
    });

    it("re-materialises profit from the restated basis", async () => {
      const march = await prisma.order.findUnique({
        where: { id: marchOrderId },
      });
      const may = await prisma.order.findUnique({ where: { id: mayOrderId } });

      expect(Number(march.cogsTotal)).toBe(10.5);
      expect(Number(may.cogsTotal)).toBe(13);
    });

    it("records what each month said before and after, and why", async () => {
      const restatements = await prisma.periodRestatement.findMany({
        where: { shopId },
        orderBy: { periodKey: "asc" },
      });

      expect(restatements.map((row: any) => row.periodKey)).toEqual([
        "2026-03",
        "2026-05",
      ]);

      const march = restatements[0];
      expect(Number(march.cogsBefore)).toBe(10);
      expect(Number(march.cogsAfter)).toBe(10.5);
      expect(march.reason).toBe("Corrected supplier costs");
      expect(march.ordersAffected).toBe(1);
      // Profit fell by exactly the extra COGS.
      expect(
        Number(march.netProfitBefore) - Number(march.netProfitAfter),
      ).toBeCloseTo(0.5, 5);
    });

    it("keeps the frozen figures untouched by the correction", async () => {
      const marchSnapshot = await prisma.periodSnapshot.findFirst({
        where: { shopId, periodKey: "2026-03" },
      });

      // The live tables now say 10.50. What March reported is still 10.00.
      expect(Number(marchSnapshot.cogs)).toBe(10);
    });

    it("is a no-op when run again with nothing left to change", async () => {
      const summary = await restateCosts({
        shopId,
        from: new Date("2026-02-01T08:00:00.000Z"),
        reason: "Repeat",
      });

      expect(summary.lineItemsAffected).toBe(0);
      expect(summary.periodsRestated).toEqual([]);

      const count = await prisma.periodRestatement.count({ where: { shopId } });
      expect(count).toBe(2);
    }, 60_000);

    // -------------------------------------------------------------------------
    // Closed periods
    // -------------------------------------------------------------------------

    it("refuses a restatement that reaches into a closed month", async () => {
      await closePeriod(shopId, "2026-03");

      await recordVariantCost({
        shopId,
        variantId: singleId,
        unitCostMicros: toMicros("4.0000"),
        effectiveAt: new Date("2026-03-01T08:00:00.000Z"),
        source: "MANUAL",
      });

      await expect(
        restateCosts({
          shopId,
          from: new Date("2026-03-01T08:00:00.000Z"),
          reason: "Should be refused",
        }),
      ).rejects.toThrow(ClosedPeriodError);
    });

    it("refuses before writing anything, so a multi-month window cannot half-apply", async () => {
      const marchLine = await prisma.orderLineItem.findFirst({
        where: { orderId: marchOrderId },
      });
      const mayLine = await prisma.orderLineItem.findFirst({
        where: { orderId: mayOrderId },
      });

      // May is open and would have been rewritten had the refusal come mid-run.
      expect(Number(marchLine.unitCost)).toBe(5.25);
      expect(Number(mayLine.unitCost)).toBe(6.5);
    });

    it("applies once the merchant confirms closed periods explicitly", async () => {
      const summary = await restateCosts({
        shopId,
        from: new Date("2026-03-01T08:00:00.000Z"),
        reason: "Authorised correction",
        includeClosedPeriods: true,
      });

      expect(summary.lineItemsAffected).toBe(1);

      const marchLine = await prisma.orderLineItem.findFirst({
        where: { orderId: marchOrderId },
      });
      expect(Number(marchLine.unitCost)).toBe(4);

      // And the originally reported figure still survives both restatements.
      const snapshot = await prisma.periodSnapshot.findFirst({
        where: { shopId, periodKey: "2026-03" },
      });
      expect(Number(snapshot.cogs)).toBe(10);
      expect(snapshot.restatementCount).toBe(2);
      expect(snapshot.status).toBe("CLOSED");
    }, 60_000);

    it("reopens a period on request", async () => {
      await reopenPeriod(shopId, "2026-03");
      const snapshot = await prisma.periodSnapshot.findFirst({
        where: { shopId, periodKey: "2026-03" },
      });
      expect(snapshot.status).toBe("OPEN");
      expect(snapshot.closedAt).toBeNull();
    });

    // -------------------------------------------------------------------------
    // Bundles
    // -------------------------------------------------------------------------

    it("proposes multi-pack mappings from the SKU convention, unconfirmed", async () => {
      const result = await detectBundlesForShop(shopId);
      expect(result.proposed).toBeGreaterThanOrEqual(2);

      const edges = await prisma.bundleComponent.findMany({
        where: { shopId },
      });
      expect(edges.every((edge: any) => edge.confirmedAt === null)).toBe(true);

      const pack = edges.find((edge: any) => edge.bundleVariantId === packId);
      expect(pack.componentVariantId).toBe(singleId);
      expect(pack.quantity).toBe(3);

      const caseEdge = edges.find(
        (edge: any) => edge.bundleVariantId === caseId,
      );
      expect(caseEdge.componentVariantId).toBe(packId);
      expect(caseEdge.quantity).toBe(4);
    });

    it("derives no cost from an unconfirmed proposal", async () => {
      await rollUpBundleCosts(shopId);
      const derived = await prisma.variantCost.count({
        where: { shopId, source: "BUNDLE_ROLLUP" },
      });
      expect(derived).toBe(0);
    });

    it("derives the pack and the case once the mappings are confirmed", async () => {
      await prisma.bundleComponent.updateMany({
        where: { shopId },
        data: { confirmedAt: new Date() },
      });

      const result = await rollUpBundleCosts(shopId);
      expect(result.problems).toEqual([]);
      expect(result.resolved).toBe(2);

      // The single's timeline: 5.00 from the epoch, 5.25 from Feb, 4.00 from
      // March, 6.50 from April. The pack is 3× that at every instant, and the
      // case is 4× the pack.
      const packAtMay = await loadEffectiveCosts([packId], MAY);
      const caseAtMay = await loadEffectiveCosts([caseId], MAY);
      expect(Number(packAtMay.get(packId).unitCost)).toBe(19.5);
      expect(Number(caseAtMay.get(caseId).unitCost)).toBe(78);

      const packAtMarch = await loadEffectiveCosts([packId], MARCH);
      expect(Number(packAtMarch.get(packId).unitCost)).toBe(12);
    }, 60_000);

    it("ripples a component change up through every level of nesting", async () => {
      await recordVariantCost({
        shopId,
        variantId: singleId,
        unitCostMicros: toMicros("7.0000"),
        effectiveAt: new Date("2026-07-01T07:00:00.000Z"),
        source: "MANUAL",
      });
      await rollUpBundleCosts(shopId);

      const july = new Date("2026-07-15T12:00:00.000Z");
      const packCosts = await loadEffectiveCosts([packId, caseId], july);
      expect(Number(packCosts.get(packId).unitCost)).toBe(21);
      expect(Number(packCosts.get(caseId).unitCost)).toBe(84);
    }, 60_000);

    it("withdraws a derived cost when its mapping is removed", async () => {
      await prisma.bundleComponent.deleteMany({
        where: { shopId, bundleVariantId: packId },
      });
      const result = await rollUpBundleCosts(shopId);

      // The case now depends on a pack with no resolvable cost.
      expect(
        result.problems.some((p: any) => p.bundleVariantId === caseId),
      ).toBe(true);
      const derivedForPack = await prisma.variantCost.count({
        where: { shopId, variantId: packId, source: "BUNDLE_ROLLUP" },
      });
      expect(derivedForPack).toBe(0);
    }, 60_000);

    // -------------------------------------------------------------------------
    // The durable queue
    // -------------------------------------------------------------------------

    it("leases a queued job exactly once across contending workers", async () => {
      const job = await enqueueRecalcJob({
        shopId,
        kind: "BUNDLE_DETECTION",
        payload: {},
        dedupeKey: `lease-test:${shopId}`,
      });

      const [a, b] = await Promise.all([
        leaseNextRecalcJob(),
        leaseNextRecalcJob(),
      ]);
      const winners = [a, b].filter((claim) => claim?.job.id === job.id);
      expect(winners).toHaveLength(1);
      expect(winners[0].attempt).toBe(1);

      await prisma.recalcJob.delete({ where: { id: job.id } });
    });

    it("collapses a burst of identical enqueues into one queued job", async () => {
      const key = `dedupe-test:${shopId}`;
      const first = await enqueueRecalcJob({
        shopId,
        kind: "BUNDLE_ROLLUP",
        payload: { round: 1 },
        dedupeKey: key,
      });
      const second = await enqueueRecalcJob({
        shopId,
        kind: "BUNDLE_ROLLUP",
        payload: { round: 2 },
        dedupeKey: key,
      });

      expect(second.id).toBe(first.id);
      expect(second.payload).toEqual({ round: 2 });

      const queued = await prisma.recalcJob.count({
        where: { shopId, dedupeKey: key },
      });
      expect(queued).toBe(1);

      await prisma.recalcJob.delete({ where: { id: first.id } });
    });

    it("creates one exclusive job across concurrent processes", async () => {
      const key = `exclusive-backfill:${shopId}`;
      const [first, second] = await Promise.all([
        enqueueExclusiveRecalcJob({
          shopId,
          kind: "HISTORICAL_BACKFILL",
          payload: { shopId },
          dedupeKey: key,
        }),
        enqueueExclusiveRecalcJob({
          shopId,
          kind: "HISTORICAL_BACKFILL",
          payload: { shopId },
          dedupeKey: key,
        }),
      ]);

      expect([first.created, second.created].sort()).toEqual([false, true]);
      expect(first.job.id).toBe(second.job.id);
      expect(
        await prisma.recalcJob.count({ where: { shopId, dedupeKey: key } }),
      ).toBe(1);
      await prisma.recalcJob.delete({ where: { id: first.job.id } });
    });

    it("runs a queued restatement end to end and releases its dedupe key", async () => {
      await recordVariantCost({
        shopId,
        variantId: singleId,
        unitCostMicros: toMicros("8.0000"),
        effectiveAt: new Date("2026-05-01T07:00:00.000Z"),
        source: "MANUAL",
      });

      const { enqueueRestatement } = await import("./restatement.server");
      await enqueueRestatement({
        shopId,
        from: new Date("2026-05-01T07:00:00.000Z"),
        reason: "Queued end to end",
      });

      await drainRecalcQueue();

      const job = await prisma.recalcJob.findFirst({
        where: { shopId, kind: "COST_RESTATEMENT" },
        orderBy: { createdAt: "desc" },
      });
      expect(job.status).toBe("COMPLETE");
      expect(job.error).toBeNull();
      // Released, so the same work can legitimately be asked for again later.
      expect(job.dedupeKey).toBeNull();
      expect(job.result.lineItemsAffected).toBe(1);

      const mayLine = await prisma.orderLineItem.findFirst({
        where: { orderId: mayOrderId },
      });
      expect(Number(mayLine.unitCost)).toBe(8);
    }, 120_000);

    it("fails a job whose handler throws, and keeps it retryable", async () => {
      const {
        registerRecalcHandler,
        runRecalcJob,
        leaseNextRecalcJob: lease,
      } = await import("./recalc-queue.server");

      registerRecalcHandler("BUNDLE_DETECTION" as any, async () => {
        throw new Error("injected handler failure");
      });

      const job = await enqueueRecalcJob({
        shopId,
        kind: "BUNDLE_DETECTION",
        payload: {},
        dedupeKey: `fail-test:${shopId}`,
      });

      let leased = await lease();
      while (leased && leased.job.id !== job.id) leased = await lease();
      expect(leased).not.toBeNull();
      if (!leased)
        throw new Error("Expected the queued failure test job to be leased.");

      await runRecalcJob(leased);

      const after = await prisma.recalcJob.findUnique({
        where: { id: job.id },
      });
      expect(after.status).toBe("QUEUED");
      expect(after.error).toContain("injected handler failure");
      expect(after.attempts).toBe(1);
      expect(after.availableAt.getTime()).toBeGreaterThan(Date.now());

      registerRecalcHandlers();
      await prisma.recalcJob.delete({ where: { id: job.id } });
    }, 60_000);
    it("seeds an opening cost basis once, and never a second time", async () => {
      const { seedOpeningCostBasis, OPENING_COST_BASIS_AT } =
        await import("./cost-history.server");

      const fresh = await prisma.variant.create({
        data: {
          shopId,
          productId,
          shopifyId: `gid://shopify/ProductVariant/seed-${Date.now()}`,
          sku: "SEED-TEST",
          title: "Seed",
          price: "10.00",
        },
      });

      expect(
        await seedOpeningCostBasis({
          shopId,
          variantId: fresh.id,
          unitCostMicros: toMicros("3.0000"),
          source: "SHOPIFY",
        }),
      ).toBe(true);

      // A re-import must not overwrite the floor with today's cost — that would
      // silently restate every order the store has ever taken.
      expect(
        await seedOpeningCostBasis({
          shopId,
          variantId: fresh.id,
          unitCostMicros: toMicros("9.9900"),
          source: "SHOPIFY",
        }),
      ).toBe(false);

      const rows = await prisma.variantCost.findMany({
        where: { variantId: fresh.id },
      });
      expect(rows).toHaveLength(1);
      expect(Number(rows[0].unitCost)).toBe(3);
      expect(rows[0].effectiveAt.getTime()).toBe(
        OPENING_COST_BASIS_AT.getTime(),
      );
    });

    it("keeps the accounting trail when its job receipt is pruned", async () => {
      const { purgeFinishedRecalcJobs } = await import("./recalc-queue.server");

      const before = await prisma.periodRestatement.count({
        where: { shopId },
      });
      expect(before).toBeGreaterThan(0);

      // Age every finished job past the retention boundary.
      await prisma.recalcJob.updateMany({
        where: { shopId, status: { in: ["COMPLETE", "FAILED"] } },
        data: { finishedAt: new Date("2020-01-01T00:00:00.000Z") },
      });

      const purged = await purgeFinishedRecalcJobs();
      expect(purged).toBeGreaterThan(0);

      // `jobId` is SetNull precisely so pruning a receipt cannot take the ledger
      // entry with it. A Cascade here would delete a merchant's audit history
      // thirty days after the correction they are trying to explain.
      const after = await prisma.periodRestatement.count({ where: { shopId } });
      expect(after).toBe(before);
    });

    it("leaves unfinished work alone however old it is", async () => {
      const { purgeFinishedRecalcJobs } = await import("./recalc-queue.server");

      const stuck = await enqueueRecalcJob({
        shopId,
        kind: "BUNDLE_DETECTION",
        payload: {},
        dedupeKey: `stuck:${shopId}`,
        availableAt: new Date("2020-01-01T00:00:00.000Z"),
      });

      await purgeFinishedRecalcJobs();

      // A job queued for a month is a bug to find, not a row to delete.
      expect(
        await prisma.recalcJob.findUnique({ where: { id: stuck.id } }),
      ).not.toBeNull();
      await prisma.recalcJob.delete({ where: { id: stuck.id } });
    });
  },
);
