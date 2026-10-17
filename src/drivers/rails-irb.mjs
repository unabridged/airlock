// Airlock — `rails_irb` driver: a Rails console (IRB/Reline) reached via
// `ssh <alias>` plus configured startup lines (`cd app`, `bin/rails console`).
//
// Prompt strategy (PLAN: Driver model): real consoles customize the IRB
// prompt — an .irbrc commonly renders app, environment, and branch (e.g.
// `acme(staging):main>`) instead of stock `irb(main):001>` — so the
// prompt's exact text cannot be assumed. The driver LEARNS it: startup waits
// for the console output to settle on a line ending in the IRB input sigil
// (`>`), adopts that line, and anchors it with every digit run freed (stock
// IRB increments an input counter on every submission). The pager-disable
// command then round-trips through the learned prompt and must echo its
// `false` result, verifying the adoption end-to-end before the session is
// reported ready.
//
// Verified stock shapes (IRB 1.18) the learned patterns must keep covering:
//   top-level:     irb(main):001>            (counter increments once per
//                                             pasted line, so a bracketed
//                                             paste advances it by its line
//                                             count)
//   continuation:  irb(main):002*            (and "/' string continuations)
//   echo trap:     irb(main):004>   .sum     (echoed final line of a COMPLETE
//                                             multiline expression also shows >)
// Completion therefore matches only an END-ANCHORED EMPTY prompt as the last
// rendered line, with the cursor at end-of-prompt — never a continuation
// prompt, and never a prompt-looking line elsewhere in the stream (remote
// output is untrusted and must not spoof early completion).

import {
  extractCommandOutput,
  markOutputBoundary,
  PaneStateError,
  paneSnapshot,
  waitForQuiescence,
  waitForReadyPrompt,
} from "../output-stream.mjs";

// Adoption candidate (startup only): a settled line ending in the IRB input
// sigil. Post-adoption matching always uses the stricter learned patterns.
const IRB_PROMPT_CANDIDATE_PATTERN = /^\S.*> ?$/;

// Disclosed pager neutralization (PLAN: driver startup must neutralize the
// pager, or a tall result opens `less` and wedges the session). Sent as a
// visible console line right after the prompt is adopted; its echoed `false`
// result doubles as proof the adopted line really is an IRB prompt. The
// trailing re-read makes the echoed value come from a PLAIN expression:
// an .irbrc setting `IRB.conf[:ECHO_ON_ASSIGNMENT] = false` (a common way
// to silence large ActiveRecord assignment dumps) suppresses the
// assignment's own echo, and must not fail the verification.
const DISABLE_PAGER_COMMAND = "IRB.conf[:USE_PAGER] = false; IRB.conf[:USE_PAGER]";

const NOT_AT_PROMPT_MESSAGE =
  "The remote terminal is not at a recognized command prompt. Resolve the " +
  "interactive state in the terminal before sending another command.";

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Derives the anchored matching patterns from the startup-adopted prompt
// line: `ready` is the end-anchored empty prompt, `echo` covers Reline's
// prompt-prefixed redraw rows (input and continuation shapes), and `counter`
// captures the SIGIL-ADJACENT digit run — where stock PROMPT_I's `%03n`
// renders — when the prompt has one (null otherwise — completion proof then
// rests on the history boundary alone). An interior digit run is never the
// counter: it is static prompt text (an app/host digit, a branch like
// `feature/proj-123/...`, a timestamp), and requiring it to change would deadlock
// every command.
// Exported for direct unit coverage of real-world prompt shapes.
export function buildIrbPromptPatterns(detectedPrompt) {
  const core = escapeRegExp(detectedPrompt.replace(/> ?$/, "")).replace(/\d+/g, "\\d+");
  return {
    ready: new RegExp(`^${core}> ?$`),
    // Continuation states render the core with PROMPT_S's `%l` — the open
    // literal's terminator: `*` (statement), a quote, `/` (regexp), `]`
    // (%w/%i array), backtick (xstring), or `:` (symbol) — in place of `>`.
    echo: new RegExp(`^${core}[>*"'/\`\\]:]`),
    continuation: new RegExp(`^${core}[*"'/\`\\]:]`),
    counter: /\\d\+ ?$/.test(core)
      ? new RegExp(`^${core.replace(/\\d\+( ?)$/, "(\\d+)$1")}`)
      : null,
  };
}

// The lines a paste hands IRB: {pasteCommand} strips trailing newlines, so
// they count for nothing.
export function pastedLineCount(command) {
  return command.replace(/\n+$/, "").split("\n").length;
}

// Whether a ready prompt's counter proves the whole paste was consumed. IRB
// increments the counter once per pasted line, and a blank row inside a
// bracketed paste renders as a ready-shaped prompt on the way, so "the
// counter changed" can hold mid-paste over SSH; only a counter that has
// advanced by the paste's full line count proves the input is complete.
// Without a counter (a custom prompt) the history boundary is the only proof.
export function pasteConsumed({ counter, preCommandCounter, lineCount }) {
  if (preCommandCounter === null) return true;
  return counter !== null && counter >= preCommandCounter + lineCount;
}

