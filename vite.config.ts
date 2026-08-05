import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

// Shopify serves embedded apps inside an admin iframe over HTTPS via a tunnel.
// The HMR host has to match that tunnel or the dev client can't connect back.
const host = (process.env.SHOPIFY_APP_URL ?? "http://localhost:3000").replace(
  /https?:\/\//,
  "",
);

const hmrConfig = process.env.SHOPIFY_APP_URL
  ? { protocol: "wss" as const, host, port: 443, clientPort: 443 }
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
