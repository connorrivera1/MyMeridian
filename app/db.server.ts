import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __meridianPrisma: PrismaClient | undefined;
}

// Vite reloads server modules on every change in dev; without a global handle
// each reload opens a new pool and Postgres runs out of connections.
const prisma = global.__meridianPrisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  global.__meridianPrisma = prisma;
}

export default prisma;
