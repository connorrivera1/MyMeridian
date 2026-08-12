# Load and abuse testing

`npm run test:load` exercises the liveness probe, database/RLS readiness probe,
landing page and the React Router app data surface on the unified local origin.
The default run sends 75 measured requests per path at concurrency 10, after one
warm-up request. It fails on any HTTP/network error or a path p95 above 2.5
seconds. The authorized production-equivalent staging gate should override
that limit with its launch SLO.

The runner refuses non-loopback targets unless `LOAD_TEST_ALLOW_REMOTE=true` is
explicitly set. This prevents a developer command from becoming an accidental
denial-of-service against production. A remote staging run must be authorized
and should use a representative copy of the production topology, never real
customer data.

Authenticated staging tests may pass a short-lived dedicated test-session
cookie through `LOAD_TEST_COOKIE`. The runner never prints it. Revoke the
session immediately after the run; do not reuse a merchant's real browser
cookie.

Examples:

```bash
npm run test:load

LOAD_TEST_CONCURRENCY=50 \
LOAD_TEST_REQUESTS_PER_PATH=500 \
LOAD_TEST_P95_LIMIT_MS=1500 \
npm run test:load
```

For authorized staging only:

```bash
LOAD_TEST_ORIGIN=https://staging.example.com \
LOAD_TEST_ALLOW_REMOTE=true \
LOAD_TEST_CONCURRENCY=50 \
LOAD_TEST_REQUESTS_PER_PATH=1000 \
npm run test:load
```

The PostgreSQL integration suite covers the abuse properties a GET throughput
test cannot: concurrent rate-limit saturation, cross-tenant RLS reads/writes,
one-use MFA replay prevention, webhook idempotency, job claims and transaction
rollback. Run both on the release candidate.

## Local verification record

On 2026-08-12, the refreshed single-origin development server handled 375
measured requests at concurrency 10 across `/healthz`, `/readyz`, `/`,
`/app.data` and `/app/orders.data` with zero HTTP/network failures. The final
mixed run recorded p95 values of 39 ms, 34 ms, 7 ms, 808 ms and 2,064 ms
respectively, below the 2,500 ms local gate. These results do not replace the
production-equivalent staging soak required below; the exact production-like
gate is in [`DEPLOYMENT_RUNBOOK.md`](DEPLOYMENT_RUNBOOK.md).

Local results prove application behavior and catch gross regressions. They do
not establish production capacity. The local development server transforms and
server-renders modules on demand, so its full-document throughput is not a
production benchmark; the default measures the data request used by client
navigations. Before launch, repeat the test against the compiled, authorized
staging deployment and include both `/app` and `/app.data` with a dedicated
authenticated test account on production-equivalent machine size,
database pool, Redis and network placement, then run a 30-minute soak while
watching memory, CPU, database connections, queue depth, error rate and p95/p99.
