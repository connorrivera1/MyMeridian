import type { ActionFunctionArgs } from "react-router";

import { ConnectorProvider, ConnectorStatus } from "@prisma/client";

import prisma from "~/db.server";
import { reconcileCarrierConnector } from "~/integrations/shipping.server";
import { withConnectorWork } from "~/integrations/lease.server";
import { decryptSecret, safeEqual } from "~/lib/crypto.server";

const MAX_WEBHOOK_BYTES = 256 * 1024;

export async function action({ request, params }: ActionFunctionArgs) {
  const connectorId = params.connectorId?.trim();
  const suppliedSecret = request.headers.get("x-meridian-webhook-secret")?.trim();
  if (!connectorId || !suppliedSecret) return new Response("Unauthorized", { status: 401 });

  const declaredLength = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_WEBHOOK_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }
  const body = await request.text();
  if (Buffer.byteLength(body, "utf8") > MAX_WEBHOOK_BYTES) {
    return new Response("Payload too large", { status: 413 });
  }

  const connector = await prisma.connector.findUnique({
    where: { id: connectorId },
    include: { shop: { select: { domain: true, currency: true } } },
  });
  if (
    !connector ||
    connector.provider !== ConnectorProvider.SHIPSTATION ||
    connector.status !== ConnectorStatus.CONNECTED ||
    !connector.webhookSecretEnc
  ) return new Response("Unauthorized", { status: 401 });

  let expectedSecret: string;
  try {
    expectedSecret = decryptSecret(connector.webhookSecretEnc);
  } catch (error) {
    console.error(`[shipstation-webhook:${connector.id}] invalid stored listener secret`, error);
    return new Response("Listener unavailable", { status: 503 });
  }
  if (!safeEqual(suppliedSecret, expectedSecret)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const now = new Date();
  const result = await withConnectorWork(
    connector.id,
    "shipstation-webhook",
    now,
    () => reconcileCarrierConnector(connector, now),
  );
  // Another process already doing the same overlapping read is success, not a
  // reason for ShipStation to redeliver and amplify the event.
  return new Response(null, { status: result.claimed ? 204 : 202 });
}

export const loader = () => new Response(null, { status: 405 });
