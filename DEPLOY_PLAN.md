# Meridian deploy plan

Branch `eevee/meridian-triage`, no git remote. Nothing here has been deployed,
pushed or submitted.

**Version 2, 2026-08-05 23:58.** This supersedes the version written earlier the
same day at 18:53. That version's hosting analysis was sound and is carried
forward largely intact — the reasoning about in-process background work deciding
the host is still the right reasoning. What has changed is that three of its
facts went stale within hours of being written, and its two open questions are
now answered: there is a concrete deploy configuration in §4, and the listing
copy it declined to draft is drafted in `listing/copy.md`.

Corrections to v1 are listed in §8 rather than silently applied, because one of
them would have sent someone to run a command that no longer exists.

See `SUBMISSION.md` for the audit trail of what was fixed and why. This file is
the ordered path from here to a submitted listing.

---

## 1. Current state, verified now

| Check | Result |
|---|---|
| `git status` | Clean but for `shopify.app.toml` (a comment block from an earlier session, no functional change) and this file. |
| `npm run typecheck` | **Clean.** `react-router typegen && tsc --noEmit`. |
| `npx vitest run` | **212 tests, 20 files, all passing.** |
| `npm run build` | **Clean.** `build/client` and `build/server` both produced. |
| `npx tsx scripts/verify-data.ts` | **Clean, and byte-identical to before this session's engine changes.** P&L, product profitability, channel CAC/LTV, capacity and pricing all compute against the seeded demo shop on live Postgres. |
| `npx shopify app config --help` | Subcommands are `link`, `pull`, `use`, `validate`. **There is no `config push`.** See §8. |
| Docker / flyctl on this machine | **Neither is installed.** `docker` and `fly` are both `command not found`. Nothing containerised in §4 has been built or run. |

The code is in good shape. Nothing here blocks starting deployment work.

---

## 2. Blocker #1 — `application_url`

Still true: `shopify.app.toml` has
`application_url = "https://shopify.dev/apps/default-app-home"`, `redirect_urls`
points at the same placeholder host, and every webhook `uri` is relative and
resolves against it. So all four mandatory webhooks currently resolve to a host
Shopify cannot deliver to. Shopify separately rejects an `application_url`
containing the word "Shopify", so this exact string fails twice over.

Nothing else in the repo names a deployment target: no `Dockerfile`, `fly.toml`,
`vercel.json`, `render.yaml` or `railway.json`; `SHOPIFY_APP_URL` in `.env` is
`http://localhost:3000`; `.shopify/` holds a CLI project link and no host.

This is the one item everything else waits on.

---

## 3. Hosting decision — Fly.io

Carried forward from v1, and re-verified. The deciding constraint is not
framework preference, it is that **this app does long-running work in the
request process**:

- `app/shopify.server.ts`'s `afterAuth` calls `startBackfill(shop.id, admin)`
  **without `await`** — genuinely fire-and-forget, kicked off from the handler
  that is about to return the OAuth redirect.
- The backfill walks the store's entire order history (cap 20,000 orders) and
  re-acquires its admin token every 40 minutes because it expects to outlive an
  hour-long access token.
- It holds a real TCP connection to Postgres throughout.

Anything that treats the process as disposable once the response is written will
kill that import mid-run and leave a plausible-looking partial dataset — the
worst possible failure, because it looks like data rather than like an error.

| Option | Fit | Why |
|---|---|---|
| **Fly.io** | **Recommended** | Long-lived container, managed Postgres or bring-your-own, cheap always-on small VM, `fly deploy` from a Dockerfile, custom domain and free TLS. The in-process backfill keeps working correctly with no code change. |
| Railway | Close second | Same long-lived-process model, easier Postgres, but usage-based pricing is less predictable. Fine as a fallback. |
| Render | Viable | Long-lived service plus managed Postgres. The free tier spins down on idle, which would kill a backfill on a cold start — paid tier from day one or not at all. |
| Vercel | **Not as-is** | Serverless functions have execution limits and no guarantee the process outlives the response. Directly hostile to the current backfill. Would need a real job queue first, which is a genuine architecture change and the wrong thing to do just to unblock submission. |
| ngrok / cloudflared | **Test only** | A tunnel is enough to exercise OAuth, webhooks and billing locally (Phase 2), but Shopify does not accept a tunnel URL as `application_url` — it is not stable and disappears with the dev session. Use it to test, never to submit. |

