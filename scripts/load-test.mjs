import { performance } from "node:perf_hooks";

const origin = new URL(process.env.LOAD_TEST_ORIGIN ?? "http://127.0.0.1:3130");
const concurrency = positiveInteger("LOAD_TEST_CONCURRENCY", 10);
const requestsPerPath = positiveInteger("LOAD_TEST_REQUESTS_PER_PATH", 75);
const timeoutMs = positiveInteger("LOAD_TEST_TIMEOUT_MS", 10_000);
const p95LimitMs = positiveInteger("LOAD_TEST_P95_LIMIT_MS", 2_500);
const paths = (process.env.LOAD_TEST_PATHS ?? "/healthz,/readyz,/,/app.data")
  .split(",")
  .map((value) => value.trim())
  .filter(Boolean);

if (
  !["127.0.0.1", "localhost", "::1"].includes(origin.hostname) &&
  process.env.LOAD_TEST_ALLOW_REMOTE !== "true"
) {
  throw new Error(
    "Refusing to load-test a remote host. Set LOAD_TEST_ALLOW_REMOTE=true only after the target owner authorizes the test.",
  );
}
if (paths.length === 0) throw new Error("LOAD_TEST_PATHS contains no paths.");

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return value;
}

function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)
  ];
}

async function request(path) {
  const started = performance.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(path, origin), {
      redirect: "manual",
      signal: controller.signal,
      headers: {
        "user-agent": "MyMeridian authorized load test",
        ...(process.env.LOAD_TEST_COOKIE
          ? { cookie: process.env.LOAD_TEST_COOKIE }
          : {}),
      },
    });
    await response.arrayBuffer();
    return {
      path,
      status: response.status,
      ok: response.status >= 200 && response.status < 400,
      durationMs: performance.now() - started,
    };
  } catch (error) {
    return {
      path,
      status: 0,
      ok: false,
      durationMs: performance.now() - started,
      error: error instanceof Error ? error.name : "UnknownError",
    };
  } finally {
    clearTimeout(timer);
  }
}

for (const path of paths) {
  const warmup = await request(path);
  if (!warmup.ok) {
    throw new Error(`Warm-up failed for ${path} with status ${warmup.status}.`);
  }
}

const jobs = paths.flatMap((path) =>
  Array.from({ length: requestsPerPath }, () => path),
);
let cursor = 0;
const results = [];
const started = performance.now();

await Promise.all(
  Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
    while (true) {
      const index = cursor++;
      if (index >= jobs.length) return;
      results.push(await request(jobs[index]));
    }
  }),
);

const elapsedMs = performance.now() - started;
const rows = paths.map((path) => {
  const matching = results.filter((result) => result.path === path);
  const durations = matching.map((result) => result.durationMs);
  return {
    path,
    requests: matching.length,
    failures: matching.filter((result) => !result.ok).length,
    p50Ms: Math.round(percentile(durations, 0.5)),
    p95Ms: Math.round(percentile(durations, 0.95)),
    p99Ms: Math.round(percentile(durations, 0.99)),
    maxMs: Math.round(Math.max(...durations)),
  };
});

console.table(rows);
console.log(
  `${results.length} requests in ${(elapsedMs / 1_000).toFixed(2)}s ` +
    `(${(results.length / (elapsedMs / 1_000)).toFixed(1)} req/s), concurrency ${concurrency}.`,
);

const failures = rows.filter(
  (row) => row.failures > 0 || row.p95Ms > p95LimitMs,
);
if (failures.length > 0) {
  for (const row of failures) {
    console.error(
      `${row.path} failed threshold: failures=${row.failures}, p95=${row.p95Ms}ms, limit=${p95LimitMs}ms.`,
    );
  }
  process.exitCode = 1;
}
