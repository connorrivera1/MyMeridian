import { describe, expect, it } from "vitest";

import { withAnalyticsAdmission } from "./analytics-admission.server";

describe("analytics memory admission", () => {
  it("allows only one memory-heavy operation to run at a time", async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;

    const first = withAnalyticsAdmission(async () => {
      events.push("first:start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      events.push("first:end");
    });
    const second = withAnalyticsAdmission(async () => {
      events.push("second:start");
      events.push("second:end");
    });

    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  it("releases the next operation after a failure", async () => {
    const failed = withAnalyticsAdmission(async () => {
      throw new Error("analytics failed");
    });
    const next = withAnalyticsAdmission(async () => "ran");

    await expect(failed).rejects.toThrow("analytics failed");
    await expect(next).resolves.toBe("ran");
  });
});