**Decision: Fly.io.** Deploy there, take the `*.fly.dev` subdomain (or attach a
real domain if there is one), set that as `application_url`, and do not block
submission on moving the backfill to a job queue — Fly's model tolerates it
correctly today. Revisit post-submission (§9).

---

## 4. Deploy configuration

✅ **Superseded 2026-08-06 — both files are now built, booted and committed.**
Docker and flyctl were installed on this machine and the Dockerfile below was
built and run; see §11 for exactly what was verified and the three corrections
to §5 that came out of it. The files now live in the repo root rather than only
here. The paragraph that used to be here said the first `fly deploy` should be
treated as a debugging pass — that is no longer the expectation, though §11
lists the two things that still cannot be checked without a Fly account.

The text below is retained verbatim as the source the committed files were
written from.

### `Dockerfile`

```dockerfile
# syntax=docker/dockerfile:1
ARG NODE_VERSION=22.14.0

FROM node:${NODE_VERSION}-slim AS base
ENV NODE_ENV=production
WORKDIR /app
# Prisma's query engine links against OpenSSL and the slim image has neither it
# nor the CA bundle Postgres TLS needs.
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# --- build -----------------------------------------------------------------
FROM base AS build
RUN apt-get update -qq \
 && apt-get install -y --no-install-recommends python3 build-essential \
 && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
# NODE_ENV=production is inherited from base, so dev dependencies have to be
# asked for explicitly — vite, the react-router compiler and the prisma CLI are
# all needed to build.
RUN npm ci --include=dev
COPY . .
# package.json: "build": "prisma generate && react-router build"
RUN npm run build
# Drop dev dependencies, but put the prisma CLI back: the Fly release command
# runs `prisma migrate deploy` from this image, and a CLI whose version has
# drifted from @prisma/client 6.19.3 is a real and confusing failure mode.
RUN npm prune --omit=dev && npm install --no-save prisma@6.19.3

# --- runtime ---------------------------------------------------------------
FROM base
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/build        /app/build
COPY --from=build /app/prisma       /app/prisma
COPY --from=build /app/package.json /app/package.json

ENV PORT=8080
EXPOSE 8080
CMD ["./node_modules/.bin/react-router-serve", "./build/server/index.js"]
```

### `fly.toml`

```toml
app = "meridian-profit"
primary_region = "iad"

[build]

[env]
  NODE_ENV = "production"
  PORT = "8080"
  # app/lib/auth.server.ts throws at boot if this is "true" while
  # NODE_ENV=production. That is deliberate — the demo path bypasses Shopify
  # session authentication — so this is not an optional line.
  MERIDIAN_DEMO_MODE = "false"

[deploy]
  # Runs on a temporary machine before the new version takes traffic. There are
  # six migrations in prisma/migrations, none applied to a production database.
  release_command = "npx prisma migrate deploy"

[http_service]
  internal_port = 8080
  force_https = true

  # THE IMPORTANT LINES. afterAuth starts the historical import without
  # awaiting it, so the process must outlive the response that started it.
  # A machine that suspends when the request queue drains will kill a running
  # backfill and leave a half-imported store that looks fine.
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1

  [[http_service.checks]]
    method = "GET"
    # Not "/". With Shopify credentials present, the index route redirects to
    # /auth/login (302) — see app/routes/home.tsx. /privacy is public,
    # unauthenticated and returns 200, which is what a health check wants.
    path = "/privacy"
    interval = "30s"
    timeout = "5s"
    grace_period = "20s"

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory_mb = 1024
```

---

## 5. Exact deploy sequence

Run from the repo root. Steps 3 and 6 touch credentials and are **Connor's to
run** — nothing in this session has read or written a Shopify secret.

