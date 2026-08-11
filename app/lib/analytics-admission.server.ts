/**
 * One process-wide gate for work that holds a complete order graph in memory.
 *
 * The production Node image gets a 524 MiB V8 heap on the 1 GB Fly machine. A
 * single admitted 60k-order build can use roughly 390 MB while Prisma's graph
 * and the engine output coexist, so analytics and materialisation jobs must not
 * overlap. This does not serialize webhooks, settings queries, cached responses
 * or any other cheap request.
 */
let tail = Promise.resolve();

export function withAnalyticsAdmission<T>(
  operation: () => Promise<T>,
): Promise<T> {
  const waitFor = tail;
  let release!: () => void;
  tail = new Promise<void>((resolve) => {
    release = resolve;
  });

  return waitFor.then(operation).finally(release);
}
