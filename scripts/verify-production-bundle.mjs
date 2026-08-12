import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const SERVER_BUILD = fileURLToPath(
  new URL("../build/server/", import.meta.url),
);
const CLIENT_BUILD = fileURLToPath(
  new URL("../build/client/", import.meta.url),
);
const FORBIDDEN = [
  "meridian-demo.myshopify.com",
  "Demo store has not been seeded yet",
];

async function javascriptFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return javascriptFiles(path);
      return entry.isFile() && entry.name.endsWith(".js") ? [path] : [];
    }),
  );
  return nested.flat();
}

async function browserTextFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return browserTextFiles(path);
      return entry.isFile() &&
        /\.(?:js|mjs|cjs|map|json|css|html)$/i.test(entry.name)
        ? [path]
        : [];
    }),
  );
  return nested.flat();
}

const files = await javascriptFiles(SERVER_BUILD);
if (files.length === 0) {
  throw new Error("Production server build contains no JavaScript to inspect.");
}

const leaks = [];
for (const file of files) {
  const source = await readFile(file, "utf8");
  for (const signature of FORBIDDEN) {
    if (source.includes(signature)) leaks.push({ file, signature });
  }
}

if (leaks.length > 0) {
  const details = leaks
    .map(({ file, signature }) => `${file}: ${JSON.stringify(signature)}`)
    .join("\n");
  throw new Error(
    `Development demo authentication leaked into the production bundle:\n${details}`,
  );
}

console.log(
  `Production bundle excludes demo authentication (${files.length} server files inspected).`,
);

// These values belong only in the server runtime. Checking both their names
// and any configured build-time canaries prevents a future route refactor from
// pulling operator configuration into a browser chunk. Never print a leaked
// value: on a real production builder it may be the actual credential.
const clientFiles = await browserTextFiles(CLIENT_BUILD);
const serverOnlyEnvironment = [
  "DATABASE_URL",
  "DIRECT_DATABASE_URL",
  "MERIDIAN_TENANT_DATABASE_URL",
  "SHOPIFY_API_SECRET",
  "MERIDIAN_ENCRYPTION_KEY",
  "MERIDIAN_CUSTOMER_ERASURE_KEY",
  "MERIDIAN_RATE_LIMIT_KEY",
  "MERIDIAN_OPERATOR_EMAIL",
  "MERIDIAN_OPERATOR_PASSWORD_HASH",
  "MERIDIAN_OPERATOR_TOTP_SECRET",
  "MERIDIAN_OPERATOR_SESSION_KEY",
  "RESEND_API_KEY",
  "TWILIO_ACCOUNT_SID",
  "TWILIO_API_KEY_SID",
  "TWILIO_API_KEY_SECRET",
  "TWILIO_VERIFY_SERVICE_SID",
  "GOOGLE_CLIENT_SECRET",
  "APPLE_TEAM_ID",
  "APPLE_KEY_ID",
  "APPLE_PRIVATE_KEY",
  "META_APP_SECRET",
  "TIKTOK_APP_SECRET",
  "CONNECTOR_ALERT_WEBHOOK_SECRET",
  "MERIDIAN_CONNECTOR_TOKEN",
  "MERIDIAN_CONNECTOR_REFRESH_TOKEN",
  "MERIDIAN_REDIS_URL",
  "REDIS_URL",
  "MERIDIAN_GOOGLE_ADS_DEVELOPER_TOKEN",
  "MERIDIAN_GOOGLE_ADS_CLIENT_SECRET",
];
const serverSecrets = serverOnlyEnvironment.flatMap((name) => {
  const value = process.env[name];
  return [
    { label: `${name} identifier`, value: name },
    ...(value ? [{ label: `${name} value`, value }] : []),
  ];
});
const clientLeaks = [];
for (const file of clientFiles) {
  const source = await readFile(file, "utf8");
  for (const signature of serverSecrets) {
    if (source.includes(signature.value)) {
      clientLeaks.push({ file, label: signature.label });
    }
  }
}
if (clientLeaks.length > 0) {
  throw new Error(
    `Server-only configuration leaked into the browser bundle:\n${clientLeaks
      .map(({ file, label }) => `${file}: ${label}`)
      .join("\n")}`,
  );
}
console.log(
  `Production browser bundle excludes ${serverOnlyEnvironment.length} server-only configuration fields (${clientFiles.length} public text files inspected).`,
);
