import { expect, it } from "vitest";

import { HONEYPOT_FIELD, honeypotTriggered } from "./form-anti-bot";

it("accepts an untouched honeypot and rejects filled, duplicate, or file values", () => {
  const empty = new FormData();
  empty.set(HONEYPOT_FIELD, "  ");
  expect(honeypotTriggered(empty)).toBe(false);

  const duplicate = new FormData();
  duplicate.append(HONEYPOT_FIELD, "");
  duplicate.append(HONEYPOT_FIELD, "filled");
  expect(honeypotTriggered(duplicate)).toBe(true);

  const file = new FormData();
  file.set(HONEYPOT_FIELD, new Blob(["not text"]), "bot.txt");
  expect(honeypotTriggered(file)).toBe(true);
});
