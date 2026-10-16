// Airlock — the one-active-session state machine.
//
// Owns the lifecycle invariants: at most one session (open while active
// errors; send/interrupt/close with none errors), serialized sends (an
// overlapping send is rejected, not interleaved), close-during-send blocks
// until the in-flight command settles, and a dead pane (the remote connection
// dropped) fails all operations with a distinct liveness error. This is the
// only module that knows both the terminal layer (tmux/drivers) and nothing
// of the protocol.

import { closeSync, constants, ftruncateSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRailsIrbDriver } from "./drivers/rails-irb.mjs";
import { createShellDriver } from "./drivers/shell.mjs";
import { PaneStateError, paneSnapshot, waitForReadyPrompt } from "./output-stream.mjs";
import { ensurePrivateDirectory, STATE_DIRECTORY, Tmux } from "./tmux.mjs";

const SSH_EXECUTABLE = "/usr/bin/ssh";
const GRACEFUL_CLOSE_TIMEOUT_MS = 4000;

// The attach client the human runs in Claude Desktop's integrated terminal,
// resolved from this module's own location. Its PATH appears in model-facing
// results as a ready-to-run block — a deliberate, narrow exception to "no
// transport details in results": the script encapsulates the socket and
// session name, so the path itself carries neither, and the human gets
// one-click eyes on the session instead of having to remember the command.
export const ATTACH_CLIENT_PATH = fileURLToPath(new URL("../bin/airlock-attach", import.meta.url));

// A bash-fenced block renders with a Run button in the Claude apps — the
// instruction around it tells the model to relay it verbatim.
function attachBlockText(leadIn) {
  return `${leadIn}\n\n\`\`\`bash\n${ATTACH_CLIENT_PATH}\n\`\`\``;
}

// The `ssh` transport's launch command: `ssh <validated alias>` (host from
// validated config, never from Claude input).
export function buildSshLaunchArgv(config, target) {
  return [
    SSH_EXECUTABLE,
    "-F",
    config.sshConfigPath,
    "-o",
    "ServerAliveInterval=15",
    "-o",
    "ServerAliveCountMax=3",
    "--",
    target.ssh_host,
  ];
}

// The ONE seam producing the pane's launch command, dispatching on the
// target's validated transport: `ssh <alias>`, or the configured script with
// its fixed arguments (both from validated config, never from Claude input).
// Integration tests inject a local argv (a bash or irb) in its place so no
// test ever opens a real remote connection.
export function buildLaunchArgv(config, target) {
  if (target.transport === "script") return [target.scriptPath, ...target.args];
  return buildSshLaunchArgv(config, target);
}

export class SessionStateError extends Error {}

// The protocol layer's classifier for tool-level (expected, actionable)
// versus genuinely unexpected errors — exported here so server.mjs never
// imports from the terminal layer directly.
export function isExpectedSessionError(err) {
  return err instanceof SessionStateError || err instanceof PaneStateError;
}

// Darwin open(2) flags Node does not export (sys/fcntl.h): a BSD flock is
// acquired atomically at open time; O_NONBLOCK makes a held lock fail the
// open with EAGAIN instead of blocking.
const O_EXLOCK = 0x20;
const O_SHLOCK = 0x10;

// BSD flock shared and exclusive locks conflict cross-process, so
// {sessionLockHolder}'s microseconds-long SHARED probe (any bridge's
// list_targets) can spuriously deny one exclusive-open attempt. EAGAIN is
// therefore retried briefly before it is believed: a probe's hold ends within
// the first retry or two, while a genuine holder holds for its whole session
// and stays EAGAIN through every retry — the "another session has it open"
// error remains truthful.
const LOCK_ACQUIRE_ATTEMPTS = 25;
const LOCK_ACQUIRE_RETRY_MS = 8;

// {acquireSessionLock} runs synchronously inside the open handshake, so its
// retry pauses must be synchronous too (a blocked event loop for ≤200ms,
// only while another bridge's probe collides).
function sleepSynchronously(milliseconds) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

