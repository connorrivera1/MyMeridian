import { describe, expect, it } from "vitest";

import { reauthenticationIsFresh } from "./reauth.server";

describe("fresh reauthentication", () => {
  const now = new Date("2026-08-11T22:30:00Z");

  it("accepts only recent, non-future proof", () => {
    expect(reauthenticationIsFresh(new Date(now.getTime() - 60_000), now)).toBe(
      true,
    );
    expect(
      reauthenticationIsFresh(new Date(now.getTime() - 16 * 60_000), now),
    ).toBe(false);
    expect(reauthenticationIsFresh(new Date(now.getTime() + 1), now)).toBe(
      false,
    );
    expect(reauthenticationIsFresh(null, now)).toBe(false);
  });
});
