import { expect, it } from "vitest";

import { loader } from "./health.live";

it("keeps liveness non-cacheable and applies public transport headers", async () => {
  const response = await loader();

  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("strict-transport-security")).toBe(
    "max-age=31536000",
  );
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("referrer-policy")).toBe(
    "strict-origin-when-cross-origin",
  );
});
