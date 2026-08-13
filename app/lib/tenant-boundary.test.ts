import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = process.cwd();

describe("merchant tenant boundary coverage", () => {
  it("keeps every shop-owned Prisma model covered by an RLS migration", () => {
    const schema = readFileSync(join(ROOT, "prisma/schema.prisma"), "utf8");
    const migrationsDir = join(ROOT, "prisma/migrations");
    const migration = readdirSync(migrationsDir)
      .map((directory) => join(migrationsDir, directory, "migration.sql"))
      .filter((path) => {
        try {
          readFileSync(path, "utf8");
          return true;
        } catch {
          return false;
        }
      })
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const models = [...schema.matchAll(/model\s+(\w+)\s*\{([\s\S]*?)\n\}/g)]
      .filter(([, , body]) => /^\s*shopId\s+/m.test(body!))
      .map(([, name]) => name!)
      .filter(
        (name) => !["OperatorAuditEvent", "ShopMembership"].includes(name),
      );

    for (const model of models) {
      expect(migration, `${model} is missing from tenant RLS`).toContain(
        `"${model}"`,
      );
    }
    expect(migration).toContain(
      'ALTER TABLE "ShopMembership" ENABLE ROW LEVEL SECURITY',
    );
    expect(migration).toContain('ALTER TABLE "Shop" ENABLE ROW LEVEL SECURITY');
  });

  it("requires every merchant route handler to enter a scoped data boundary", () => {
    const routeDirectory = join(ROOT, "app/routes");
    const unscoped = readdirSync(routeDirectory)
      .filter((name) => /^app\..+\.(?:ts|tsx)$/.test(name))
      .filter((name) => {
        const source = readFileSync(join(routeDirectory, name), "utf8");
        if (!/export async function (?:loader|action)/.test(source))
          return false;
        return ![
          "withShopContext(request",
          "loadDashboard(request",
          "withTenantDatabase(",
        ].some((boundary) => source.includes(boundary));
      });

    expect(unscoped).toEqual([]);
  });
});