// Exclusive kernel flock on the ONE remote session. Every Claude session's
// bridge runs concurrently (discovery — tools, instructions, list_targets —
// must work in all of them), so the lock is held per OPEN session, not per
// bridge process. The kernel releases a flock when its holder dies — ANY
// death, SIGKILL included — so no stale-lock state exists to detect or clear
// (a pidfile's read-check-delete cycle is a race two bridges can both win).
// The lock file itself is permanent; its content, the holder's pid, is
// advisory display metadata only.
export function acquireSessionLock(stateDirectory = STATE_DIRECTORY) {
  ensurePrivateDirectory(stateDirectory);
  const lockFile = join(stateDirectory, "airlock.lock");
  let lockDescriptor;
  for (let attempt = 1; ; attempt += 1) {
    try {
      lockDescriptor = openSync(
        lockFile,
        constants.O_RDWR | constants.O_CREAT | O_EXLOCK | constants.O_NONBLOCK,
        0o600,
      );
      break;
    } catch (err) {
      if (err.code !== "EAGAIN" && err.code !== "EWOULDBLOCK") throw err;
      if (attempt >= LOCK_ACQUIRE_ATTEMPTS) {
        throw new SessionStateError(
          `Another Claude session's Airlock already has the remote session open — ` +
            `only one Airlock session can be open at a time. Ask the human to close ` +
            `it in that session first, or to say which session should own it.`,
        );
      }
      sleepSynchronously(LOCK_ACQUIRE_RETRY_MS);
    }
  }
  try {
    ftruncateSync(lockDescriptor, 0);
    writeFileSync(lockDescriptor, String(process.pid));
  } catch (err) {
    closeSync(lockDescriptor);
    throw err;
  }
  // Released exactly once: descriptor numbers are reused, so a second close
  // of a stale descriptor could close an unrelated open file.
  let released = false;
  return () => {
    if (released) return;
    released = true;
    closeSync(lockDescriptor);
  };
}

// Whether ANOTHER bridge currently holds the session lock: null when the lock
// is free or held by this process (its own session is reported via
// {SessionManager#activeTargetKey}); { pid } when held elsewhere, where pid is
// the holder's advisory self-report (null while its write is still in
// flight). The probe takes a momentary SHARED flock — denied by an exclusive
// holder, compatible with concurrent probes.
export function sessionLockHolder(stateDirectory = STATE_DIRECTORY) {
  const lockFile = join(stateDirectory, "airlock.lock");
  let probeDescriptor;
  try {
    probeDescriptor = openSync(lockFile, constants.O_RDONLY | O_SHLOCK | constants.O_NONBLOCK);
  } catch (err) {
    if (err.code === "ENOENT") return null;
    if (err.code !== "EAGAIN" && err.code !== "EWOULDBLOCK") throw err;
    const holderPid = advisoryHolderPid(lockFile);
    // A flock from THIS process (another descriptor of the same bridge)
    // denies the probe too — that is our own open, not another session's.
    if (holderPid === process.pid) return null;
    return { pid: holderPid };
  }
  closeSync(probeDescriptor);
  return null;
}

function advisoryHolderPid(lockFile) {
  let holderPid;
  try {
    holderPid = Number(readFileSync(lockFile, "utf8").trim());
  } catch {
    return null;
  }
  return Number.isInteger(holderPid) && holderPid > 0 ? holderPid : null;
}

function createDriver(target) {
  return target.driver === "rails_irb"
    ? createRailsIrbDriver({ startupCommands: target.startup ?? [] })
    : createShellDriver();
}