```sh
# 1. Write the two files from §4 into the repo root.

# 2. Create the app and its database. `fly launch` will offer to generate its
#    own Dockerfile — decline, the one in §4 handles Prisma's OpenSSL and the
#    migrate CLI.
fly launch --no-deploy --name meridian-profit --region iad
fly postgres create --name meridian-db --region iad
fly postgres attach meridian-db --app meridian-profit   # sets DATABASE_URL

# 3. Secrets. CONNOR — this line carries credentials.
#    MERIDIAN_ENCRYPTION_KEY must be generated ONCE and never rotated casually:
#    it decrypts stored connector tokens, and a new key orphans them silently.
fly secrets set \
  SHOPIFY_API_KEY="<from Partner Dashboard>" \
  SHOPIFY_API_SECRET="<from Partner Dashboard>" \
  SCOPES="read_orders,read_products,read_fulfillments,read_inventory" \
  SHOPIFY_APP_URL="https://meridian-profit.fly.dev" \
  MERIDIAN_ENCRYPTION_KEY="$(openssl rand -base64 32)" \
  MERIDIAN_SUPPORT_EMAIL="<a real, monitored inbox>" \
  MERIDIAN_LEGAL_ENTITY="<the entity the app is published under>" \
  --app meridian-profit

# 4. Deploy. release_command applies the six migrations first.
fly deploy --app meridian-profit

# 5. Confirm the origin is real before pointing Shopify at it. Both are public
#    and unauthenticated, and both must show a real support contact rather than
#    the "not configured" notice — that notice means step 3's last two secrets
#    did not land.
curl -sS -o /dev/null -w '%{http_code}\n' https://meridian-profit.fly.dev/privacy
curl -sS -o /dev/null -w '%{http_code}\n' https://meridian-profit.fly.dev/support
fly logs --app meridian-profit          # expect no boot error

# 6. Point the app config at it. CONNOR — this writes to the Partner Dashboard.
#    Edit shopify.app.toml first (see below), then:
npx shopify app config validate
npx shopify app deploy --message "Real production origin"
```

### The `shopify.app.toml` edit in step 6

```toml
application_url = "https://meridian-profit.fly.dev"

[auth]
redirect_urls = [ "https://meridian-profit.fly.dev/auth/callback" ]
```

`/auth/callback` and not `/api/auth` — `authPathPrefix` is `/auth`, and the
Remix template's default path is a route this app does not have. That was
already fixed; it just has to keep tracking the host.

The webhook `uri` values are relative and need no edit at all. That is the whole
point of them being relative, and it is why fixing `application_url` fixes all
four mandatory webhooks at once.

**Then change one more line, or this will come undone:**

```toml
[build]
automatically_update_urls_on_dev = false   # currently true
```

While it is `true`, `shopify app dev` rewrites `application_url` and
`redirect_urls` in this file to whatever tunnel it opened. Run `shopify app dev`
once after going live, deploy without re-reading the diff, and production is
pointed at a dead tunnel. The alternative, if the convenience is wanted during
Phase 2, is a second linked config — `shopify app config link` writes
`shopify.app.<name>.toml` and `shopify app config use` switches between them —
so the dev tunnel never touches the production file.

`include_config_on_deploy = true` is already set, which is what makes
`shopify app deploy` push `application_url` and the webhook subscriptions along
with the version. There is no separate config-push step; see §8.

---

## 6. Partner Dashboard — human only

None of this is code and none of it can be done from this repo. It needs a
signed-in Partner account.

