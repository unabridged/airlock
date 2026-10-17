// Airlock — rails_irb completion over a slow link (node --test): a scripted
// pane renders a bracketed paste one row at a time, the way a console behind
// SSH does, so the driver's completion proof can be tested against the rows
// it sees mid-paste.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createRailsIrbDriver, pastedLineCount, pasteConsumed } from "../src/drivers/rails-irb.mjs";

const ROW_INTERVAL_MS = 120;
// Longer than several completion polls, so a predicate that accepts the
// blank row's prompt has every chance to fire on it.
const BLANK_ROW_HOLD_MS = 600;

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function stockPrompt(counter, sigil = ">") {
  return `irb(main):${String(counter).padStart(3, "0")}${sigil} `;
}

// A stock IRB behind a slow link. Each pasted line advances the counter by
// one; a blank line inside the paste renders as a bare ready-shaped prompt,
// and the result and the next prompt arrive only after the last row.
class SlowIrbPane {
  constructor({ results }) {
    this.results = results;
    this.counter = 1;
    this.rows = [stockPrompt(this.counter)];
    this.pastedLines = null;
  }

  async hasSession() {
    return true;
  }

  async capturePane() {
    return this.rows.join("\n");
  }

  async cursorAndScreenState() {
    return { cursorX: this.rows.at(-1).length, alternateScreen: false };
  }

  async displayMessage() {
    return "0,2000";
  }

  async pasteText(text) {
    this.pastedLines = text.split("\n");
  }

  async sendEnter() {
    const lines = this.pastedLines;
    this.pastedLines = null;
    void this.render(lines);
  }

  async render(lines) {
    this.rows[this.rows.length - 1] += lines[0];
    for (const line of lines.slice(1)) {
      await sleep(ROW_INTERVAL_MS);
      this.counter += 1;
      if (line === "") {
        this.rows.push(stockPrompt(this.counter));
        await sleep(BLANK_ROW_HOLD_MS);
        this.rows[this.rows.length - 1] = stockPrompt(this.counter, "*");
      } else {
        this.rows.push(stockPrompt(this.counter, "*") + line);
      }
    }
    await sleep(ROW_INTERVAL_MS);
    this.counter += 1;
    this.rows.push(`=> ${this.results.shift()}`, stockPrompt(this.counter));
  }
}

const TIMEOUTS = { openMs: 10_000, commandMs: 10_000 };
const OUTPUT_CAP = { maxLines: 400, maxBytes: 65536 };

describe("pastedLineCount", () => {
  it("counts the lines a paste hands IRB, trailing newlines excluded", () => {
    assert.equal(pastedLineCount("1 + 2"), 1);
    assert.equal(pastedLineCount("total = 1\n\nputs total"), 3);
    assert.equal(pastedLineCount("total = 1\n\n"), 1);
  });
});

describe("pasteConsumed", () => {
  it("requires the counter to advance by the paste's full line count", () => {
    const paste = { preCommandCounter: 5, lineCount: 3 };
    assert.equal(pasteConsumed({ ...paste, counter: 5 }), false);
    assert.equal(pasteConsumed({ ...paste, counter: 6 }), false);
    assert.equal(pasteConsumed({ ...paste, counter: 7 }), false);
    assert.equal(pasteConsumed({ ...paste, counter: 8 }), true);
    assert.equal(pasteConsumed({ ...paste, counter: 9 }), true);
  });

  it("rejects a ready line whose counter cannot be read", () => {
    assert.equal(pasteConsumed({ counter: null, preCommandCounter: 5, lineCount: 1 }), false);
  });

  it("defers to the history boundary when the prompt has no counter", () => {
    assert.equal(pasteConsumed({ counter: null, preCommandCounter: null, lineCount: 3 }), true);
  });
});

describe("rails_irb completion over a slow link", () => {
  it("waits past a blank row's ready-shaped prompt for the end of the paste", async () => {
    const pane = new SlowIrbPane({ results: ["false", "3"] });
    const driver = createRailsIrbDriver();
    await driver.start({ tmux: pane, timeouts: TIMEOUTS, outputCap: OUTPUT_CAP });

    const command = 'numbers = [1, 2]\n\nputs "count: #{numbers.size}"\nnumbers.sum';
    const output = await driver.runCommand({ tmux: pane, command, timeouts: TIMEOUTS, outputCap: OUTPUT_CAP });

    assert.equal(output, "=> 3");
    assert.equal(pane.rows.at(-1), stockPrompt(2 + pastedLineCount(command)));
  });
});
