// Airlock — output extraction, echo stripping, and prompt matching tests
// (node --test). A canned-history fake stands in for the pane; the real
// rails_irb ready predicate is exercised through the adoption path (`start()`
// learns the prompt from the pane — a fresh driver is never ready).

import assert from "node:assert/strict";
import { before, describe, it } from "node:test";

import { createRailsIrbDriver } from "../src/drivers/rails-irb.mjs";
import { extractCommandOutput } from "../src/output-stream.mjs";

// Just what extractCommandOutput needs: full-history capture + history stats.
function cannedPane(historyLines, { overflowed = false } = {}) {
  return {
    capturePane: async () => historyLines.join("\n"),
    displayMessage: async (format) => {
      if (format.includes("history_size")) return overflowed ? "50000,50000" : "10,50000";
      throw new Error(`cannedPane does not script ${format}`);
    },
  };
}

const IRB_ECHO_PATTERN = /^irb\(main\):\d+[>*]/;
const CAP = { maxLines: 400, maxBytes: 65536 };

describe("extractCommandOutput", () => {
  it("returns only the lines past the boundary, echo rows and prompt stripped", async () => {
    const history = [
      "irb(main):001> User.count", //   ← the boundary prompt row, now echoed
      "=> 42",
      "irb(main):002> ", //             ← the fresh ready prompt
    ];
    const output = await extractCommandOutput({
      tmux: cannedPane(history),
      boundaryLineCount: 1,
      isEchoLine: (line) => IRB_ECHO_PATTERN.test(line),
      ...CAP,
    });
    assert.equal(output, "=> 42");
  });

  it("does not return earlier commands' output (boundary slicing)", async () => {
    const history = [
      "irb(main):001> 1 + 1",
      "=> 2",
      "irb(main):002> 2 + 2",
      "=> 4",
      "irb(main):003> ",
    ];
    const output = await extractCommandOutput({
      tmux: cannedPane(history),
      boundaryLineCount: 3, // marked right before `2 + 2` was injected
      isEchoLine: (line) => IRB_ECHO_PATTERN.test(line),
      ...CAP,
    });
    assert.equal(output, "=> 4");
  });

  it("strips every echoed row of a multiline paste, keeping multiline output", async () => {
    const history = [
      "irb(main):001> [1, 2].map do |n|",
      "irb(main):002*   puts n",
      "irb(main):003* end",
      "1",
      "2",
      "=> [nil, nil]",
      "irb(main):004> ",
    ];
    const output = await extractCommandOutput({
      tmux: cannedPane(history),
      boundaryLineCount: 1,
      isEchoLine: (line) => IRB_ECHO_PATTERN.test(line),
      ...CAP,
    });
    assert.equal(output, "1\n2\n=> [nil, nil]");
  });

  it("keeps output lines that merely contain a prompt-looking substring mid-line", async () => {
    const history = [
      'irb(main):001> log_line',
      'log: saw "irb(main):001> " in remote data',
      "irb(main):002> ",
    ];
    const output = await extractCommandOutput({
      tmux: cannedPane(history),
      boundaryLineCount: 1,
      isEchoLine: (line) => IRB_ECHO_PATTERN.test(line),
      ...CAP,
    });
    assert.equal(output, 'log: saw "irb(main):001> " in remote data');
  });

  it("applies the head+tail cap with an elision marker", async () => {
    const bigOutput = Array.from({ length: 1000 }, (_, index) => `row ${index}`);
    const history = ["irb(main):001> flood", ...bigOutput, "irb(main):002> "];
    const output = await extractCommandOutput({
      tmux: cannedPane(history),
      boundaryLineCount: 1,
      isEchoLine: (line) => IRB_ECHO_PATTERN.test(line),
      maxLines: 20,
      maxBytes: 65536,
    });
    assert.match(output, /Airlock output cap: \d+ lines/);
    assert.match(output, /^row 0/);
    assert.match(output, /row 999$/);
    assert.ok(output.split("\n").length <= 21);
  });

  it("prepends the overflow marker when scrollback eviction broke the boundary", async () => {
    const history = ["some output", "irb(main):009> "];
    const output = await extractCommandOutput({
      tmux: cannedPane(history, { overflowed: true }),
      boundaryLineCount: 1,
      isEchoLine: (line) => IRB_ECHO_PATTERN.test(line),
      ...CAP,
    });
    assert.match(output, /^\[Airlock: the terminal scrollback overflowed/);
  });
});

// Scripts exactly the pane protocol driver.start() speaks when the pane is
// already sitting at an IRB prompt: a settled prompt line to adopt, then the
// pager-disable round-trip (echoed command row, `=> false`, fresh prompt).
class FakeIrbPane {
  constructor() {
    this.lines = ["irb(main):001> "];
    this.pendingPaste = "";
  }
  async hasSession() {
    return true;
  }
  async capturePane() {
    return this.lines.join("\n");
  }
  async cursorAndScreenState() {
    const lastLine = this.lines[this.lines.length - 1];
    return { cursorX: lastLine.length, alternateScreen: false };
  }
  async displayMessage(format) {
    if (format.includes("history_size")) return "10,50000";
    throw new Error(`FakeIrbPane does not script ${format}`);
  }
  async pasteText(text) {
    this.pendingPaste += text;
  }
  async sendEnter() {
    const command = this.pendingPaste;
    this.pendingPaste = "";
    this.lines[this.lines.length - 1] += command;
    this.lines.push("=> false");
    this.lines.push("irb(main):002> ");
  }
}

describe("rails_irb prompt matching (patterns learned through start())", () => {
  const driver = createRailsIrbDriver({ startupCommands: [] });
  const snapshot = (lastLine, cursorX = lastLine.length) => ({
    lines: [lastLine],
    lastLine,
    cursorX,
    alternateScreen: false,
  });

  before(async () => {
    const report = await driver.start({
      tmux: new FakeIrbPane(),
      timeouts: { openMs: 15000, commandMs: 5000 },
      outputCap: CAP,
    });
    assert.match(report, /detected prompt: "irb\(main\):001> "/);
  });

  it("is never ready before start() has adopted a prompt", () => {
    const unadoptedDriver = createRailsIrbDriver({ startupCommands: [] });
    assert.equal(unadoptedDriver.isReady(snapshot("irb(main):001> ")), false);
  });

  it("accepts a bare top-level prompt with the cursor at end-of-prompt", () => {
    assert.equal(driver.isReady(snapshot("irb(main):001> ")), true);
    assert.equal(driver.isReady(snapshot("irb(main):042>")), true);
  });

  it("rejects a continuation prompt", () => {
    assert.equal(driver.isReady(snapshot("irb(main):002* ")), false);
  });

  it("rejects the echo trap (a > prompt with trailing text)", () => {
    assert.equal(driver.isReady(snapshot("irb(main):004>   .sum")), false);
  });

  it("rejects a prompt with the cursor not at end-of-prompt (mid-typing)", () => {
    assert.equal(driver.isReady(snapshot("irb(main):001> ", 3)), false);
  });

  it("rejects prompt-looking remote data that is not the last line's own prompt", () => {
    // Spoof defense: only the LAST rendered line can signal completion.
    assert.equal(driver.isReady(snapshot('puts "irb(main):001> "')), false);
  });
});