**a. Opt into manual pricing (Billing API), not Shopify App Pricing.**
Partner Dashboard → the app → Pricing. The app creates its own charges from
`PLANS` in `app/shopify.server.ts`, so no plan needs typing in by hand, but the
app must not be on managed App Pricing. Note that App Pricing is now the
**default** selection here, so this is an explicit opt-out and may draw a
reviewer question; requirement 1.2.1 permits either, in as many words. The
reasoning is a cost argument, not an impossibility one: since 28 April 2026 App
Pricing sends no subscription webhooks, and plan reads move off the Admin API
onto the Partner API plus the `plan_handle` redirect parameter — a second
credential and a non-Admin-API dependency, for no requirement gain, against a
billing implementation that is already finished and gated. Re-verified against
live shopify.dev docs on 6 August 2026; quotes and URLs are in `SUBMISSION.md`
§ "Billing". An earlier version of this paragraph said App Pricing plans could
not be read from a merchant session at all, which is wrong. The three plans are
Starter $49, Growth $149, Scale $399, all 30-day interval, USD, 14-day trial.

**b. Protected Customer Data request — `read_customers`.**
Partner Dashboard → the app → API access → Protected customer data. A form with
a written justification and a data-handling questionnaire. Needed for CAC,
lifetime value, payback and the loss-leader/bleeding distinction. The app
degrades honestly without it — the Acquisition screen explains its own absence
rather than showing zeroes — so this is not a hard gate on first submission, but
**start it early**: it runs on Shopify's own review clock, separate from app
review. Note the scope is deliberately absent from `shopify.app.toml` today;
adding it before the request is approved is what breaks OAuth, not what fixes it.

**c. `read_all_orders` access request.**
Same screen, separate request, same reasoning. Without it Shopify caps order
history at 60 days, which is a real limitation for a profitability tool — the
app detects the cap and shows a persistent banner about it. Worth requesting
even if submission proceeds without it.

**d. Emergency developer contact.**
Partner Dashboard → the app → App setup. Email **and phone**, and it is a
different field from the support contact on the listing. Needs Connor's real
phone number.

**e. Support email and legal entity.**
Not a Dashboard field but the same category of decision — set as the secrets in
§5 step 3. `/privacy` and `/support` render an explicit "not configured" notice
until they are, which a reviewer will see. See `listing/copy.md` §*Needs the
owner*.

**f. Demo store URL for the reviewer.**
A development store in the Partner org with the app installed and enough real
data to click through. Depends on Phase 2.

---

## 7. Listing

Copy is now drafted and paste-ready in **`listing/copy.md`** — name, intro,
details and feature bullets, every one measured against its character limit
rather than estimated, and every claim traced to the code that makes it true.

Assets state:

| Item | State |
|---|---|
| App icon 1200×1200 | Done — `listing/app-icon-1200.png` |
| Screenshots 1600×900 ×6 | Done — `listing/screenshots/` |
| Privacy policy URL | Done — `/privacy`, public |
| Support page | Done — `/support`, public |
| Name / intro / details / features | **Drafted** — `listing/copy.md` |
| Support email + legal entity | **Owner** — §6e |
| Feature media (1600×900 or 2–3 min video) | **Missing** |
| Demo store URL | **Missing** — §6f |
| Setup screencast | **Missing — automatic bounce without it** |

The screencast is the one that cannot be worked around. It has to show a real
OAuth install through to a first dashboard view; the app has never been
installed on any store, and it cannot be filmed against the demo bypass because
that bypass is precisely what the recording exists to prove is not being used.
Record it during Phase 2's real install rather than staging the whole flow twice.

`listing/copy.md` also raises one thing that is not a copy question: the app
sells "unlimited ad channels + blended CAC" on the plan screen and has no ad
platform OAuth at all — `AdSpend` rows are written only by the seed script. The
drafted copy claims nothing about ad performance for that reason. Reconciling the
plan blurbs is Connor's call and it is worth making before a reviewer walks the
billing screen.

---

## 8. Corrections to v1 of this plan

v1 was accurate when written at 18:53. Four things have changed since, three of
them because the work landed:

1. **`shopify app config push` does not exist.** v1's step 8 said to run it. On
   the pinned CLI (`@shopify/cli ^4.6.0`, checked with `npx shopify app config
   --help`) the subcommands are `link`, `pull`, `use` and `validate`. Config is
   pushed by `shopify app deploy`, which works here because
   `include_config_on_deploy = true`. Following v1 literally would have failed
   at the last and most important step.
