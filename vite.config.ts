import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Shopify serves embedded apps inside an admin iframe over HTTPS via a tunnel.
// The HMR host has to match that tunnel or the dev client can't connect back.
const appUrl =
  process.env.APP_URL ?? process.env.SHOPIFY_APP_URL ?? process.env.HOST;

function hostname(value: string | undefined): string {
  if (!value) return "localhost";
  try {
    return new URL(value.includes("://") ? value : `https://${value}`).hostname;
  } catch {
    return "localhost";
  }
}

const host = hostname(appUrl);

const hmrConfig = appUrl
  ? { protocol: "wss" as const, host, clientPort: 443 }
  : { protocol: "ws" as const, host: "localhost", port: 64999, clientPort: 64999 };

export default defineConfig({
  server: {
    port: Number(process.env.PORT ?? 3000),
    allowedHosts: [host],
    hmr: hmrConfig,
    fs: {
      allow: ["app", "node_modules"],
    },
  },
  plugins: [reactRouter(), tsconfigPaths()],
  build: {
    assetsInlineLimit: 0,
  },
  optimizeDeps: {
    include: ["@shopify/app-bridge-react"],
  },
});
