// Airlock — waitForQuiescence settled-line predicate (node --test): the
// reason `isSettledLine` exists is a loading console that sits QUIET
// mid-banner longer than quietMs ("Loading staging environment…" with the
// cursor at line end). Plain quiescence adopts that banner line; the
// predicate must hold the wait until the stable last line has the awaited
// shape, and a timeout must name what was being waited for.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { PaneStateError, waitForQuiescence } from "../src/output-stream.mjs";

// The pane states waitForQuiescence observes: a mutable last line with the
// cursor pinned to its end (exactly the mid-banner stall being modeled).
class ScriptedPane {
  constructor(lastLine) {
    this.lines = [lastLine];
  }
  setLine(line) {
    this.lines = [line];
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
}

const BANNER_LINE = "Loading staging environment (Rails 7.1.3)";
const PROMPT_LINE = "acme(staging):main> ";
const endsInSigil = (snapshot) => /^\S.*> ?$/.test(snapshot.lastLine);

describe("waitForQuiescence settled-line predicate", () => {
  it("without the predicate, a quiet mid-banner stall is adopted (why it exists)", async () => {
    const pane = new ScriptedPane(BANNER_LINE);
    const snapshot = await waitForQuiescence({ tmux: pane, timeoutMs: 5000, quietMs: 200 });
    assert.equal(snapshot.lastLine, BANNER_LINE);
  });

  it("holds through a quiet banner stall and settles only on the awaited shape", async () => {
    const pane = new ScriptedPane(BANNER_LINE);
    // The banner outlasts quietMs several times over before the prompt lands.
    const promptTimer = setTimeout(() => pane.setLine(PROMPT_LINE), 700);
    try {
      const snapshot = await waitForQuiescence({
        tmux: pane,
        timeoutMs: 10000,
        quietMs: 200,
        isSettledLine: endsInSigil,
        settleDescription: "an IRB prompt (a settled line ending in '>')",
      });
      assert.equal(snapshot.lastLine, PROMPT_LINE);
    } finally {
      clearTimeout(promptTimer);
    }
  });

  it("names the awaited shape and the stuck line when it times out", async () => {
    const pane = new ScriptedPane(BANNER_LINE);
    await assert.rejects(
      waitForQuiescence({
        tmux: pane,
        timeoutMs: 800,
        quietMs: 100,
        isSettledLine: endsInSigil,
        settleDescription: "an IRB prompt (a settled line ending in '>')",
      }),
      (error) => {
        assert.ok(error instanceof PaneStateError);
        assert.match(error.message, /Timed out waiting for an IRB prompt \(a settled line ending in '>'\)/);
        assert.match(error.message, /Loading staging environment/);
        return true;
      },
    );
  });
});