export class SessionManager {
  constructor({
    config,
    stateDirectory = STATE_DIRECTORY,
    tmux = new Tmux({ socketPath: join(stateDirectory, "tmux.sock") }),
    buildLaunchArgv: launchArgvBuilder = buildLaunchArgv,
  }) {
    this.config = config;
    this.tmux = tmux;
    this.buildLaunchArgv = launchArgvBuilder;
    this.stateDirectory = stateDirectory;
    this.sessionStateFile = join(stateDirectory, "session.json");
    this.activeSession = null;
    this.openInFlight = false;
    this.pendingOperation = null;
    this.pendingOperationName = null;
    this.inFlightAbortState = null;
    this.timeouts = {
      openMs: config.open_timeout_seconds * 1000,
      commandMs: config.command_timeout_seconds * 1000,
    };
    this.outputCap = {
      maxLines: config.output_max_lines,
      maxBytes: config.output_max_bytes,
    };
  }

  get activeTargetKey() {
    return this.activeSession ? this.activeSession.targetKey : null;
  }

  // The one-shot attach script the approval overlay's 👀 button opens — the
  // approve-and-watch path, as opposed to {ATTACH_CLIENT_PATH}, the looping
  // client the model relays after open_terminal.
  get watchScriptPath() {
    return this.tmux.watchCommandPath;
  }

  // Phase 1 of the open handshake: validate, enforce the one-session
  // invariants, and take the cross-bridge session lock — all BEFORE the human
  // is asked to approve anything, so the overlay never pops for an open that
  // is already doomed, and the held lock makes "is opening a session right
  // now" true for every prober while the human decides. Every handle must be
  // settled by exactly one of {SessionManager#commitOpen} /
  // {SessionManager#abortOpen}.
  beginOpen(targetKey) {
    if (this.activeSession) {
      throw new SessionStateError(
        `A session is already open (${this.activeSession.targetKey}). Close it before opening another.`,
      );
    }
    if (this.openInFlight) {
      throw new SessionStateError(
        `Another open_terminal call in this session is already awaiting approval. Wait for it to settle.`,
      );
    }
    // Own-property membership only: a plain lookup would let prototype keys
    // (`constructor`, `__proto__`, …) slip past the configured-target
    // allowlist with a truthy inherited value.
    if (typeof targetKey !== "string" || !Object.hasOwn(this.config.targets, targetKey)) {
      throw new SessionStateError(`Unknown target: ${String(targetKey)}. Use list_targets.`);
    }
    const releaseSessionLock = this.acquireSessionLockNamingTheHolder();
    this.openInFlight = true;
    return {
      targetKey,
      target: this.config.targets[targetKey],
      releaseSessionLock,
      settled: false,
    };
  }

  // The not-approved / overlay-failure path of the open handshake. Idempotent,
  // and a no-op once {SessionManager#commitOpen} owns the handle — an
  // unconditional finally-abort in the server must never release the lock of a
  // successfully opened session.
  abortOpen(openHandle) {
    if (openHandle.settled) return;
    openHandle.settled = true;
    this.openInFlight = false;
    openHandle.releaseSessionLock();
  }

