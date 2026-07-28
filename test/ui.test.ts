import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeText } from "../src/ui/side-chat.ts";

test("side-chat transcript sanitizes terminal control characters", () => {
  assert.equal(sanitizeText("\u001b[31mred\u001b[0m\ttext\u0007"), "red  text");
});
