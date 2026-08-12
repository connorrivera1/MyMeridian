import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { WebhookContext } from "./webhooks.server";

/**
 * Lease contention and SQL-NULL payload erasure are database semantics; mocks
 * cannot prove either. This suite follows order-lock.integration.test.ts and
 * runs only when CI or a local throwaway Postgres supplies the URL.
 */
const TEST_URL = process.env.MERIDIAN_TEST_DATABASE_URL;

describe.skipIf(!TEST_URL)("durable webhooks, against a real Postgres", () => {
  let prisma: any;
  let drainWebhookQueue: () => Promise<number>;
  let processAppSubscriptionsWebhook: (
    context: WebhookContext,
  ) => Promise<void>;
  let processCustomerDataRequestWebhook: (
    context: WebhookContext,
  ) => Promise<void>;
  let expireWebhookRecoveryPayloads: (now?: Date) => Promise<number>;
  let upsertCustomerUnlessErased: (input: any) => Promise<any>;
  let redactCustomerEverywhere: (input: any) => Promise<any>;
  let recordDataRequest: (input: any) => Promise<any>;
  let shopId: string;
  let shopDomain: string;
  const extraShopIds: string[] = [];

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    process.env.SHOPIFY_API_KEY ||= "integration-test-key";
    process.env.SHOPIFY_API_SECRET ||= "integration-test-secret";
    process.env.SHOPIFY_APP_URL ||= "https://integration-test.example.com";
    process.env.SCOPES ||= "read_orders,read_products";
    process.env.MERIDIAN_ENCRYPTION_KEY ||= Buffer.alloc(32, 7).toString(
      "base64",
    );
    process.env.MERIDIAN_CUSTOMER_ERASURE_KEY ||= Buffer.alloc(32, 8).toString(
      "base64",
    );

    const { PrismaClient } = await import("@prisma/client");
    prisma = new PrismaClient({ datasources: { db: { url: TEST_URL } } });
    ({ drainWebhookQueue, expireWebhookRecoveryPayloads } =
      await import("./webhooks.server"));
    ({ processAppSubscriptionsWebhook, processCustomerDataRequestWebhook } =
      await import("./webhook-processors.server"));
    ({ upsertCustomerUnlessErased, redactCustomerEverywhere } =
      await import("./customer-erasure.server"));
    ({ recordDataRequest } = await import("./data-request.server"));

    shopDomain = `webhook-queue-${Date.now()}.myshopify.com`;
    const shop = await prisma.shop.create({
      data: { domain: shopDomain, name: "Webhook Queue Test", timezone: "UTC" },
    });
    shopId = shop.id;
  });

  afterAll(async () => {
    if (!prisma) return;
    await prisma.shop.deleteMany({ where: { id: { in: extraShopIds } } });
    await prisma.shop.deleteMany({ where: { id: shopId } });
    await prisma.$disconnect();
  });

  const enqueue = (suffix: string, topic = "REFUNDS_CREATE") =>
    prisma.webhookEvent.create({
      data: {
        webhookId: `webhook-integration-${suffix}-${Date.now()}`,
        shopId,
        shopDomain,
        topic,
        payload: {
          order_id: 123,
        },
        availableAt: new Date(Date.now() - 1_000),
        leaseExpiresAt: new Date(Date.now() - 1_000),
      },
    });

  it("leases once, normalises refunds/create, and clears its payload", async () => {
    const event = await enqueue("contended", "refunds/create");

    await Promise.all([drainWebhookQueue(), drainWebhookQueue()]);

    const stored = await prisma.webhookEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(stored.attempts).toBe(1);
    expect(stored.processedAt).toBeInstanceOf(Date);
    expect(stored.payload).toBeNull();
    expect(stored.leaseToken).toBeNull();
    expect(stored.leaseExpiresAt).toBeNull();
    // A persisted wire-format refund must still take the refund guard. If the
    // slash form reached syncOrderFromShopify it would recreate the historical
    // phantom-order bug this route explicitly prevents.
    expect(await prisma.order.count({ where: { shopId } })).toBe(0);
  });

  it("retains a failed payload, then recovers and erases it on a later sweep", async () => {
    const event = await enqueue("retry", "UNSUPPORTED_TEST_TOPIC");
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await drainWebhookQueue();
    const failed = await prisma.webhookEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(failed.processedAt).toBeNull();
    expect(failed.payload).toEqual({ order_id: 123 });
    expect(failed.error).toBe("Operation failed (Error).");
    expect(failed.leaseToken).toBeNull();

    await prisma.webhookEvent.update({
      where: { id: event.id },
      data: {
        topic: "REFUNDS_CREATE",
        availableAt: new Date(Date.now() - 1_000),
      },
    });
    await drainWebhookQueue();

    const recovered = await prisma.webhookEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(recovered.attempts).toBe(2);
    expect(recovered.processedAt).toBeInstanceOf(Date);
    expect(recovered.payload).toBeNull();
    expect(recovered.error).toBeNull();
    consoleError.mockRestore();
  });

  it("keeps malformed mandatory customer work queued with its recovery payload", async () => {
    const marker = Date.now();
    const due = new Date(Date.now() - 1_000);
    const events = await Promise.all(
      ["CUSTOMERS_DATA_REQUEST", "CUSTOMERS_REDACT"].map((topic) =>
        prisma.webhookEvent.create({
          data: {
            webhookId: `malformed-${topic.toLowerCase()}-${marker}`,
            shopId,
            shopDomain,
            topic,
            payload: {
              customer: { email: `unresolved-${marker}@example.com` },
            },
            availableAt: due,
            leaseExpiresAt: due,
          },
        }),
      ),
    );
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => {});

    await drainWebhookQueue();

    const stored = await prisma.webhookEvent.findMany({
      where: { id: { in: events.map((event: any) => event.id) } },
      orderBy: { topic: "asc" },
    });
    expect(stored).toHaveLength(2);
    for (const event of stored) {
      expect(event.processedAt).toBeNull();
      expect(event.payload).toEqual({
        customer: { email: `unresolved-${marker}@example.com` },
      });
      expect(event.error).toBe("Operation failed (Error).");
      expect(event.leaseToken).toBeNull();
      expect(event.leaseExpiresAt).toBeNull();
      expect(event.availableAt.getTime()).toBeGreaterThan(Date.now());
    }

    await prisma.webhookEvent.deleteMany({
      where: { id: { in: events.map((event: any) => event.id) } },
    });
    consoleError.mockRestore();
  });

  it("requires a live owner and cascades delivery rows with shop erasure", async () => {
    const ownedShop = await prisma.shop.create({
      data: {
        domain: `webhook-owner-${Date.now()}.myshopify.com`,
        name: "Webhook Owner Test",
        timezone: "UTC",
      },
    });
    const event = await prisma.webhookEvent.create({
      data: {
        webhookId: `webhook-owner-${Date.now()}`,
        shopId: ownedShop.id,
        shopDomain: ownedShop.domain,
        topic: "SHOP_REDACT",
        payload: { shop_id: 123 },
      },
    });

    await prisma.shop.delete({ where: { id: ownedShop.id } });
    await expect(
      prisma.webhookEvent.findUnique({ where: { id: event.id } }),
    ).resolves.toBeNull();
  });

  it("records one subscription history row when recovery repeats a delivery", async () => {
    const webhookId = `subscription-recovery-${Date.now()}`;
    const context: WebhookContext = {
      shopDomain,
      webhookId,
      topic: "APP_SUBSCRIPTIONS_UPDATE",
      payload: {
        app_subscription: {
          admin_graphql_api_id: "gid://shopify/AppSubscription/123",
          name: "Growth",
          status: "ACTIVE",
        },
      },
      isReplay: true,
    };

    // This is the crash window: the processor committed, but the delivery row
    // was not yet acknowledged, so the queue invokes the processor again.
    await processAppSubscriptionsWebhook(context);
    await processAppSubscriptionsWebhook(context);

    expect(await prisma.subscriptionEvent.count({ where: { webhookId } })).toBe(
      1,
    );
  });

  it("serializes redaction against an in-flight import and blocks every later import", async () => {
    const customerNumber = `${Date.now()}101`;
    const email = `race-${customerNumber}@example.com`;
    const webhookId = `redaction-race-${customerNumber}`;
    await prisma.webhookEvent.create({
      data: {
        webhookId,
        shopId,
        shopDomain,
        topic: "CUSTOMERS_REDACT",
        payload: { customer: { id: customerNumber, email } },
      },
    });

    await Promise.all([
      upsertCustomerUnlessErased({
        shopId,
        shopifyId: customerNumber,
        email,
        acquisitionChannel: "DIRECT",
        firstOrderAt: new Date(),
      }),
      redactCustomerEverywhere({
        shopId,
        webhookId,
        customer: { id: customerNumber, email },
      }),
    ]);

    expect(
      await prisma.customer.count({
        where: {
          shopId,
          shopifyId: `gid://shopify/Customer/${customerNumber}`,
        },
      }),
    ).toBe(0);
    await expect(
      upsertCustomerUnlessErased({
        shopId,
        shopifyId: customerNumber,
        email,
        acquisitionChannel: "GOOGLE",
        firstOrderAt: new Date(),
      }),
    ).resolves.toBeNull();
    expect(
      await prisma.customerErasure.count({ where: { shopId } }),
    ).toBeGreaterThanOrEqual(2);
    await prisma.webhookEvent.delete({ where: { webhookId } });
  });

  it("scrubs matching pending JSON and prevents an in-flight export from surviving erasure", async () => {
    const customerNumber = `${Date.now()}202`;
    const email = `queue-${customerNumber}@example.com`;
    const redactionWebhookId = `redaction-queue-${customerNumber}`;
    const orderEvent = await prisma.webhookEvent.create({
      data: {
        webhookId: `pending-order-${customerNumber}`,
        shopId,
        shopDomain,
        topic: "ORDERS_UPDATED",
        payload: {
          id: Number(customerNumber.slice(-8)),
          total_price: "91.00",
          customer: { id: customerNumber, email },
        },
      },
    });
    const accessEvent = await prisma.webhookEvent.create({
      data: {
        webhookId: `pending-access-${customerNumber}`,
        shopId,
        shopDomain,
        topic: "CUSTOMERS_DATA_REQUEST",
        payload: { customer: { id: customerNumber, email } },
      },
    });
    await prisma.webhookEvent.create({
      data: {
        webhookId: redactionWebhookId,
        shopId,
        shopDomain,
        topic: "CUSTOMERS_REDACT",
        payload: { customer: { id: customerNumber, email } },
      },
    });

    const report = {
      shop: shopDomain,
      requestedAt: new Date().toISOString(),
      customer: null,
      orders: [],
      pendingWebhookData: [],
      note: "race fixture",
    };
    await Promise.all([
      recordDataRequest({
        shopId,
        webhookId: `export-race-${customerNumber}`,
        shopifyCustomerId: customerNumber,
        customerEmail: email,
        report,
        requestedAt: new Date(),
      }),
      redactCustomerEverywhere({
        shopId,
        webhookId: redactionWebhookId,
        customer: { id: customerNumber, email },
      }),
    ]);

    const scrubbedOrder = await prisma.webhookEvent.findUniqueOrThrow({
      where: { id: orderEvent.id },
    });
    expect(scrubbedOrder.payload).toEqual({
      id: Number(customerNumber.slice(-8)),
      total_price: "91.00",
    });
    const supersededAccess = await prisma.webhookEvent.findUniqueOrThrow({
      where: { id: accessEvent.id },
    });
    expect(supersededAccess.processedAt).toBeInstanceOf(Date);
    expect(supersededAccess.payload).toBeNull();
    expect(
      await prisma.dataRequest.count({
        where: {
          shopId,
          OR: [{ shopifyCustomerId: customerNumber }, { customerEmail: email }],
        },
      }),
    ).toBe(0);
    await recordDataRequest({
      shopId,
      webhookId: `export-after-${customerNumber}`,
      shopifyCustomerId: customerNumber,
      customerEmail: email,
      report,
      requestedAt: new Date(),
    });
    const safeResponses = await prisma.dataRequest.findMany({
      where: {
        shopId,
        webhookId: {
          in: [
            `export-race-${customerNumber}`,
            `export-after-${customerNumber}`,
          ],
        },
      },
    });
    expect(safeResponses.length).toBeGreaterThan(0);
    for (const response of safeResponses) {
      expect(response.shopifyCustomerId).toBe("redacted-request");
      expect(response.customerEmail).toBeNull();
      expect(response.ordersIncluded).toBe(0);
      expect(response.report).toEqual(
        expect.objectContaining({
          customer: null,
          orders: [],
          pendingWebhookData: [],
        }),
      );
    }
    await prisma.webhookEvent.deleteMany({
      where: {
        webhookId: {
          in: [
            `pending-order-${customerNumber}`,
            `pending-access-${customerNumber}`,
            redactionWebhookId,
          ],
        },
      },
    });
  });

  it("keeps same-email customers separate across queue scrubbing, held exports, and later access", async () => {
    const marker = Date.now();
    const customerA = `${marker}301`;
    const customerB = `${marker}302`;
    const sharedEmail = `shared-${marker}@example.com`;
    const redactionWebhookId = `redaction-shared-email-${marker}`;
    const customerBOrderWebhookId = `pending-order-shared-email-${marker}`;
    const customerAExportWebhookId = `export-a-shared-email-${marker}`;
    const customerBExportWebhookId = `export-b-shared-email-${marker}`;
    const customerBLaterExportWebhookId = `export-b-later-shared-email-${marker}`;
    const requestedAt = new Date("2026-08-10T12:00:00.000Z");
    const reportFor = (id: string) => ({
      shop: shopDomain,
      requestedAt: requestedAt.toISOString(),
      customer: { shopifyId: id, email: sharedEmail },
      orders: [],
      pendingWebhookData: [],
    });

    const customerBOrder = await prisma.webhookEvent.create({
      data: {
        webhookId: customerBOrderWebhookId,
        shopId,
        shopDomain,
        topic: "ORDERS_UPDATED",
        payload: {
          id: Number(String(marker).slice(-8)),
          total_price: "73.00",
          customer: { id: customerB, email: sharedEmail },
        },
      },
    });
    await prisma.webhookEvent.create({
      data: {
        webhookId: redactionWebhookId,
        shopId,
        shopDomain,
        topic: "CUSTOMERS_REDACT",
        payload: { customer: { id: customerA, email: sharedEmail } },
      },
    });
    await recordDataRequest({
      shopId,
      webhookId: customerAExportWebhookId,
      shopifyCustomerId: customerA,
      customerEmail: sharedEmail,
      report: reportFor(customerA),
      requestedAt,
    });
    await recordDataRequest({
      shopId,
      webhookId: customerBExportWebhookId,
      shopifyCustomerId: customerB,
      customerEmail: sharedEmail,
      report: reportFor(customerB),
      requestedAt,
    });

    await redactCustomerEverywhere({
      shopId,
      webhookId: redactionWebhookId,
      customer: { id: customerA, email: sharedEmail },
    });

    const stillPendingForB = await prisma.webhookEvent.findUniqueOrThrow({
      where: { id: customerBOrder.id },
    });
    expect(stillPendingForB.processedAt).toBeNull();
    expect(stillPendingForB.payload).toEqual({
      id: Number(String(marker).slice(-8)),
      total_price: "73.00",
      customer: { id: customerB, email: sharedEmail },
    });
    await expect(
      prisma.dataRequest.findUnique({
        where: { webhookId: customerAExportWebhookId },
      }),
    ).resolves.toBeNull();
    await expect(
      prisma.dataRequest.findUniqueOrThrow({
        where: { webhookId: customerBExportWebhookId },
      }),
    ).resolves.toMatchObject({
      shopifyCustomerId: customerB,
      customerEmail: sharedEmail,
    });

    await recordDataRequest({
      shopId,
      webhookId: customerBLaterExportWebhookId,
      shopifyCustomerId: customerB,
      customerEmail: sharedEmail,
      report: reportFor(customerB),
      requestedAt,
    });
    const laterAccessForB = await prisma.dataRequest.findUniqueOrThrow({
      where: { webhookId: customerBLaterExportWebhookId },
    });
    expect(laterAccessForB).toMatchObject({
      shopifyCustomerId: customerB,
      customerEmail: sharedEmail,
      ordersIncluded: 0,
    });
    expect(laterAccessForB.report).toEqual(
      expect.objectContaining({
        customer: expect.objectContaining({ shopifyId: customerB }),
      }),
    );

    await prisma.webhookEvent.deleteMany({
      where: {
        webhookId: { in: [customerBOrderWebhookId, redactionWebhookId] },
      },
    });
    await prisma.dataRequest.deleteMany({
      where: {
        webhookId: {
          in: [customerBExportWebhookId, customerBLaterExportWebhookId],
        },
      },
    });
  });

  it("anchors access-export retention to receipt and cannot extend it on retry", async () => {
    const marker = Date.now();
    const webhookId = `data-request-retention-${marker}`;
    const customerNumber = `${marker}401`;
    const receivedAt = new Date("2026-08-01T06:30:00.000Z");
    const expiresAt = new Date("2026-09-01T06:30:00.000Z");
    await prisma.webhookEvent.create({
      data: {
        webhookId,
        shopId,
        shopDomain,
        topic: "CUSTOMERS_DATA_REQUEST",
        payload: { customer: { id: customerNumber } },
        receivedAt,
      },
    });

    await processCustomerDataRequestWebhook({
      shopDomain,
      webhookId,
      topic: "CUSTOMERS_DATA_REQUEST",
      payload: { customer: { id: customerNumber } },
      isReplay: false,
    });
    const first = await prisma.dataRequest.findUniqueOrThrow({
      where: { webhookId },
    });
    expect(first.requestedAt).toEqual(receivedAt);
    expect(first.expiresAt).toEqual(expiresAt);

    // Simulate the old failure mode directly: even if a recovered caller
    // presents worker time a week later, the existing row's receipt-anchored
    // retention fields are immutable.
    const retryAttemptedAt = new Date("2026-08-08T06:30:00.000Z");
    await recordDataRequest({
      shopId,
      webhookId,
      shopifyCustomerId: customerNumber,
      customerEmail: null,
      report: {
        shop: shopDomain,
        requestedAt: retryAttemptedAt.toISOString(),
        customer: null,
        orders: [],
        pendingWebhookData: [],
        note: "retry fixture",
      },
      requestedAt: retryAttemptedAt,
    });
    const retried = await prisma.dataRequest.findUniqueOrThrow({
      where: { webhookId },
    });
    expect(retried.requestedAt).toEqual(receivedAt);
    expect(retried.expiresAt).toEqual(expiresAt);

    await prisma.webhookEvent.delete({ where: { webhookId } });
    await prisma.dataRequest.delete({ where: { webhookId } });
  });

  it("irreversibly clears an ordinary projected order payload at seven days", async () => {
    const event = await prisma.webhookEvent.create({
      data: {
        webhookId: `expired-order-${Date.now()}`,
        shopId,
        shopDomain,
        topic: "ORDERS_UPDATED",
        payload: {
          id: 88001,
          customer: { id: 99001, email: "expires@example.com" },
        },
        payloadExpiresAt: new Date(Date.now() - 1_000),
        availableAt: new Date(Date.now() - 1_000),
      },
    });

    await expect(expireWebhookRecoveryPayloads(new Date())).resolves.toBe(1);
    const expired = await prisma.webhookEvent.findUniqueOrThrow({
      where: { id: event.id },
    });
    expect(expired.processedAt).toBeInstanceOf(Date);
    expect(expired.payload).toBeNull();
    expect(expired.payloadExpiresAt).toBeNull();
    expect(expired.error).toMatch(/expired after 7 days/i);
  });

  it("does not expire mandatory compliance work and still executes it", async () => {
    const expiredAt = new Date(Date.now() - 8 * 86_400_000);
    const due = new Date(Date.now() - 1_000);

    const customerShop = await prisma.shop.create({
      data: {
        domain: `expired-redact-${Date.now()}.myshopify.com`,
        name: "Expired Customer Redact",
        timezone: "UTC",
      },
    });
    extraShopIds.push(customerShop.id);
    const customerEvent = await prisma.webhookEvent.create({
      data: {
        webhookId: `expired-customer-redact-${Date.now()}`,
        shopId: customerShop.id,
        shopDomain: customerShop.domain,
        topic: "CUSTOMERS_REDACT",
        payload: { customer: { id: "90001", email: "erase@example.com" } },
        payloadExpiresAt: expiredAt,
        availableAt: due,
      },
    });

    const shopToErase = await prisma.shop.create({
      data: {
        domain: `expired-shop-redact-${Date.now()}.myshopify.com`,
        name: "Expired Shop Redact",
        timezone: "UTC",
      },
    });
    extraShopIds.push(shopToErase.id);
    const shopEvent = await prisma.webhookEvent.create({
      data: {
        webhookId: `expired-shop-redact-${Date.now()}`,
        shopId: shopToErase.id,
        shopDomain: shopToErase.domain,
        topic: "SHOP_REDACT",
        payload: {},
        payloadExpiresAt: expiredAt,
        availableAt: due,
      },
    });

    await expireWebhookRecoveryPayloads(new Date());
    expect(
      await prisma.webhookEvent.findUniqueOrThrow({
        where: { id: customerEvent.id },
      }),
    ).toMatchObject({ processedAt: null });
    expect(
      await prisma.webhookEvent.findUniqueOrThrow({
        where: { id: shopEvent.id },
      }),
    ).toMatchObject({ processedAt: null });

    await drainWebhookQueue();

    const processedCustomerEvent = await prisma.webhookEvent.findUniqueOrThrow({
      where: { id: customerEvent.id },
    });
    expect(processedCustomerEvent.processedAt).toBeInstanceOf(Date);
    expect(processedCustomerEvent.payload).toBeNull();
    expect(
      await prisma.customerErasure.count({
        where: { shopId: customerShop.id },
      }),
    ).toBeGreaterThan(0);
    await expect(
      prisma.shop.findUnique({ where: { id: shopToErase.id } }),
    ).resolves.toBeNull();
    await expect(
      prisma.webhookEvent.findUnique({ where: { id: shopEvent.id } }),
    ).resolves.toBeNull();
  });
});
