import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";

import requirements from "../config/production-readiness.json" with {
  type: "json",
};

const options = new Set(process.argv.slice(2));
const configOnly = options.delete("--config-only");

function optionValue(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires an app name.`);
  }
  options.delete(name);
  options.delete(value);
  return value;
}

const app = optionValue("--app", "mymeridian-prod");
if (options.size > 0) {
  throw new Error(`Unknown option(s): ${[...options].join(", ")}`);
}

function execute(command, args) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: "utf8" }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

async function validateProductionConfig() {
  const [flyConfig, shopifyConfig] = await Promise.all([
    readFile(new URL("../fly.toml", import.meta.url), "utf8"),
    readFile(new URL("../shopify.app.production.toml", import.meta.url), "utf8"),
  ]);
  const requiredFlyLines = [
    'app = "mymeridian-prod"',
    'SHOPIFY_APP_URL = "https://mymeridian.io"',
    'MERIDIAN_REQUIRE_LAUNCH_CONNECTORS = "true"',
    'MERIDIAN_REQUIRE_WEB_OAUTH = "true"',
    'MERIDIAN_ADS_WORKER_DISABLED = "false"',
    'MERIDIAN_DEMO_MODE = "false"',
  ];
  const requiredShopifyLines = [
    'application_url = "https://mymeridian.io"',
    'redirect_urls = [ "https://mymeridian.io/auth/callback" ]',
    "automatically_update_urls_on_dev = false",
  ];
  const missingConfig = [
    ...requiredFlyLines
      .filter((line) => !flyConfig.includes(line))
      .map((line) => `fly.toml: ${line}`),
    ...requiredShopifyLines
      .filter((line) => !shopifyConfig.includes(line))
      .map((line) => `shopify.app.production.toml: ${line}`),
  ];
  if (missingConfig.length > 0) {
    throw new Error(
      `Production configuration invariant(s) missing:\n${missingConfig.join("\n")}`,
    );
  }
}

await validateProductionConfig();
const requiredNames = [
  ...requirements.requiredEnvironment,
  ...requirements.launchConnectorSecrets,
  ...requirements.webOAuthSecrets,
];
const requiredSecretNames = requiredNames.filter(
  (name) => !requirements.staticEnvironment.includes(name),
);

if (configOnly) {
  console.log(
    `Production configuration is valid. ${requiredSecretNames.length} secret names are required before deployment.`,
  );
  process.exit(0);
}

let secretRows;
try {
  secretRows = JSON.parse(await execute("fly", ["secrets", "list", "--app", app, "--json"]));
} catch {
  throw new Error(
    "Could not inspect the Fly secret inventory. Authenticate the Fly CLI and retry; no secret value is read by this check.",
  );
}

if (!Array.isArray(secretRows)) {
  throw new Error("Fly returned an invalid secret inventory response.");
}

const present = new Set(
  secretRows
    .map((row) => (typeof row?.name === "string" ? row.name : null))
    .filter(Boolean),
);
const missing = requiredSecretNames.filter((name) => !present.has(name));
if (missing.length > 0) {
  console.error(
    `Production preflight failed: ${missing.length} required secret name(s) are absent from ${app}.\n${missing.join("\n")}`,
  );
  process.exit(1);
}

console.log(
  `Production preflight passed for ${app}: ${requiredSecretNames.length} required secret names are present. Secret values were not read.`,
);
