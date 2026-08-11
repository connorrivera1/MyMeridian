import prisma from "~/db.server";

const PRODUCTION_REQUIRED = [
  "DATABASE_URL",
  "SHOPIFY_API_KEY",
  "SHOPIFY_API_SECRET",
  "SHOPIFY_APP_URL",
  "MERIDIAN_ENCRYPTION_KEY",
  "MERIDIAN_CUSTOMER_ERASURE_KEY",
] as const;

export function readinessConfiguration(env: NodeJS.ProcessEnv = process.env): {
  ready: boolean;
  missing: string[];
} {
  if (env.NODE_ENV !== "production") return { ready: true, missing: [] };
  const missing: string[] = PRODUCTION_REQUIRED.filter((name) => !env[name]?.trim());
  const appUrl = env.SHOPIFY_APP_URL?.trim();
  if (appUrl) {
    try {
      const url = new URL(appUrl);
      if (url.protocol !== "https:") missing.push("SHOPIFY_APP_URL_HTTPS");
    } catch {
      missing.push("SHOPIFY_APP_URL_VALID");
    }
  }
  return { ready: missing.length === 0, missing };
}

export async function loader() {
  const configuration = readinessConfiguration();
  if (!configuration.ready) {
    return Response.json(
      { status: "not_ready", reason: "configuration", missing: configuration.missing },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
  try {
    await prisma.$queryRaw`SELECT 1`;
    return Response.json(
      { status: "ready", database: "reachable" },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { status: "not_ready", reason: "database" },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