2. **Test count.** v1 said 178 tests in 16 files. It is now **212 in 20** — the
   first-order, resume and data-export commits landed after v1 was written, plus
   15 from this session.
3. **`Shop.syncCursor` is no longer write-only.** v1 listed "written but never
   read" as a fast-follow. Commit `200a350` reads it; an interrupted import now
   resumes from the cursor instead of restarting.
4. **`Order.fulfillments(first: 10)` is no longer a silent truncation.** v1
   listed it as an outstanding gap. Commit `e98b83d` refetches at 250 when
   `fulfillmentsCount` says there are more.

v1's §5 also treated the unbounded dashboard loaders as a pure fast-follow. Half
of that is now done — see §9.

---

## 9. Worklist

### Must happen before submission
- **Blocker #1 — a real `application_url`** (§2–§5). Cannot pass review without it.
- **Partner Dashboard items** (§6a, §6d) and the listing gaps in §7.
- **Support email / legal entity actually set** (§6e), or a reviewer sees the
  "not configured" notice on the two pages the listing links to.

### Done this session, previously on this list
- **Dashboard loaders.** Two of the three costs named in `SUBMISSION.md`
  blocker 4 are fixed. `loadEngineOrders` no longer hydrates every fulfilment
  row to add two columns up in JavaScript — Postgres does the sum
  (`fdd75cb`). And `loadDashboard` no longer builds a second complete
  `ShopAnalytics` for the comparison window, which was running a second 365-day
  cohort scan, a second capacity query, a second product-meta query and four
  engine passes on every page load in order to read eight scalars (`381e47f`).
  Both were proved number-for-number: 15 new tests, and `verify-data.ts` output
  byte-identical against live Postgres.

### Still open, safe as a fast-follow
- **`loadEngineOrders` is still unbounded.** The current window still has no
  `take`, and it cannot simply get one: the P&L, the ad attribution and the
  overhead proration are all period-wide, so a truncated set of orders would
  produce a confidently wrong profit figure rather than a slow one. Bounding it
  properly means computing the roll-up in SQL, which means a second
  implementation of the profit formula — the exact duplicate-definition bug this
  codebase has spent the session removing elsewhere. Worth doing deliberately
  and with a live-database differential test, not as a quick patch, and not
  before submission: Shopify samples Core Web Vitals post-install over 28 days,
  not at review.
- **Orders table pages a materialised array.** `PAGE_SIZE = 60` slices in
  memory, so the database work is identical on page 1 and page 40. Same root
  cause as above.
- **In-process backfill and recompute.** Designed around in §3 rather than
  fixed. Correct to defer — fixing it means a real job queue, which is an
  architecture change with its own risk. Do it if the host ever changes.
- **Thin coverage on `backfill.server.ts`.** 1,261 lines, no direct unit test
  file; the adjacent pagination and GraphQL-shaping tests do not touch the
  orchestration. Not a review criterion, but it is the highest-blast-radius path
  in the app. Phase 2's real-store run is the integration test that matters most
  right now.
- **Order-level stored profit is a write-only cache**, and **ad connectors have
  no live OAuth** (§7). Neither affects OAuth, webhook or billing compliance.

---

## 10. Phases

