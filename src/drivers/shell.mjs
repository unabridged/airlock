// Airlock — `shell` driver: a plain remote shell (reached via `ssh <alias>`
// or a configured connection script; the driver is transport-agnostic).
//
// Ready-pattern strategy (PLAN: Driver model): the actual remote prompt is
// detected and validated during session startup (the quiescence waiter only
// settles on a non-auth line with the cursor at its end), then anchored. When
// the prompt has a `user@host:cwd$`, `host:cwd$`, or `PREFIX cwd$` shape, the
// prefix and the trailing sigil are anchored while the cwd segment may vary
// (a `cd` must not wedge the session); otherwise the whole detected line is
// matched literally.
// Because the transport is the pane's direct command, no LOCAL shell prompt
// can ever appear in this pane — a connection drop kills the pane instead,
// which liveness checks detect.
//
// Multiline commands are sent line-by-line (PLAN's option (b)): a bracketed
// multiline paste into a remote readline is version-dependent, and an
// unbracketed one executes lines early. Between lines the driver accepts
// EITHER the ready prompt (the line executed) OR a stable continuation
// prompt (`> `, `quote> `, … — the line opened a heredoc/block/quote), so
// multi-line constructs are carried instead of wedging. A continuation state
// after the FINAL line means the whole command was incomplete: fail fast
// with a recoverable error instead of burning the command timeout.

import {
  extractCommandOutput,
  historyLineCount,
  markOutputBoundary,
  PaneStateError,
  paneSnapshot,
  waitForQuiescence,
  waitForReadyPrompt,
} from "../output-stream.mjs";

const NOT_AT_PROMPT_MESSAGE =
  "The remote terminal is not at a recognized command prompt. Resolve the " +
  "interactive state in the terminal before sending another command.";