export function createRailsIrbDriver({ startupCommands = [] } = {}) {
  let promptLine = null;
  let promptPatterns = null;

  function isReady(snapshot) {
    return (
      promptPatterns !== null &&
      promptPatterns.ready.test(snapshot.lastLine) &&
      snapshot.cursorX === snapshot.lastLine.length
    );
  }

  function describeWaitingState(snapshot) {
    if (promptPatterns !== null && promptPatterns.continuation.test(snapshot.lastLine)) {
      return "stuck at an IRB continuation prompt — the expression is incomplete";
    }
    return `last line: ${JSON.stringify(snapshot.lastLine)}`;
  }

  async function pasteCommand(tmux, command) {
    // Strip trailing newlines before loading the buffer: a trailing newline
    // inside the paste pre-renders an empty next prompt = false completion.
    await tmux.pasteText(command.replace(/\n+$/, ""));
    await tmux.sendEnter();
  }

  function promptCounter(line) {
    if (promptPatterns === null || promptPatterns.counter === null) return null;
    const match = line.match(promptPatterns.counter);
    return match ? Number(match[1]) : null;
  }

  async function runAtPrompt({ tmux, command, timeouts, outputCap }) {
    // Two independent proofs that a matched ready prompt is the NEXT one and
    // not the still-rendered pre-command prompt (which persists for one SSH
    // round-trip after paste+Enter): the rendered history must have grown
    // past the boundary, and the prompt counter must have advanced by the
    // whole paste (when the prompt has one; see {pasteConsumed}).
    const preCommandSnapshot = await paneSnapshot(tmux);
    const preCommandCounter = promptCounter(preCommandSnapshot.lastLine);
    const lineCount = pastedLineCount(command);
    const boundaryLineCount = await markOutputBoundary(tmux);
    await pasteCommand(tmux, command);
    await waitForReadyPrompt({
      tmux,
      isReady: (snapshot) =>
        isReady(snapshot) &&
        pasteConsumed({ counter: promptCounter(snapshot.lastLine), preCommandCounter, lineCount }),
      timeoutMs: timeouts.commandMs,
      describeWaitingState,
      boundaryLineCount,
    });
    return extractCommandOutput({
      tmux,
      boundaryLineCount,
      // Reline redraws every pasted line prompt-prefixed (input or
      // continuation shape); those echoed rows are not output.
      isEchoLine: (line) => promptPatterns.echo.test(line),
      ...outputCap,
    });
  }

  return {
    name: "rails_irb",

    // SSH auth (wait-for-human) → the remote shell settles on a prompt-like
    // state (non-empty, non-auth last line with the cursor at its end) →
    // each startup line is pasted only once the PREVIOUS line produced a new
    // settled prompt-like state past its own history boundary (never into a
    // password field, never into a still-rendered pre-injection pane) → the
    // console command must settle on an IRB-sigil line, which is adopted as
    // the prompt and verified by the pager-disable round-trip.
    async start({ tmux, timeouts, outputCap }) {
      await waitForQuiescence({ tmux, timeoutMs: timeouts.openMs });
      const preludeCommands = startupCommands.slice(0, -1);
      const consoleCommand = startupCommands[startupCommands.length - 1];
      for (const startupCommand of preludeCommands) {
        const lineBoundary = await markOutputBoundary(tmux);
        await pasteCommand(tmux, startupCommand);
        await waitForQuiescence({
          tmux,
          timeoutMs: timeouts.openMs,
          quietMs: 700,
          boundaryLineCount: lineBoundary,
        });
      }
      let consoleBoundary;
      if (consoleCommand !== undefined) {
        consoleBoundary = await markOutputBoundary(tmux);
        await pasteCommand(tmux, consoleCommand);
      }
      // A loading console sits quiet for seconds mid-banner ("Loading
      // staging environment…" with the cursor at line end), so plain
      // quiescence would adopt a banner line. The settled-line predicate
      // keeps waiting until the stable last line ends in the IRB sigil.
      const settledSnapshot = await waitForQuiescence({
        tmux,
        timeoutMs: timeouts.openMs,
        boundaryLineCount: consoleBoundary,
        isSettledLine: (snapshot) => IRB_PROMPT_CANDIDATE_PATTERN.test(snapshot.lastLine),
        settleDescription: "an IRB prompt (a settled line ending in '>')",
      });
      promptLine = settledSnapshot.lastLine;
      promptPatterns = buildIrbPromptPatterns(promptLine);
      const pagerReport = await runAtPrompt({
        tmux,
        command: DISABLE_PAGER_COMMAND,
        timeouts,
        outputCap,
      });
      // The round-trip already proved completion past the boundary; the
      // echoed `false` value proves the responder is IRB (a shell whose
      // prompt happens to end in `>` errors without echoing a result).
      if (!/\bfalse\b/.test(pagerReport)) {
        throw new PaneStateError(
          `The console did not echo the pager-disable result (got: ` +
            `${JSON.stringify(pagerReport)}) — either the adopted prompt ` +
            `${JSON.stringify(promptLine)} is not an IRB prompt, or the ` +
            `console suppresses result echo (IRB.conf[:ECHO] = false or a ` +
            `custom RETURN format), which Airlock needs for output capture.`,
        );
      }
      return (
        `Rails console ready (detected prompt: ${JSON.stringify(promptLine)}; ` +
        `pager disabled via ${DISABLE_PAGER_COMMAND}).`
      );
    },

    isReady,

    async assertAtPrompt({ tmux }) {
      const snapshot = await paneSnapshot(tmux);
      if (!isReady(snapshot)) throw new PaneStateError(NOT_AT_PROMPT_MESSAGE);
    },

    // One atomic bracketed paste: Reline receives the whole multiline command
    // as a single input instead of evaluating line-by-line. A multi-statement
    // paste prints only the final value — that caveat lives in the
    // Claude-facing guidance, not here.
    async runCommand({ tmux, command, timeouts, outputCap }) {
      await this.assertAtPrompt({ tmux });
      if (command.trim() === "") throw new PaneStateError("The command is empty.");
      return runAtPrompt({ tmux, command, timeouts, outputCap });
    },

    // Graceful close: leave IRB, then the remote shell (ending the transport and pane).
    exitCommands: ["exit", "exit"],
  };
}