```
Phase 1 — A real origin
  1a. Write Dockerfile and fly.toml from §4
  1b. fly launch, fly postgres create/attach
  1c. fly secrets set  (CONNOR — credentials)
  1d. fly deploy; curl /privacy and /support for 200 and a real contact
  1e. Edit shopify.app.toml: application_url, redirect_urls,
      automatically_update_urls_on_dev = false
  1f. shopify app deploy  (CONNOR — writes to the Partner Dashboard)
  -> Unblocks webhook delivery, the OAuth callback, and everything after

Phase 2 — Exercise it for real
  2a. A Partner development store
  2b. Install for real. First live test of session storage, token exchange
      and the backfill — given the session-storage defect this session fixed,
      it is likely no install has ever succeeded, so treat this as a first
      test rather than a regression check
  2c. Watch the backfill finish on real volume; this is what validates §3
  2d. Fire each webhook for real: place an order, request and redact customer
      data, uninstall and reinstall
  2e. Walk billing.request end to end — approval screen, return redirect,
      and billing.check gating Pricing, Fulfilment and Acquisition
  2f. Record the setup screencast during this pass
  -> Unblocks the screencast, and confidence in everything above

Phase 3 — Partner Dashboard        Phase 4 — Listing
  §6a manual pricing                 4a. Paste from listing/copy.md
  §6b protected customer data        4b. Feature media
  §6c read_all_orders                4c. Attach the Phase 2 screencast
  §6d emergency contact              4d. Reconcile the ad-spend claim (§7)
  §6f demo store URL
  -> Both run in parallel with each other and with the tail of Phase 2.
     Start 3b and 3c first: they run on Shopify's clock, not ours.

Phase 5 — Submit
  5a. npx shopify app config validate
  5b. Submit for review
```

Critical path: Phase 1 blocks Phase 2; Phase 2's real install blocks the
screencast and blocks knowing the backfill survives real data. Phases 3 and 4
run alongside.

---

## Where this leaves it

The code is submission-ready in the sense that matters: it typechecks, 212 tests
pass, it builds, and the engine produces correct numbers against a live
database — the same numbers, verified, after this session's changes to it.

What remains is almost entirely infrastructure and business decisions:

1. **Nobody has run a deploy.** The host is picked and, as of 2026-08-06, the
   §4 files are built and booted rather than merely written (§11). What is left
   is a Fly account and the six commands in §5 — a sequence to execute, and now
   one that has been rehearsed everywhere it can be without an account.
2. **Nothing has ever touched real Shopify credentials.** Phase 2 is the first
   trial by fire for the session-storage fix, the backfill and billing, all of
   which have only ever been verified against mocks or a local unauthenticated
   server.
3. **Three things genuinely need Connor** and cannot be produced here: the
   support email and legal entity, the emergency contact phone number, and the
   setup screencast — which needs a real install that does not exist yet.

---

## 11. Build verification, 2026-08-06

§1 and §4 both rested on "this machine has no Docker and no flyctl". That is no
longer true, so the claim §4 could not make has now been checked.

**Tooling installed:** flyctl 0.4.79 (`~/.fly/bin`, added to `~/.zshrc`), and
Colima 0.10.3 + Docker CLI 29.7.1 as the container runtime — Docker Desktop was
never installed and Colima needs no license and no GUI. Docker daemon 29.5.2,
4 CPU / 6 GB / 40 GB, `vz` VM type.

### What was verified against the actual image

| Check | Result |
|---|---|
| `docker build .` | **Succeeds**, first attempt, no edits to §4's Dockerfile. 790 MB image. |
| Prisma client survives `npm prune --omit=dev` | **Yes.** `require('@prisma/client')` loads and reports 6.19.3, and `libquery_engine-linux-arm64-openssl-3.0.x.so.node` is present in the runtime stage. This was the step most likely to silently break, and it does not. |
| `openssl` / `ca-certificates` in base | **Load-bearing and correct.** The computed binary target is `openssl-3.0.x`, which is what bookworm-slim provides once those packages are installed. |
| Server boots | **Yes.** `react-router-serve` comes up and is serving in about two seconds, so fly.toml's 20s `grace_period` is comfortable. |
| `GET /privacy` | **200.** The health check path in fly.toml is right. |
| `GET /support` | **200.** |
| `release_command` — `npx prisma migrate deploy` | **Runs from inside the image** against a real Postgres, finds **6 migrations**, exits clean. The prisma CLI reinstalled after the prune resolves without a network fetch. |
| `/privacy` and `/support` contact block | Both render the **"not configured on this deployment"** notice when `MERIDIAN_SUPPORT_EMAIL` / `MERIDIAN_LEGAL_ENTITY` are unset — confirming §6e is a real reviewer-visible gate, not a theoretical one. |
| `fly.toml` | Parses, and every key lands where Fly's schema expects it. `fly config validate` itself needs an account and was not run. |
| `npx vitest run` | **290 tests in 24 files, all passing.** §1 and §8 say 212 in 20; more landed after this plan was written. |