// Common PS2 shapes: bash "> ", zsh "quote> " / "heredoc> " / "if> ", etc.
const CONTINUATION_PROMPT_PATTERN = /^[\w-]{0,12}[>»] $/;
// How long a candidate continuation prompt must hold still before it is
// believed (the echo and PS2 render within one round-trip; a busy command's
// partial output line keeps changing).
const CONTINUATION_STABLE_MS = 1000;
const CONTINUATION_POLL_MS = 100;

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Derives the anchored matching patterns from the startup-detected prompt
// line. Exported for direct unit coverage of real-world prompt shapes.
// Known limitation (documented, deployed fleet unaffected): only the LAST
// line of a multi-line PS1 is learned, so the earlier prompt lines appear in
// extracted output; a prompt that BEGINS with the cwd falls to the literal
// branch and a `cd` then requires close+reopen.
export function buildShellPromptPatterns(detectedPrompt) {
  const userHostShaped = detectedPrompt.match(/^(\S+@\S+?)([:\s]).*?([$#%]\s?)$/);
  const hostShaped = userHostShaped ? null : detectedPrompt.match(/^([^@\s:]+)(:).*?([$#%]\s?)$/);
  // "HOST (role) ~$" and other space-separated shapes (the acme staging
  // hosts render `ACME-STAGING (web) ~$`): anchor everything through the
  // last interior whitespace, free the final cwd segment.
  const spaceShaped =
    userHostShaped || hostShaped ? null : detectedPrompt.match(/^(.+)(\s)\S.*?([$#%]\s?)$/);
  const shaped = userHostShaped || hostShaped || spaceShaped;
  if (shaped) {
    const prefix = `${escapeRegExp(shaped[1])}${escapeRegExp(shaped[2])}`;
    const sigil = `${escapeRegExp(shaped[3].trimEnd())} ?`;
    // The space-separated shape's prefix (`ACME-STAGING (web) `) plausibly
    // begins GENUINE output lines (`echo "$PS1"`, grep hits), so its echo
    // match keeps the cwd segment space-free and sigil-adjacent — a prompt
    // row shape — instead of swallowing any line that merely contains the
    // sigil somewhere later.
    const echoCwd = spaceShaped ? "\\S*" : ".*";
    return {
      ready: new RegExp(`^${prefix}.*${sigil}$`),
      echo: new RegExp(`^${prefix}${echoCwd}${sigil}`),
    };
  }
  const literal = escapeRegExp(detectedPrompt);
  return { ready: new RegExp(`^${literal}$`), echo: new RegExp(`^${literal}`) };
}

export function createShellDriver() {
  let promptLine = null;
  let promptPattern = null;
  let promptEchoPattern = null;

  function isReady(snapshot) {
    return (
      promptPattern !== null &&
      promptPattern.test(snapshot.lastLine) &&
      snapshot.cursorX === snapshot.lastLine.length
    );
  }

  function isContinuationPrompt(snapshot) {
    return (
      CONTINUATION_PROMPT_PATTERN.test(snapshot.lastLine) &&
      !promptPattern.test(snapshot.lastLine) &&
      snapshot.cursorX === snapshot.lastLine.length
    );
  }

  // After one line is submitted, blocks until the shell shows what it made of
  // it: "ready" (the line completed — a new prompt past this line's history
  // boundary) or "continuation" (a stable PS2 — the construct wants more
  // lines). The boundary requirement proves the state is NEW, not the
  // still-rendered pre-injection pane.
  async function waitForLineOutcome({ tmux, timeoutMs, lineBoundary }) {
    const deadline = Date.now() + timeoutMs;
    let continuationCandidate = null;
    let continuationCandidateSince = 0;
    for (;;) {
      if (!(await tmux.hasSession())) {
        throw new PaneStateError("The remote connection has ended (the terminal pane is gone).");
      }
      // Probe-then-snapshot (see waitForReadyPrompt): growth may only
      // certify a snapshot taken after it was observed, else growth landing
      // between the calls certifies the stale pre-Enter prompt.
      const advanced = (await historyLineCount(tmux)) > lineBoundary;
      const snapshot = await paneSnapshot(tmux);
      if (snapshot.alternateScreen) {
        throw new PaneStateError(
          "The remote terminal opened a full-screen program (pager or editor). " +
            "Use interrupt_terminal or resolve it in the attached terminal, then retry.",
        );
      }
      if (advanced && isReady(snapshot)) return "ready";
      if (advanced && isContinuationPrompt(snapshot)) {
        if (continuationCandidate === snapshot.lastLine) {
          if (Date.now() - continuationCandidateSince >= CONTINUATION_STABLE_MS) return "continuation";
        } else {
          continuationCandidate = snapshot.lastLine;
          continuationCandidateSince = Date.now();
        }
      } else {
        continuationCandidate = null;
      }
      if (Date.now() >= deadline) {
        throw new PaneStateError(
          `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the remote prompt ` +
            `(session preserved; last line: ${JSON.stringify(snapshot.lastLine)}). ` +
            `The command may still be running — retry later, or use interrupt_terminal.`,
        );
      }
      await sleep(CONTINUATION_POLL_MS);
    }
  }

  return {
    name: "shell",

    // Wait out SSH auth (a wait-for-human state) and banner output, then
    // adopt the settled last line as the remote ready prompt. The quiescence
    // waiter validates the candidate: non-empty, not an auth prompt, cursor
    // at end-of-line — a mid-banner stall cannot be adopted.
    async start({ tmux, timeouts }) {
      const snapshot = await waitForQuiescence({ tmux, timeoutMs: timeouts.openMs });
      promptLine = snapshot.lastLine;
      if (promptLine.trim() === "") {
        throw new PaneStateError("Could not detect a remote shell prompt during startup.");
      }
      ({ ready: promptPattern, echo: promptEchoPattern } = buildShellPromptPatterns(promptLine));
      return `Remote shell ready (detected prompt: ${JSON.stringify(promptLine)}).`;
    },

    isReady,

    async assertAtPrompt({ tmux }) {
      const snapshot = await paneSnapshot(tmux);
      if (!isReady(snapshot)) throw new PaneStateError(NOT_AT_PROMPT_MESSAGE);
    },

    async runCommand({ tmux, command, timeouts, outputCap, shouldAbort = () => false }) {
      await this.assertAtPrompt({ tmux });
      // Strip trailing newlines (Enter is sent separately; a pasted trailing
      // newline would submit a stray empty command) but keep interior blank
      // lines — they are payload inside heredocs.
      const commandLines = command.replace(/\n+$/, "").split("\n");
      if (commandLines.every((line) => line.trim() === "")) {
        throw new PaneStateError("The command is empty.");
      }

      const boundaryLineCount = await markOutputBoundary(tmux);
      let interrupted = false;
      for (let index = 0; index < commandLines.length; index += 1) {
        // interrupt_terminal aborts the whole send: after a C-c the
        // recovered prompt must not cause the remaining lines to run.
        if (shouldAbort()) {
          interrupted = true;
          break;
        }
        const commandLine = commandLines[index];
        const lineBoundary = await markOutputBoundary(tmux);
        // A blank heredoc-payload line is just an Enter; load-buffer has no
        // bytes to carry for it.
        if (commandLine !== "") await tmux.pasteText(commandLine);
        await tmux.sendEnter();

        const finalLine = index === commandLines.length - 1;
        if (finalLine) {
          // The last line must end at the ready prompt. A stable
          // continuation prompt here means the whole command is incomplete —
          // fail fast instead of burning the command timeout.
          const outcome = await waitForLineOutcome({ tmux, timeoutMs: timeouts.commandMs, lineBoundary });
          if (outcome === "continuation") {
            throw new PaneStateError(
              "The remote shell is at a continuation prompt — the command is incomplete " +
                "(unclosed quote, heredoc, or block). Use interrupt_terminal to recover, " +
                "then resend the complete command.",
            );
          }
        } else {
          await waitForLineOutcome({ tmux, timeoutMs: timeouts.commandMs, lineBoundary });
        }
      }
      if (interrupted) {
        // Best effort: the pane may still be mid-construct; report what ran.
        await waitForReadyPrompt({ tmux, isReady, timeoutMs: 3000, boundaryLineCount }).catch(() => undefined);
      }
      // Echoed rows come in two shapes: `<prompt><command>` (and bare
      // prompts) for submitted lines, and `<PS2><command line>` for lines
      // typed into a continuation. The PS2 shape is stripped only when the
      // remainder is byte-identical to a line this command actually sent, so
      // genuine output that merely starts with `> ` survives.
      const sentLines = new Set(commandLines);
      const isContinuationEcho = (line) => {
        const match = line.match(/^[\w-]{0,12}[>»] (.*)$/);
        return match !== null && sentLines.has(match[1]);
      };
      const output = await extractCommandOutput({
        tmux,
        boundaryLineCount,
        isEchoLine: (line) => promptEchoPattern.test(line) || isContinuationEcho(line),
        ...outputCap,
      });
      return interrupted
        ? `${output}\n\n[Airlock: interrupted — the remaining command lines were not sent]`
        : output;
    },

    // Graceful close: end the remote shell, which ends the transport, which ends the pane.
    exitCommands: ["exit"],
  };
}
