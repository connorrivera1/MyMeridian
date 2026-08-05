-- CreateEnum
CREATE TYPE "Channel" AS ENUM ('FACEBOOK', 'GOOGLE', 'TIKTOK', 'EMAIL', 'ORGANIC_SEARCH', 'DIRECT', 'REFERRAL', 'AFFILIATE', 'OTHER');

-- CreateEnum
CREATE TYPE "CostSource" AS ENUM ('SHOPIFY', 'MANUAL', 'ESTIMATED');

-- CreateEnum
CREATE TYPE "CostRuleKind" AS ENUM ('PAYMENT_FEE', 'SHIPPING_DEFAULT', 'PICK_PACK', 'OVERHEAD_MONTHLY', 'CUSTOM');

-- CreateEnum
CREATE TYPE "ConnectorProvider" AS ENUM ('SHOPIFY', 'FACEBOOK_ADS', 'GOOGLE_ADS', 'TIKTOK_ADS', 'STRIPE', 'WAREHOUSE_3PL');

-- CreateEnum
CREATE TYPE "ConnectorStatus" AS ENUM ('NOT_CONFIGURED', 'CONNECTED', 'DISCONNECTED', 'ERROR');

-- CreateEnum
CREATE TYPE "Confidence" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateEnum
CREATE TYPE "RecStatus" AS ENUM ('PENDING', 'APPLIED', 'DISMISSED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookEvent" (
    "id" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "topic" TEXT NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "error" TEXT,

    CONSTRAINT "WebhookEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "id" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "timezone" TEXT NOT NULL DEFAULT 'America/New_York',
    "planName" TEXT,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "isDemo" BOOLEAN NOT NULL DEFAULT false,
    "lastSyncedAt" TIMESTAMP(3),
    "lastComputedAt" TIMESTAMP(3),
    "onboardingStep" TEXT NOT NULL DEFAULT 'connect_costs',
    "fulfillmentSlaDays" INTEGER NOT NULL DEFAULT 2,

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Subscription" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "plan" TEXT NOT NULL DEFAULT 'trial',
    "status" TEXT NOT NULL DEFAULT 'active',
    "shopifyChargeId" TEXT,
    "trialEndsAt" TIMESTAMP(3),
    "currentPeriodEnd" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Subscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Product" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT NOT NULL,
    "productType" TEXT,
    "vendor" TEXT,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "imageUrl" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Product_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Variant" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "productId" TEXT NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "compareAtPrice" DECIMAL(12,2),
    "unitCost" DECIMAL(12,4),
    "costSource" "CostSource" NOT NULL DEFAULT 'SHOPIFY',
    "weightGrams" INTEGER,
    "inventoryQty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "Variant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceChange" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "price" DECIMAL(12,2) NOT NULL,
    "effectiveAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceChange_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "email" TEXT,
    "firstOrderAt" TIMESTAMP(3),
    "acquisitionChannel" "Channel" NOT NULL DEFAULT 'DIRECT',
    "acquisitionCampaignId" TEXT,
    "ordersCount" INTEGER NOT NULL DEFAULT 0,
    "lifetimeRevenue" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "lifetimeProfit" DECIMAL(14,2) NOT NULL DEFAULT 0,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Order" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "orderNumber" INTEGER NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL,
    "customerId" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "subtotal" DECIMAL(12,2) NOT NULL,
    "discountTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "shippingCharged" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "taxTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(12,2) NOT NULL,
    "refundedTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "financialStatus" TEXT NOT NULL DEFAULT 'paid',
    "fulfillmentStatus" TEXT NOT NULL DEFAULT 'unfulfilled',
    "channel" "Channel" NOT NULL DEFAULT 'DIRECT',
    "campaignId" TEXT,
    "campaignName" TEXT,
    "utmSource" TEXT,
    "utmMedium" TEXT,
    "utmCampaign" TEXT,
    "landingSite" TEXT,
    "isFirstOrder" BOOLEAN NOT NULL DEFAULT false,
    "cogsTotal" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "shippingCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "paymentFee" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "adCostAttributed" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "overheadAllocated" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "contributionProfit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "netProfit" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3),

    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineItem" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "shopifyId" TEXT NOT NULL,
    "variantId" TEXT,
    "productId" TEXT,
    "title" TEXT NOT NULL,
    "sku" TEXT,
    "quantity" INTEGER NOT NULL,
    "unitPrice" DECIMAL(12,2) NOT NULL,
    "discount" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "unitCost" DECIMAL(12,4) NOT NULL DEFAULT 0,
    "refundedQty" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "OrderLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdSpend" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "channel" "Channel" NOT NULL,
    "campaignId" TEXT,
    "campaignName" TEXT,
    "spend" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "impressions" INTEGER NOT NULL DEFAULT 0,
    "clicks" INTEGER NOT NULL DEFAULT 0,
    "platformConversions" INTEGER NOT NULL DEFAULT 0,
    "platformRevenue" DECIMAL(12,2) NOT NULL DEFAULT 0,

    CONSTRAINT "AdSpend_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Fulfillment" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "createdAt" TIMESTAMP(3) NOT NULL,
    "shippedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "carrier" TEXT,
    "serviceLevel" TEXT,
    "shippingCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "pickPackCost" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "itemCount" INTEGER NOT NULL DEFAULT 0,
    "location" TEXT NOT NULL DEFAULT 'primary',

    CONSTRAINT "Fulfillment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapacityDay" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "location" TEXT NOT NULL DEFAULT 'primary',
    "ordersReceived" INTEGER NOT NULL DEFAULT 0,
    "ordersFulfilled" INTEGER NOT NULL DEFAULT 0,
    "unitsFulfilled" INTEGER NOT NULL DEFAULT 0,
    "backlogEnd" INTEGER NOT NULL DEFAULT 0,
    "staffedHours" DECIMAL(8,2) NOT NULL DEFAULT 0,
    "maxDailyCapacity" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "CapacityDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostRule" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "kind" "CostRuleKind" NOT NULL,
    "label" TEXT NOT NULL,
    "percentRate" DECIMAL(8,5),
    "fixedPerOrder" DECIMAL(12,4),
    "fixedPerItem" DECIMAL(12,4),
    "monthlyAmount" DECIMAL(12,2),
    "appliesToChannel" "Channel",
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CostRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Connector" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "provider" "ConnectorProvider" NOT NULL,
    "status" "ConnectorStatus" NOT NULL DEFAULT 'NOT_CONFIGURED',
    "externalAccountId" TEXT,
    "displayName" TEXT,
    "accessTokenEnc" TEXT,
    "refreshTokenEnc" TEXT,
    "tokenExpiresAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "lastError" TEXT,

    CONSTRAINT "Connector_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PricingRecommendation" (
    "id" TEXT NOT NULL,
    "shopId" TEXT NOT NULL,
    "variantId" TEXT NOT NULL,
    "currentPrice" DECIMAL(12,2) NOT NULL,
    "suggestedPrice" DECIMAL(12,2) NOT NULL,
    "expectedUnitsDeltaPct" DECIMAL(8,4) NOT NULL DEFAULT 0,
    "expectedProfitDelta" DECIMAL(12,2) NOT NULL DEFAULT 0,
    "elasticity" DECIMAL(8,4),
    "confidence" "Confidence" NOT NULL DEFAULT 'LOW',
    "method" TEXT NOT NULL,
    "rationale" TEXT NOT NULL,
    "status" "RecStatus" NOT NULL DEFAULT 'PENDING',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actionedAt" TIMESTAMP(3),

    CONSTRAINT "PricingRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEvent_webhookId_key" ON "WebhookEvent"("webhookId");

-- CreateIndex
CREATE INDEX "WebhookEvent_shopDomain_topic_idx" ON "WebhookEvent"("shopDomain", "topic");

-- CreateIndex
CREATE UNIQUE INDEX "Shop_domain_key" ON "Shop"("domain");

-- CreateIndex
CREATE INDEX "Shop_domain_idx" ON "Shop"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "Subscription_shopId_key" ON "Subscription"("shopId");

-- CreateIndex
CREATE INDEX "Product_shopId_status_idx" ON "Product"("shopId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Product_shopId_shopifyId_key" ON "Product"("shopId", "shopifyId");

-- CreateIndex
CREATE INDEX "Variant_shopId_idx" ON "Variant"("shopId");

-- CreateIndex
CREATE INDEX "Variant_productId_idx" ON "Variant"("productId");

-- CreateIndex
CREATE UNIQUE INDEX "Variant_shopId_shopifyId_key" ON "Variant"("shopId", "shopifyId");

-- CreateIndex
CREATE INDEX "PriceChange_variantId_effectiveAt_idx" ON "PriceChange"("variantId", "effectiveAt");

-- CreateIndex
CREATE INDEX "Customer_shopId_acquisitionChannel_idx" ON "Customer"("shopId", "acquisitionChannel");

-- CreateIndex
CREATE INDEX "Customer_shopId_firstOrderAt_idx" ON "Customer"("shopId", "firstOrderAt");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_shopId_shopifyId_key" ON "Customer"("shopId", "shopifyId");

-- CreateIndex
CREATE INDEX "Order_shopId_processedAt_idx" ON "Order"("shopId", "processedAt");

-- CreateIndex
CREATE INDEX "Order_shopId_channel_processedAt_idx" ON "Order"("shopId", "channel", "processedAt");

-- CreateIndex
CREATE INDEX "Order_shopId_netProfit_idx" ON "Order"("shopId", "netProfit");

-- CreateIndex
CREATE INDEX "Order_customerId_idx" ON "Order"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "Order_shopId_shopifyId_key" ON "Order"("shopId", "shopifyId");

-- CreateIndex
CREATE INDEX "OrderLineItem_orderId_idx" ON "OrderLineItem"("orderId");

-- CreateIndex
CREATE INDEX "OrderLineItem_shopId_productId_idx" ON "OrderLineItem"("shopId", "productId");

-- CreateIndex
CREATE INDEX "OrderLineItem_shopId_variantId_idx" ON "OrderLineItem"("shopId", "variantId");

-- CreateIndex
CREATE INDEX "AdSpend_shopId_date_idx" ON "AdSpend"("shopId", "date");

-- CreateIndex
CREATE INDEX "AdSpend_shopId_channel_date_idx" ON "AdSpend"("shopId", "channel", "date");

-- CreateIndex
CREATE UNIQUE INDEX "AdSpend_shopId_date_channel_campaignId_key" ON "AdSpend"("shopId", "date", "channel", "campaignId");

-- CreateIndex
CREATE INDEX "Fulfillment_shopId_createdAt_idx" ON "Fulfillment"("shopId", "createdAt");

-- CreateIndex
CREATE INDEX "Fulfillment_orderId_idx" ON "Fulfillment"("orderId");

-- CreateIndex
CREATE INDEX "CapacityDay_shopId_date_idx" ON "CapacityDay"("shopId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "CapacityDay_shopId_date_location_key" ON "CapacityDay"("shopId", "date", "location");

-- CreateIndex
CREATE INDEX "CostRule_shopId_kind_active_idx" ON "CostRule"("shopId", "kind", "active");

-- CreateIndex
CREATE UNIQUE INDEX "Connector_shopId_provider_key" ON "Connector"("shopId", "provider");

-- CreateIndex
CREATE INDEX "PricingRecommendation_shopId_status_generatedAt_idx" ON "PricingRecommendation"("shopId", "status", "generatedAt");

-- CreateIndex
CREATE INDEX "PricingRecommendation_variantId_idx" ON "PricingRecommendation"("variantId");

-- AddForeignKey
ALTER TABLE "Subscription" ADD CONSTRAINT "Subscription_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Variant" ADD CONSTRAINT "Variant_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceChange" ADD CONSTRAINT "PriceChange_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceChange" ADD CONSTRAINT "PriceChange_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdSpend" ADD CONSTRAINT "AdSpend_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fulfillment" ADD CONSTRAINT "Fulfillment_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Fulfillment" ADD CONSTRAINT "Fulfillment_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapacityDay" ADD CONSTRAINT "CapacityDay_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostRule" ADD CONSTRAINT "CostRule_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connector" ADD CONSTRAINT "Connector_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRecommendation" ADD CONSTRAINT "PricingRecommendation_shopId_fkey" FOREIGN KEY ("shopId") REFERENCES "Shop"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PricingRecommendation" ADD CONSTRAINT "PricingRecommendation_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "Variant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
