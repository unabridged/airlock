// Airlock — the approval gate.
//
// Every mutating tool call renders its command as the approval page and
// spawns the compiled Swift overlay helper. The bridge proceeds ONLY on a
// literal parsed {"decision":"approve"}. Deny, timeout, a helper crash,
// unparseable helper output, and a non-zero exit are all NON-approvals that
// become clean tool results (never protocol errors), relaying any typed
// "message" verbatim so the model can adjust and resend.
//
// Overlays serialize: one pending panel at a time; later gated calls queue.

import { spawn } from "node:child_process";
import { accessSync, constants, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApprovalHtml } from "./colorize.mjs";

const HELPER_SOURCE_PATH = fileURLToPath(
  new URL("../airlock-approve.swift", import.meta.url),
);
const HELPER_BUILD_COMMAND = "swiftc -O -o bin/airlock-approve airlock-approve.swift";

// Setup diagnostic (a warning, never fatal): a missing or non-executable
// helper otherwise surfaces only as "Not approved (helper-unavailable)" on
// the first gated call, mid-workflow, and nothing rebuilds a helper older
// than its source, so a pull that changes the overlay leaves the old panel
// rendering the new approval page. A packaged install ships no source, so
// only a checkout can report a stale helper.
export function approvalHelperProblem({ helperPath, sourcePath = HELPER_SOURCE_PATH }) {
  try {
    accessSync(helperPath, constants.X_OK);
  } catch {
    return (
      `approval helper missing or not executable at ${helperPath} — every gated call will ` +
      `return "Not approved (helper-unavailable)". Build it with: ${HELPER_BUILD_COMMAND}`
    );
  }
  if (helperIsOlderThanSource(helperPath, sourcePath)) {
    return (
      `approval helper at ${helperPath} is older than ${sourcePath}, so its overlay may not ` +
      `match this version of Airlock. Rebuild it with: ${HELPER_BUILD_COMMAND}`
    );
  }
  return null;
}

function helperIsOlderThanSource(helperPath, sourcePath) {
  try {
    return statSync(helperPath).mtimeMs < statSync(sourcePath).mtimeMs;
  } catch {
    return false;
  }
}

let overlayQueue = Promise.resolve();

// The one helper currently on screen (overlays serialize, so one suffices).
// A bridge that exits mid-approval must take its panel down with it — an
// orphaned overlay would offer an Approve button wired to nothing. SIGKILL
// paths are covered on the helper's own side (it watches for reparenting).
let inFlightHelper = null;
process.on("exit", () => {
  if (inFlightHelper) inFlightHelper.kill("SIGKILL");
});

// Resolves to { approved, decision, message } — it never rejects; every
// failure mode is a non-approval with a decision label. `helperPath` is the
// overlay executable the launch options chose; `instanceLabel` (such as
// "DEV") marks the panel of a non-production instance.
export function requestApproval(request) {
  const queuedRequest = overlayQueue.then(() => presentOverlay(request));
  // The queue must survive any outcome; presentOverlay never rejects anyway.
  overlayQueue = queuedRequest.then(
    () => undefined,
    () => undefined,
  );
  return queuedRequest;
}

async function presentOverlay({
  command,
  badge,
  actionDescription,
  claudeSessionName,
  timeoutSeconds,
  watchCommandPath,
  helperPath,
  instanceLabel = null,
}) {
  const html = await buildApprovalHtml({
    command,
    badge,
    instanceLabel,
    // The header carries the requesting Claude Code session's name when the
    // server learned it, falling back to the action question.
    headerText: claudeSessionName || actionDescription,
    timeoutSeconds,
  });
  const title = `${overlayTitlePrefix(instanceLabel)} — ${claudeSessionName || "approval required"}`;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result) => {
      if (!settled) {
        settled = true;
        resolve(result);
      }
    };

    let helper;
    try {
      helper = spawn(helperPath, [], { stdio: ["pipe", "pipe", "ignore"] });
    } catch (err) {
      settle(notApproved("helper-unavailable", `approval helper could not be spawned: ${err.message}`));
      return;
    }
    inFlightHelper = helper;

    // Backstop for a helper that hangs past its own timeout (which resolves
    // the overlay by itself in the normal case).
    const hangGuard = setTimeout(
      () => {
        helper.kill("SIGKILL");
        settle(notApproved("timeout", "approval helper did not answer in time"));
      },
      (timeoutSeconds + 30) * 1000,
    );

    helper.on("error", (err) => {
      clearTimeout(hangGuard);
      inFlightHelper = null;
      settle(notApproved("helper-unavailable", `approval helper could not be spawned: ${err.message}`));
    });

    let helperOutput = "";
    helper.stdout.on("data", (chunk) => (helperOutput += chunk));
    helper.on("close", (exitCode) => {
      clearTimeout(hangGuard);
      inFlightHelper = null;
      if (exitCode !== 0) {
        settle(notApproved("helper-crash", `approval helper exited ${exitCode}`));
        return;
      }
      let payload;
      try {
        payload = JSON.parse(helperOutput);
      } catch {
        settle(notApproved("helper-crash", "approval helper produced unparseable output"));
        return;
      }
      // Valid JSON that is not an object (`null`, a number, an array) is just
      // as unparseable as garbage — reading .message off it must never throw.
      if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
        settle(notApproved("helper-crash", "approval helper produced unparseable output"));
        return;
      }
      const message = typeof payload.message === "string" ? payload.message : undefined;
      if (payload.decision === "approve") {
        settle({ approved: true, decision: "approve", message });
      } else {
        settle({
          approved: false,
          decision: typeof payload.decision === "string" ? payload.decision : "deny",
          message,
        });
      }
    });

    helper.stdin.on("error", () => {
      // A helper that dies before reading stdin surfaces via 'close'.
    });
    helper.stdin.write(JSON.stringify({ html, timeoutSeconds, title, watchCommandPath }));
    helper.stdin.end();
  });
}

function overlayTitlePrefix(instanceLabel) {
  return instanceLabel ? `Airlock ${instanceLabel}` : "Airlock";
}

function notApproved(decision, detail) {
  return { approved: false, decision, message: undefined, detail };
}
