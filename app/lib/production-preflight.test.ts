import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, it } from "vitest";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

it("keeps the no-deploy production preflight aligned with checked-in config", () => {
  const output = execFileSync(
    process.execPath,
    ["scripts/production-preflight.mjs", "--config-only"],
    { cwd: repoRoot, encoding: "utf8" },
  );

  expect(output).toContain("Production configuration is valid.");
  expect(output).toContain("31 secret names are required");
});

it("keeps the environment template complete for a production secret entry", () => {
  const requirements = JSON.parse(
    readFileSync(join(repoRoot, "config/production-readiness.json"), "utf8"),
  ) as {
    requiredEnvironment: string[];
    staticEnvironment: string[];
    launchConnectorSecrets: string[];
    webOAuthSecrets: string[];
  };
  const example = readFileSync(join(repoRoot, ".env.example"), "utf8");
  const required = [
    ...requirements.requiredEnvironment,
    ...requirements.launchConnectorSecrets,
    ...requirements.webOAuthSecrets,
  ].filter((name) => !requirements.staticEnvironment.includes(name));

  expect(required.filter((name) => !example.match(new RegExp(`^${name}=`, "m")))).toEqual(
    [],
  );
});
