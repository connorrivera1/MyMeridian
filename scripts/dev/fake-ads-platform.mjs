/**
 * A local stand-in for the Meta Graph API, for debugging the ingestion queues
 * end-to-end without ad credentials:
 *
 *   node scripts/dev/fake-ads-platform.mjs          # listens on :4545
 *   MERIDIAN_META_API_BASE=http://localhost:4545 npx tsx scripts/ads-worker.ts
 *
 * Serves a EUR-billed account (act_777) with two campaigns per day across two
 * pages, so pagination, currency pinning and FX conversion all get exercised.
 * Failure injection, for watching the retry policy do its job:
 *
 *   curl -X POST localhost:4545/__mode -d '{"mode":"rate_limit","times":2}'
 *   curl -X POST localhost:4545/__mode -d '{"mode":"auth_error","times":1}'
 *   curl localhost:4545/__stats
 */
import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_ADS_PORT ?? 4545);

let mode = { mode: "ok", times: 0 };
const stats = { requests: 0, failuresServed: 0, insightsByDay: {} };

/** Deterministic per-day spend so restatement polls hash identically. */
function spendFor(day, campaign) {
  let hash = 0;
  for (const ch of `${day}:${campaign}`) {
    hash = (hash * 31 + ch.charCodeAt(0)) % 9973;
  }
  return (20 + (hash % 60) + (hash % 100) / 100).toFixed(2);
}

function campaignRow(day, id, name) {
  const spend = spendFor(day, id);
  return {
    campaign_id: id,
    campaign_name: name,
    spend,
    impressions: String(1000 + Math.round(Number(spend) * 37)),
    clicks: String(40 + Math.round(Number(spend))),
    actions: [{ action_type: "omni_purchase", value: "3" }],
    action_values: [
      { action_type: "omni_purchase", value: (Number(spend) * 4).toFixed(2) },
    ],
  };
}

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function maybeInjectFailure(res) {
  if (mode.mode === "ok" || mode.times <= 0) return false;
  mode.times -= 1;
  stats.failuresServed += 1;
  if (mode.mode === "rate_limit") {
    json(res, 429, {
      error: { message: "User request limit reached", code: 17 },
    });
  } else {
    json(res, 400, {
      error: { message: "Error validating access token", code: 190 },
    });
  }
  return true;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  stats.requests += 1;

  if (url.pathname === "/__mode" && req.method === "POST") {
    let body = "";
    for await (const chunk of req) body += chunk;
    mode = { mode: "ok", times: 0, ...JSON.parse(body || "{}") };
    return json(res, 200, mode);
  }
  if (url.pathname === "/__stats") return json(res, 200, { mode, ...stats });

  // Account profile: currency + name.
  if (url.pathname === "/act_777" && url.searchParams.has("fields")) {
    if (maybeInjectFailure(res)) return;
    return json(res, 200, { currency: "EUR", name: "Debug EUR Ads" });
  }

  // Campaign insights for one day, in two pages.
  if (url.pathname === "/act_777/insights") {
    if (maybeInjectFailure(res)) return;
    const range = JSON.parse(url.searchParams.get("time_range") ?? "{}");
    const day = range.since ?? "1970-01-01";
    stats.insightsByDay[day] = (stats.insightsByDay[day] ?? 0) + 1;

    if (url.searchParams.get("page") === "2") {
      return json(res, 200, {
        data: [campaignRow(day, "cmp-beta", "Beta Retargeting")],
      });
    }
    return json(res, 200, {
      data: [campaignRow(day, "cmp-alpha", "Alpha Prospecting")],
      paging: {
        next: `http://localhost:${PORT}/act_777/insights?page=2&time_range=${encodeURIComponent(
          JSON.stringify({ since: day, until: day }),
        )}`,
      },
    });
  }

  json(res, 404, { error: { message: `no route for ${url.pathname}` } });
});

server.listen(PORT, () => {
  console.log(`fake-ads-platform: listening on http://localhost:${PORT}`);
});
