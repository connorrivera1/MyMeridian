import { describe, expect, it } from "vitest";

import {
  operationalErrorKind,
  safeOperationalFailure,
} from "./operational-errors.server";

describe("safe operational errors", () => {
  it("keeps an error category without retaining its message", () => {
    const error = new Error("authorization: Bearer secret-value");

    expect(operationalErrorKind(error)).toBe("Error");
    expect(safeOperationalFailure(error)).toBe("Operation failed (Error).");
    expect(safeOperationalFailure(error)).not.toContain("secret-value");
  });

  it("rejects caller-controlled error names", () => {
    const error = new Error("token=secret-value");
    error.name = "provider response token=secret-value";

    expect(operationalErrorKind(error)).toBe("Error");
  });
});
