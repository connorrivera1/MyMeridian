import { expect, it } from "vitest";

import { inlineScriptHashes } from "./public-document-security.server";

it("hashes inline scripts and ignores external script tags", () => {
  expect(
    inlineScriptHashes(
      '<script>window.inline = true;</script><script src="/app.js"></script>',
    ),
  ).toEqual(["'sha256-5n2DSRDGaWy2SggN68iONM84vDSa6opmut5FktFmjLE='"]);
});