  // Phase 2: the human approved — actually open the session. Releases the
  // lock on every failure path.
  async commitOpen(openHandle) {
    openHandle.settled = true;
    const { targetKey, target, releaseSessionLock } = openHandle;
    try {
      return await this.runExclusively("open_terminal", async () => {
        await this.assertNoLeftoverSession();

        const driver = createDriver(target);
        let startupReport;
        try {
          // The launch argv is the pane's DIRECT command (no local login
          // shell): the pane dies with the process, so a dead pane is the
          // connection-liveness signal. See {buildLaunchArgv} — the one seam
          // producing it.
          await this.tmux.createSession(this.buildLaunchArgv(this.config, target));
          startupReport = await driver.start({
            tmux: this.tmux,
            timeouts: this.timeouts,
            outputCap: this.outputCap,
          });
          // The state file lands BEFORE {activeSession} exists: if this write
          // fails, the catch below leaves the bridge fully closed — never
          // "session live but lock released".
          writeFileSync(
            this.sessionStateFile,
            JSON.stringify({ target: targetKey, pid: process.pid, opened_at: new Date().toISOString() }),
            { mode: 0o600 },
          );
        } catch (err) {
          // Best-effort reap of this call's OWN newborn session (never a
          // leftover — the assert above proved none existed), even when
          // createSession itself failed partway through pane setup. The
          // original failure is what must surface; a kill that fails too
          // leaves debris the next open's leftover refusal catches.
          await this.tmux.killSession().catch(() => undefined);
          // The waiters' generic timeout text promises "session preserved …
          // use interrupt_terminal" — true for send_terminal, false here:
          // the half-open session was just reaped. Correct the record.
          if (err instanceof Error) {
            err.message +=
              "\n[Airlock: this failure happened during open_terminal — the " +
              "half-open session was cleaned up, so there is nothing to " +
              "attach to or interrupt. Fix the cause and retry open_terminal.]";
          }
          throw err;
        }

        this.activeSession = { targetKey, target, driver, releaseSessionLock };
        // The result carries no socket path, session id, or tmux syntax (PLAN:
        // goal 5 / output capture) — only the attach-client path, which
        // encapsulates all of those.
        return (
          `Opened ${targetKey}. ${startupReport}\n\n` +
          attachBlockText(
            `Offer the human one-click eyes on this session: relay the attach ` +
              `command below verbatim, as its own bash-fenced code block — the ` +
              `app renders a Run button on it. Run in Claude Desktop's ` +
              `integrated terminal, it attaches to this session (watch and ` +
              `type). If their attach client is already running, it has ` +
              `auto-attached and they can ignore this.`,
          )
        );
      });
    } catch (err) {
      releaseSessionLock();
      throw err;
    } finally {
      this.openInFlight = false;
    }
  }

  async open(targetKey) {
    return this.commitOpen(this.beginOpen(targetKey));
  }

  // Live cross-bridge visibility for list_targets and the open handshake:
  // which OTHER Claude session's bridge holds the session lock, and (when its
  // state file is readable) what it has open.
  otherSessionHolder() {
    const holder = sessionLockHolder(this.stateDirectory);
    if (holder === null) return null;
    try {
      const state = JSON.parse(readFileSync(this.sessionStateFile, "utf8"));
      if (holder.pid !== null && state.pid === holder.pid) {
        return { pid: holder.pid, target: state.target, opened_at: state.opened_at };
      }
    } catch {
      // Lock held but no readable state: an open is mid-flight there.
    }
    return { pid: holder.pid, target: null, opened_at: null };
  }

  acquireSessionLockNamingTheHolder() {
    try {
      return acquireSessionLock(this.stateDirectory);
    } catch (err) {
      if (err instanceof SessionStateError) {
        const otherSession = this.otherSessionHolder();
        if (otherSession && otherSession.target) {
          throw new SessionStateError(
            `Another Claude session's Airlock has ${otherSession.target} open ` +
              `(since ${otherSession.opened_at}) — only one Airlock session can be ` +
              `open at a time. Ask the human to close it in that session first, ` +
              `or to say which session should own it.`,
          );
        }
      }
      throw err;
    }
  }

  // A leftover tmux session (an earlier bridge died or exited with it open)
  // is NEVER killed automatically: it is a real remote session — possibly
  // mid-command, possibly with the human attached. The server calls this
  // BEFORE the overlay (the human must not approve an already-doomed open);
  // {SessionManager#commitOpen} calls it again as the authoritative check.
  async assertNoLeftoverSession() {
    if (!(await this.sessionDefinitivelyDead())) {
      throw new SessionStateError(this.leftoverSessionText());
    }
  }

  leftoverSessionText() {
    let leftoverDetail = "";
    try {
      const state = JSON.parse(readFileSync(this.sessionStateFile, "utf8"));
      // The state file may outlive the session it described (an even earlier
      // leftover, or a manual attach-and-exit that had no bridge to clean up),
      // so its target is a hint, never an identification.
      if (typeof state.target === "string") {
        leftoverDetail = ` (last recorded state: ${state.target} — possibly stale; trust the terminal, not this label)`;
      }
    } catch {
      // No readable state: the leftover session is anonymous.
    }
    return (
      `A remote session left by an earlier Airlock bridge is still running${leftoverDetail}. ` +
      `Airlock never kills it automatically — it may be live, possibly with the human ` +
      `attached. Ask the human to end it (attach in the integrated terminal and exit ` +
      `the remote program), then open again. ` +
      attachBlockText(`One-click attach for the human (bash-fenced, verbatim):`)
    );
  }

