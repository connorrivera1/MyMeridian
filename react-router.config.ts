import type { Config } from "@react-router/dev/config";

export default {
  // Shopify embedded apps are server-rendered: the admin iframe loads a fresh
  // document on every navigation into the app, so SSR is not optional here.
  ssr: true,
} satisfies Config;