### The one fix the build required

**`.dockerignore` did not exist, and the Dockerfile needs one.** §4 runs
`npm ci --include=dev` and *then* `COPY . .`. With no ignore file, the host's
`node_modules` is copied straight over the freshly installed Linux tree — every
native binary in it, Prisma's query engine included, is darwin-arm64. `COPY . .`
also swept in `.env`, baking the local Postgres URL and Shopify keys into the
image layers. Both are fixed by the committed `.dockerignore`; nothing in §4's
two files was changed.

### Corrections to §5

1. **§5 has no `fly auth login`.** Step 2 opens with `fly launch`, which fails
   with `no access token available` on a fresh flyctl. Log in first.
2. **`fly launch` will stop and ask about the existing `fly.toml`.** It now
   exists in the repo root, so the command prompts to reuse it. Answer yes, or
   pass `--copy-config` to skip the question. Do **not** let it write its own
   Dockerfile — it will not, because one is already present, which is the
   outcome §5's "decline" note was after.
3. **`fly postgres` is now the *unmanaged* option and says so.** flyctl 0.4.79
   prints a banner: unmanaged Postgres "is not supported by Fly.io Support and
   users are responsible for operations, management, and disaster recovery",
   pointing at `fly mpg` (Managed Postgres) instead. §5's commands still exist
   and still work. But this is a profitability tool holding a store's entire
   order history, and choosing who owns disaster recovery for it is a decision
   worth making deliberately rather than by following a command written before
   the banner appeared. `fly mpg create` / `fly mpg attach` are the managed
   equivalents.

Two further things were confirmed while the image was up, both of which back
claims made elsewhere in this file: the container idles at **51 MiB** serving
requests, so §4's 1024 MB VM has room, and booting with
`MERIDIAN_DEMO_MODE=true` while `NODE_ENV=production` **does** abort the
process — `Error: MERIDIAN_DEMO_MODE must not be enabled when
NODE_ENV=production` — so §4's comment on that line is accurate.

### Two things that still cannot be checked here

- **A full amd64 build.** This is an Apple Silicon Mac, so the image built and
  booted above is arm64; Fly machines are x86_64. Building the whole Dockerfile
  for `linux/amd64` locally does not work, but for a reason that has nothing to
  do with this app: esbuild's Go binary crashes under qemu user-mode emulation
  (`failed to load config from /app/vite.config.ts` → "The service was
  stopped", with a Go goroutine dump from
  `esbuild/cmd/esbuild/service.go`). Rosetta would emulate x86_64 well enough,
  but Colima would not register it as the binfmt handler here. **This is an
  emulation artifact and not a defect — nothing in the normal path emulates
  anything.** Plain `fly deploy` builds on Fly's own remote builder, which is
  native amd64, from this same Dockerfile.

  The part of the image that genuinely is architecture-dependent was checked on
  amd64 directly, since it is the only part that could break: in an
  `--platform linux/amd64` container, `npm ci` against this exact lockfile
  succeeds, `prisma generate` emits
  `libquery_engine-debian-openssl-3.0.x.so.node` — matching the OpenSSL 3.0.20
  that bookworm-slim ships — and `new PrismaClient()` loads it. Everything else
  in the image is plain JavaScript.

  What follows from this is one rule: **do not run `fly deploy --local-only`**
  on this machine. It would either fail the same way, or push an arm64 image to
  an amd64 machine. The default remote builder is correct; let it do the work.
- **The app name.** `meridian-profit` is assumed free on Fly; confirming that
  needs an account. If it is taken, the new name has to change in four places
  at once: `app` in `fly.toml`, `SHOPIFY_APP_URL` in §5 step 3, and
  `application_url` plus `redirect_urls` in `shopify.app.toml`.

Nothing in this session touched a Fly account, a Shopify secret, or the Partner
Dashboard. §5 steps 2 through 6 are unchanged and remain Connor's to run.
