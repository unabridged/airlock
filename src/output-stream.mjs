// Airlock — pane observation: completion polling, boundary marking, output
// extraction, echo stripping, and the output size cap.
//
// Polling is internal to the bridge — the MCP call blocks here until the
// remote program is ready again; Claude never sleeps. The ~100ms interval is
// detection granularity, not a guess about duration.

const POLL_INTERVAL_MS = 100;
const QUIESCENCE_POLL_INTERVAL_MS = 150;

// Startup auth states are wait-for-human: the human completes them in the
// attached terminal while the MCP call stays pending. Best-effort (English)
// coverage of password/passphrase/passcode/PIN/OTP/Duo/host-key prompts; the
// cursor-at-end and history-boundary gates in the waiters back it up for
// prompts this pattern misses.
export const AUTH_PROMPT_PATTERN =
  /(password[^:]*:|passphrase[^:]*:|passcode[^:]*:?|\bpin\b[^:]*:|verification code[^:]*:?|one-time (?:password|code)[^:]*:?|\botp\b[^:]*:|\bduo\b[^:]*:|two-factor|\b2fa\b|\(yes\/no(?:\/\[fingerprint\])?\)\??:?)\s*$/i;

export class PaneStateError extends Error {}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function trimTrailingBlankLines(lines) {
  let end = lines.length;
  while (end > 0 && lines[end - 1].trim() === "") end -= 1;
  return lines.slice(0, end);
}

// One observation of the pane: visible logical lines + cursor + screen mode.
export async function paneSnapshot(tmux) {
  const visibleText = await tmux.capturePane();
  const lines = trimTrailingBlankLines(visibleText.split("\n"));
  const { cursorX, alternateScreen } = await tmux.cursorAndScreenState();
  return {
    lines,
    lastLine: lines.length > 0 ? lines[lines.length - 1] : "",
    cursorX,
    alternateScreen,
  };
}

// Blocks until `isReady(snapshot)` — the driver's "last rendered line is a
// bare top-level prompt with the cursor at end-of-prompt" test — holds.
// A pane in the alternate screen (pager/editor) fails fast with a specific
// recoverable error; a dead pane fails with a liveness error; the safety
// timeout preserves the session and reports the detected pane state.
//
// `boundaryLineCount` (when given) closes the false-completion race: right
// after paste+Enter the pane still shows the PRE-command prompt for one SSH
// round-trip, and it would satisfy `isReady`. Requiring the rendered history
// to have grown past the boundary marked before injection proves the prompt
// is a NEW one (the next prompt always lands on a new line).
export async function waitForReadyPrompt({ tmux, isReady, timeoutMs, describeWaitingState, boundaryLineCount }) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (!(await tmux.hasSession())) {
      throw new PaneStateError("The remote connection has ended (the terminal pane is gone).");
    }
    // The boundary probe runs BEFORE the snapshot: growth observed first can
    // only certify a snapshot taken later (once the echo row has rendered,
    // the bare pre-command prompt is no longer the last line). The reverse
    // order lets growth landing between the two calls certify a STALE
    // ready-looking snapshot — a false completion.
    const beyondBoundary =
      boundaryLineCount === undefined || (await historyLineCount(tmux)) > boundaryLineCount;
    const snapshot = await paneSnapshot(tmux);
    if (snapshot.alternateScreen) {
      throw new PaneStateError(
        "The remote terminal opened a full-screen program (pager or editor). " +
          "Use interrupt_terminal or resolve it in the attached terminal, then retry.",
      );
    }
    if (beyondBoundary && isReady(snapshot)) return snapshot;
    if (Date.now() >= deadline) {
      const state = describeWaitingState
        ? describeWaitingState(snapshot)
        : `last line: ${JSON.stringify(snapshot.lastLine)}`;
      throw new PaneStateError(
        `Timed out after ${Math.round(timeoutMs / 1000)}s waiting for the remote prompt ` +
          `(session preserved; ${state}). The command may still be running — ` +
          `retry later, or use interrupt_terminal.`,
      );
    }
    await sleep(POLL_INTERVAL_MS);
  }
}

