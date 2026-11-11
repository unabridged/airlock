// Airlock — the purpose line (node --test test/purpose.test.mjs).
//
// The purpose is the model's claim about why a call exists, and it is required.
// These tests pin the two halves of that: what makes a claim readable in one
// glance above a command, and what the model is told when it is not.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { checkPurpose, formatPurposeViolations, MAX_PURPOSE_CHARS } from "../src/purpose.mjs";

describe("checkPurpose", () => {
  it("accepts one short line, trimmed", () => {
    const result = checkPurpose("  check whether the staging queue is draining  ");
    assert.equal(result.ok, true);
    assert.equal(result.purpose, "check whether the staging queue is draining");
    assert.deepEqual(result.violations, []);
  });

  it("requires a purpose: absent, empty, and whitespace all say so", () => {
    for (const value of [undefined, null, "", "   "]) {
      const result = checkPurpose(value);
      assert.equal(result.ok, false, JSON.stringify(value));
      assert.equal(result.violations[0].rule, "missing");
    }
  });

  it("rejects a paragraph: the purpose is one line above the command", () => {
    const result = checkPurpose("first line\nsecond line");
    assert.equal(result.ok, false);
    assert.equal(result.violations[0].rule, "one line");
  });

  it(`rejects more than ${MAX_PURPOSE_CHARS} characters`, () => {
    const result = checkPurpose("x".repeat(MAX_PURPOSE_CHARS + 1));
    assert.equal(result.ok, false);
    assert.match(result.violations.at(-1).message, new RegExp(`the limit is ${MAX_PURPOSE_CHARS}`));
  });

  it("accepts exactly the limit", () => {
    assert.equal(checkPurpose("x".repeat(MAX_PURPOSE_CHARS)).ok, true);
  });

  it("rejects what the overlay cannot render faithfully", () => {
    for (const value of ["a\tb", "a\u202eb", "a\u00a0b", "a\u200bb"]) {
      const result = checkPurpose(value);
      assert.equal(result.ok, false, JSON.stringify(value));
      assert.equal(result.violations[0].rule, "character", JSON.stringify(value));
    }
  });
});

describe("formatPurposeViolations", () => {
  it("names what is wrong, says the human has not seen it, and says not to retry", () => {
    const { violations, purpose } = checkPurpose("");
    const text = formatPurposeViolations(violations, purpose);
    assert.match(text, /^send_terminal rejected before approval: the purpose line is not usable/);
    assert.match(text, /The human has NOT seen it\./);
    assert.match(text, /\[missing\]/);
    assert.match(text, /Fix every item and resend/);
  });
});