  async send(command) {
    const abortState = { aborted: false };
    return this.runExclusively("send_terminal", async () => {
      // Registered BEFORE the first await: an interrupt approved while the
      // liveness probe below is still in flight must see — and abort — this
      // send, or its lines would paste after the C-c. Safe to set eagerly:
      // {SessionManager#runExclusively} rejects an overlapping send before
      // its callback runs, so no other send's state can be live here.
      this.inFlightAbortState = abortState;
      try {
        // Inside the queue: the liveness check (and the teardown it may
        // trigger) can never race an in-flight operation.
        const { driver } = await this.requireLiveSession();
        return await driver.runCommand({
          tmux: this.tmux,
          command,
          timeouts: this.timeouts,
          outputCap: this.outputCap,
          shouldAbort: () => abortState.aborted,
        });
      } finally {
        this.inFlightAbortState = null;
      }
    });
  }

  // Interrupt deliberately bypasses the send serialization: it exists to
  // recover a hung or wedged command, so it must work WHILE one is in
  // flight (the in-flight wait loop then sees the recovered prompt).
  async interrupt() {
    const activeSession = this.requireOpenSession();
    if (await this.sessionDefinitivelyDead()) {
      // No teardown here: interrupt runs OUTSIDE the exclusive queue, and the
      // cross-bridge lock must never be released while a send is mid-flight
      // in the pane. The next queued call reaps the dead session.
      throw this.sessionEndedError(activeSession.targetKey);
    }
    const { driver } = activeSession;
    // Aborting BEFORE the C-c lands closes the multi-line race: the in-flight
    // send must never treat the recovered prompt as permission to paste its
    // remaining lines.
    if (this.inFlightAbortState) this.inFlightAbortState.aborted = true;
    try {
      await this.tmux.sendInterrupt();
    } catch {
      // The session can end between the liveness probe above and the C-c
      // landing: surface the typed lifecycle errors, never a raw transport
      // error (which would leak tmux detail and read as an unexpected crash).
      if (await this.sessionDefinitivelyDead()) {
        throw this.sessionEndedError(activeSession.targetKey);
      }
      throw new SessionStateError(
        `Could not deliver the Ctrl-C (the send itself failed, but the session is still alive). Retry.`,
      );
    }
    if (this.pendingOperation) {
      // A close in flight is not a command — its call returns the close
      // report, not interrupted output.
      return this.pendingOperationName === "close_terminal"
        ? "Sent Ctrl-C while the session was closing. The close_terminal call continues and will report the outcome."
        : "Sent Ctrl-C. The in-flight command's call will return with the interrupted output.";
    }
    try {
      await waitForReadyPrompt({
        tmux: this.tmux,
        isReady: (snapshot) => driver.isReady(snapshot),
        timeoutMs: 5000,
      });
      return "Sent Ctrl-C. The remote prompt is ready again.";
    } catch (err) {
      const snapshot = await paneSnapshot(this.tmux).catch(() => null);
      return (
        `Sent Ctrl-C, but the remote prompt has not returned yet` +
        (snapshot ? ` (last line: ${JSON.stringify(snapshot.lastLine)})` : "") +
        `. ${err instanceof PaneStateError ? err.message : ""}`
      ).trim();
    }
  }