// Blocks until pane output has been stable for `quietMs` AND the last line
// looks prompt-like: non-empty, not an auth prompt, with the CURSOR AT ITS
// END (a mid-banner stall leaves the cursor on a later blank line, so a
// banner line can never be adopted as a prompt). Auth prompts are quiescent
// but remain wait-for-human states: the loop keeps waiting while the human
// answers. `boundaryLineCount` (when given) additionally requires a NEW
// rendered-history line past the marked boundary, so a startup line is never
// considered settled while the pane still shows its pre-injection state.
// `isSettledLine` (when given) must also accept the snapshot before the wait
// settles — for callers that know the shape of the line they are waiting for
// (e.g. a program that pauses mid-banner longer than `quietMs`); the timeout
// then names `settleDescription` instead of the generic settling message.
export async function waitForQuiescence({
  tmux,
  timeoutMs,
  quietMs = 1500,
  boundaryLineCount,
  isSettledLine,
  settleDescription,
}) {
  const deadline = Date.now() + timeoutMs;
  let previousText = null;
  let stableSince = null;
  for (;;) {
    if (!(await tmux.hasSession())) {
      throw new PaneStateError(
        "The remote connection ended during startup (the terminal pane is gone).",
      );
    }
    // Probe-then-snapshot, as in waitForReadyPrompt: boundary growth may
    // only certify a snapshot taken after it was observed.
    const beyondBoundary =
      boundaryLineCount === undefined || (await historyLineCount(tmux)) > boundaryLineCount;
    const snapshot = await paneSnapshot(tmux);
    const paneText = snapshot.lines.join("\n");
    if (paneText !== previousText) {
      previousText = paneText;
      stableSince = Date.now();
    }
    const settled =
      stableSince !== null &&
      Date.now() - stableSince >= quietMs &&
      snapshot.lastLine.trim() !== "" &&
      !AUTH_PROMPT_PATTERN.test(snapshot.lastLine) &&
      snapshot.cursorX === snapshot.lastLine.length &&
      (isSettledLine === undefined || isSettledLine(snapshot)) &&
      beyondBoundary;
    if (settled) return snapshot;
    if (Date.now() >= deadline) {
      const waitingOnAuth = AUTH_PROMPT_PATTERN.test(snapshot.lastLine);
      throw new PaneStateError(
        waitingOnAuth
          ? "Timed out waiting for authentication to complete in the attached terminal (session preserved)."
          : `Timed out waiting for ${settleDescription ?? "the remote terminal to settle"} ` +
            `(session preserved; last line: ${JSON.stringify(snapshot.lastLine)}).`,
      );
    }
    await sleep(QUIESCENCE_POLL_INTERVAL_MS);
  }
}

// The rendered-history length: visible screen plus scrollback, trailing blank
// lines trimmed. Used both as the output boundary marker and as the
// "history grew past the boundary" evidence in the waiters above.
export async function historyLineCount(tmux) {
  const fullText = await tmux.capturePane({ fullHistory: true });
  return trimTrailingBlankLines(fullText.split("\n")).length;
}

// The output boundary: how many rendered-history lines exist right before a
// command is injected. Extraction later slices everything after it.
export function markOutputBoundary(tmux) {
  return historyLineCount(tmux);
}

// Extracts one invocation's output from the rendered history: everything past
// the boundary, minus echoed command lines (`isEchoLine` — prompt-prefixed
// redraw rows) and the fresh ready prompt, capped head+tail. If the pane's
// scrollback overflowed since the boundary was marked (eviction shifts every
// line index), the slice is no longer trustworthy — degrade explicitly with a
// marker instead of silently returning the wrong lines.
export async function extractCommandOutput({ tmux, boundaryLineCount, isEchoLine, maxLines, maxBytes }) {
  const fullText = await tmux.capturePane({ fullHistory: true });
  const allLines = trimTrailingBlankLines(fullText.split("\n"));
  // The boundary's final line is the prompt the command was typed at — its
  // row now holds echoed command text, so the slice starts on it.
  const startIndex = Math.max(boundaryLineCount - 1, 0);
  const outputLines = allLines.slice(startIndex).filter((line) => !isEchoLine(line));
  const capped = capOutput(trimTrailingBlankLines(outputLines).join("\n"), { maxLines, maxBytes });
  const overflowed = await historyOverflowed(tmux);
  return overflowed
    ? `[Airlock: the terminal scrollback overflowed during this command — early output may be missing or misattributed]\n${capped}`
    : capped;
}

async function historyOverflowed(tmux) {
  try {
    // Comma-separated: display-message sanitizes control characters (a tab
    // separator comes back as "_", silently breaking the split).
    const raw = await tmux.displayMessage("#{history_size},#{history_limit}");
    const [historySize, historyLimit] = raw.split(",").map(Number);
    return Number.isFinite(historySize) && Number.isFinite(historyLimit) && historySize >= historyLimit;
  } catch {
    return false;
  }
}

// Head+tail cap with an elision marker naming what was omitted, so a stray
// `User.all` cannot flood the model's context.
export function capOutput(text, { maxLines = 400, maxBytes = 65536 } = {}) {
  const lines = text.split("\n");
  const byteLength = Buffer.byteLength(text, "utf8");
  if (lines.length <= maxLines && byteLength <= maxBytes) return text;

  const headCount = Math.floor(maxLines * (2 / 3));
  const tailCount = maxLines - headCount;
  let head = lines.slice(0, headCount);
  let tail = lines.slice(Math.max(lines.length - tailCount, headCount));

  // Shrink further if bytes (not lines) are what overflowed.
  let budget = maxBytes;
  const fitWithinBudget = (candidateLines, share) => {
    const kept = [];
    let used = 0;
    for (const line of candidateLines) {
      const cost = Buffer.byteLength(line, "utf8") + 1;
      if (used + cost > budget * share) break;
      kept.push(line);
      used += cost;
    }
    return kept;
  };
  head = fitWithinBudget(head, 2 / 3);
  tail = fitWithinBudget(tail.slice().reverse(), 1 / 3).reverse();

  const omittedLines = lines.length - head.length - tail.length;
  const shownBytes = Buffer.byteLength([...head, ...tail].join("\n"), "utf8");
  const marker = `… [Airlock output cap: ${omittedLines} lines / ~${byteLength - shownBytes} bytes omitted] …`;
  return [...head, marker, ...tail].join("\n");
}
