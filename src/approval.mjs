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
import { accessSync, constants } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildApprovalHtml } from "./colorize.mjs";

const DEFAULT_HELPER_PATH = fileURLToPath(
  new URL("../bin/airlock-approve", import.meta.url),
);

// Injectable so tests substitute a fake helper and never display real panels.
export function approvalHelperPath() {
  return process.env.AIRLOCK_APPROVE_HELPER || DEFAULT_HELPER_PATH;
}

// Startup diagnostic (loud stderr warning, not fatal): a missing or
// non-executable helper otherwise surfaces only as "Not approved
// (helper-unavailable)" on the first gated call, mid-workflow.
export function approvalHelperStartupProblem() {
  const helperPath = approvalHelperPath();
  try {
    accessSync(helperPath, constants.X_OK);
    return null;
  } catch {
    return (
      `approval helper missing or not executable at ${helperPath} — every gated call will ` +
      `return "Not approved (helper-unavailable)". Build it with: ` +
      `swiftc -O -o bin/airlock-approve airlock-approve.swift`
    );
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
// failure mode is a non-approval with a decision label.
export function requestApproval({
  command,
  badge,
  actionDescription,
  claudeSessionName,
  timeoutSeconds,
  watchCommandPath,
}) {
  const queuedRequest = overlayQueue.then(() =>
    presentOverlay({ command, badge, actionDescription, claudeSessionName, timeoutSeconds, watchCommandPath }),
  );
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
}) {
  const html = await buildApprovalHtml({
    command,
    badge,
    // The header carries the requesting Claude Code session's name when the
    // server learned it, falling back to the action question.
    headerText: claudeSessionName || actionDescription,
    timeoutSeconds,
  });
  const title = claudeSessionName ? `Airlock — ${claudeSessionName}` : "Airlock — approval required";

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
      helper = spawn(approvalHelperPath(), [], { stdio: ["pipe", "pipe", "ignore"] });
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

function notApproved(decision, detail) {
  return { approved: false, decision, message: undefined, detail };
}