  async close() {
    this.requireOpenSession();
    // Close-during-send blocks until the in-flight command settles…
    while (this.pendingOperation) {
      await this.pendingOperation.catch(() => undefined);
    }
    // …and the teardown itself registers as the pending operation
    // (runExclusively is synchronous here, so nothing can slip in between the
    // loop exiting and the registration): a send arriving during teardown is
    // rejected with the in-flight error instead of racing kill-session.
    return this.runExclusively("close_terminal", async () => {
      // Re-checked INSIDE the queue: a concurrent close (or a reap) may have
      // emptied the session while this call waited in the loop above.
      const { targetKey, driver, releaseSessionLock } = this.requireOpenSession();
      if (!(await this.sessionDefinitivelyDead())) {
        // BEFORE the graceful exit: a typed `exit` can end the pane on its
        // own, detaching the watchers — the snapshot they repaint must
        // already be on disk when their tmux clients clear the terminal.
        await this.tmux.saveFinalScreen();
        await this.attemptGracefulExit(driver);
        // Graceful or not, the tmux session must be gone when close returns.
        await this.tmux.killSession();
      }
      this.activeSession = null;
      rmSync(this.sessionStateFile, { force: true });
      releaseSessionLock();
      return `Closed ${targetKey}. The tmux session and remote connection are terminated.`;
    });
  }

  async attemptGracefulExit(driver) {
    const deadline = Date.now() + GRACEFUL_CLOSE_TIMEOUT_MS;
    for (const exitCommand of driver.exitCommands ?? []) {
      if (!(await this.tmux.hasSession()) || Date.now() >= deadline) return;
      try {
        await driver.assertAtPrompt({ tmux: this.tmux });
        await this.tmux.pasteText(exitCommand);
        await this.tmux.sendEnter();
      } catch {
        return; // not at a prompt — fall through to the hard kill
      }
      // Give this exit a moment to kill the pane (or drop to the outer
      // shell, where the next exit command applies) before moving on.
      await this.waitForSessionDeath(Math.min(Date.now() + 1500, deadline));
    }
  }

  async waitForSessionDeath(deadline) {
    while (Date.now() < deadline) {
      if (!(await this.tmux.hasSession())) return;
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }

  // Reaping liveness gate — call ONLY from inside the exclusive queue, where
  // no other operation can be mid-flight when the teardown frees the lock.
  async requireLiveSession() {
    const activeSession = this.requireOpenSession();
    if (await this.sessionDefinitivelyDead()) {
      // The connection dropped (or the human killed the pane): a distinct,
      // terminal error — and the session lock frees so any bridge may open next.
      const { targetKey, releaseSessionLock } = activeSession;
      this.activeSession = null;
      rmSync(this.sessionStateFile, { force: true });
      releaseSessionLock();
      throw this.sessionEndedError(targetKey);
    }
    return activeSession;
  }

  requireOpenSession() {
    if (!this.activeSession) {
      throw new SessionStateError(`No session is open. Use open_terminal first.`);
    }
    return this.activeSession;
  }

  // True/false is tmux's DEFINITIVE answer. A failure of the probe itself
  // (tmux missing, socket unreadable) throws instead: an unverifiable session
  // must never be treated as a dead one — that path frees the cross-bridge
  // lock while the remote session may still be alive.
  async sessionDefinitivelyDead() {
    try {
      return !(await this.tmux.hasSession());
    } catch {
      throw new SessionStateError(
        `Could not verify the remote session is alive (the liveness probe itself failed). Retry.`,
      );
    }
  }

  sessionEndedError(targetKey) {
    return new SessionStateError(
      `The ${targetKey} session has ended (remote connection or pane is gone). Open it again with open_terminal.`,
    );
  }

  runExclusively(operationName, operation) {
    if (this.pendingOperation) {
      throw new SessionStateError(
        `Another command is already in flight in the remote terminal. ` +
          `Wait for it to return before calling ${operationName}.`,
      );
    }
    const pending = operation();
    // The tracking chain swallows rejection (the caller handles it on
    // `pending`) and clears itself once settled. The name lets
    // {SessionManager#interrupt} describe WHAT its C-c landed on.
    this.pendingOperationName = operationName;
    this.pendingOperation = pending
      .then(
        () => undefined,
        () => undefined,
      )
      .then(() => {
        this.pendingOperation = null;
        this.pendingOperationName = null;
      });
    return pending;
  }
}
