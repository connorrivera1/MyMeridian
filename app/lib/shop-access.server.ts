/**
 * Which store may a signed-in web user see?
 *
 * This is the authorisation half of the web dashboard, and the only thing
 * standing between "I proved I own an email address" and a stranger's revenue.
 * The rule is one sentence: a web session may read a Shop if and only if a
 * `ShopMembership` row joins them, and that row is written in exactly one
 * place — the Shopify OAuth callback, after Shopify itself confirmed the
 * person installing the app administers that store.
 *
 * Nothing here may ever accept a shop domain from the query string and resolve
 * it directly. The shop id is only ever selected from the set the membership
 * table already returned.
 */

import type { Shop, User } from "@prisma/client";

import prisma from "~/db.server";

export interface MembershipSummary {
  shopId: string;
  domain: string;
  name: string;
  role: "OWNER" | "MEMBER";
}

/** Every store this user has been granted, newest membership first. */
export async function listMemberships(
  userId: string,
): Promise<MembershipSummary[]> {
  const rows = await prisma.shopMembership.findMany({
    where: { userId },
    include: { shop: true },
    orderBy: { createdAt: "desc" },
  });

  return rows.map((row) => ({
    shopId: row.shopId,
    domain: row.shop.domain,
    name: row.shop.name,
    role: row.role,
  }));
}

/**
 * Resolve the store a request should render.
 *
 * `requestedShopId` is untrusted input from the store switcher. It is matched
 * against the user's own memberships rather than looked up, so a forged id
 * selects nothing instead of selecting someone else's store.
 */
export async function resolveAccessibleShop(
  user: User,
  requestedShopId: string | null,
): Promise<Shop | null> {
  const memberships = await prisma.shopMembership.findMany({
    where: { userId: user.id },
    include: { shop: true },
    orderBy: { createdAt: "desc" },
  });

  if (requestedShopId) {
    const match = memberships.find((m) => m.shopId === requestedShopId);
    // A requested store that is not theirs falls back to one that is, rather
    // than erroring: the id usually went stale (membership revoked, store
    // uninstalled) and logging someone out over it helps nobody.
    if (match) return match.shop;
  }

  return memberships[0]?.shop ?? null;
}

/**
 * Record that a user administers a store.
 *
 * Called from the OAuth callback only. Idempotent, because a merchant
 * re-installing or re-authorising is normal and must not fail on a duplicate.
 */
export async function grantMembership(
  userId: string,
  shopId: string,
): Promise<void> {
  await prisma.shopMembership.upsert({
    where: { userId_shopId: { userId, shopId } },
    update: {},
    create: { userId, shopId, role: "OWNER" },
  });
}

/**
 * Remove a user's access to a store.
 *
 * Uninstalling revokes web access along with everything else — otherwise the
 * dashboard would keep serving the last-imported numbers for a store that has
 * revoked the app, which is precisely the state a merchant believes they just
 * ended.
 */
export async function revokeMembershipsForShop(shopId: string): Promise<void> {
  await prisma.shopMembership.deleteMany({ where: { shopId } });
}
