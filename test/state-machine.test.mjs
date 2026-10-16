// Airlock — one-active-session state machine tests (node --test).
//
// A scripted in-memory fake tmux emulates just enough pane behavior (echo,
// output, prompt redraw, Ctrl-C, `exit`) for the real shell driver to run
// against it — no real tmux server, no SSH, no approval panels.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, describe, it } from "node:test";

import { acquireSessionLock, SessionManager, SessionStateError } from "../src/session-manager.mjs";
import { Tmux } from "../src/tmux.mjs";

const PROMPT = "fake$ ";

const scratch = mkdtempSync(join(tmpdir(), "airlock-state-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// Emulates a pane running a shell: pasteText+sendEnter echoes the command,
// then (after outputDelayMs) appends its scripted output and a fresh prompt.
class FakeShellTmux {
  constructor({ outputDelayMs = 0, respond = () => [] } = {}) {
    this.outputDelayMs = outputDelayMs;
    this.respond = respond;
    this.alive = false;
    this.historyLines = [];
    this.pendingPaste = "";
    this.pendingOutputTimer = null;
    this.launchArgv = null;
  }

  async createSession(commandArgv) {
    this.launchArgv = commandArgv;
    this.alive = true;
    this.historyLines = [PROMPT];
  }

  async hasSession() {
    return this.alive;
  }

  async killSession() {
    this.alive = false;
    if (this.pendingOutputTimer) clearTimeout(this.pendingOutputTimer);
  }

  // The real Tmux snapshots the pane to disk before a close for the attach
  // scripts to repaint; the close path only requires the method to exist.
  async saveFinalScreen() {}

  async pasteText(text) {
    this.pendingPaste += text;
  }

  async sendEnter() {
    const commandLine = this.pendingPaste;
    this.pendingPaste = "";
    this.historyLines[this.historyLines.length - 1] = PROMPT + commandLine;
    if (commandLine === "exit") {
      this.alive = false;
      return;
    }
    const finish = () => {
      this.pendingOutputTimer = null;
      this.historyLines.push(...this.respond(commandLine), PROMPT);
    };
    if (this.outputDelayMs > 0) {
      this.pendingOutputTimer = setTimeout(finish, this.outputDelayMs);
    } else {
      finish();
    }
  }

  async sendInterrupt() {
    if (this.pendingOutputTimer) {
      clearTimeout(this.pendingOutputTimer);
      this.pendingOutputTimer = null;
    }
    this.historyLines.push("^C", PROMPT);
  }

  async capturePane({ fullHistory = false } = {}) {
    const lines = fullHistory ? this.historyLines : this.historyLines.slice(-50);
    return lines.join("\n");
  }

  async cursorAndScreenState() {
    const lastLine = this.historyLines[this.historyLines.length - 1] ?? "";
    return { cursorX: lastLine.length, cursorY: 0, alternateScreen: false };
  }

  async displayMessage(format) {
    if (format.includes("history_size")) return "0,50000";
    throw new Error(`FakeShellTmux does not script ${format}`);
  }
}

function buildSessionManager({ tmux, stateDirectory, buildLaunchArgv = () => ["/usr/bin/true"] }) {
  const config = {
    sshConfigPath: "/dev/null",
    instructions: "test",
    targets: {
      "fake-shell": {
        description: "Fake shell",
        display_command: "ssh fake",
        ssh_host: "fake",
        driver: "shell",
      },
    },
    overlay_timeout_seconds: 5,
    open_timeout_seconds: 10,
    command_timeout_seconds: 5,
    output_max_lines: 400,
    output_max_bytes: 65536,
  };
  return new SessionManager({
    config,
    tmux,
    stateDirectory,
    // The launch seam: unit tests never build a real launch argv at all.
    buildLaunchArgv,
  });
}

describe("SessionManager — one active session", () => {
  let stateDirectory;
  beforeEach(() => {
    stateDirectory = mkdtempSync(join(scratch, "state-"));
  });

  it("rejects send, interrupt, and close with no session open", async () => {
    const sessionManager = buildSessionManager({ tmux: new FakeShellTmux(), stateDirectory });
    await assert.rejects(sessionManager.send("pwd"), /No session is open/);
    await assert.rejects(sessionManager.interrupt(), /No session is open/);
    await assert.rejects(sessionManager.close(), /No session is open/);
  });

  it("rejects unknown and prototype-key targets", async () => {
    const sessionManager = buildSessionManager({ tmux: new FakeShellTmux(), stateDirectory });
    for (const targetKey of ["nope", "constructor", "__proto__", "hasOwnProperty"]) {
      await assert.rejects(sessionManager.open(targetKey), /Unknown target/);
    }
  });

  it("opens once, exposes the active target, and rejects a second open", async () => {
    const tmux = new FakeShellTmux();
    const sessionManager = buildSessionManager({ tmux, stateDirectory });
    const report = await sessionManager.open("fake-shell");
    assert.match(report, /^Opened fake-shell\./);
    // PLAN goal 5: no transport details in the model-facing result…
    assert.doesNotMatch(report, /tmux|sock|-S /);
    // …except the one sanctioned attach-client path, bash-fenced so the app
    // renders a one-click Run button (the script encapsulates the transport).
    assert.match(report, /```bash\n\/.*\/bin\/airlock-attach\n```/);
    assert.equal(sessionManager.activeTargetKey, "fake-shell");
    assert.deepEqual(tmux.launchArgv, ["/usr/bin/true"]);
    await assert.rejects(sessionManager.open("fake-shell"), /already open/);
    assert.ok(existsSync(join(stateDirectory, "session.json")));
  });

  it("sends a command and returns only its output (echo and prompt stripped)", async () => {
    const tmux = new FakeShellTmux({
      respond: (commandLine) => (commandLine === "echo hi" ? ["hi"] : []),
    });
    const sessionManager = buildSessionManager({ tmux, stateDirectory });
    await sessionManager.open("fake-shell");
    assert.equal(await sessionManager.send("echo hi"), "hi");
  });

  it("rejects an overlapping send instead of interleaving pastes", async () => {
    const tmux = new FakeShellTmux({ outputDelayMs: 400, respond: () => ["slow done"] });
    const sessionManager = buildSessionManager({ tmux, stateDirectory });
    await sessionManager.open("fake-shell");
    const firstSend = sessionManager.send("slow");
    await sleep(50);
    await assert.rejects(sessionManager.send("second"), /Another command is already in flight/);
    assert.equal(await firstSend, "slow done");
  });

  it("blocks close-during-send until the in-flight command settles", async () => {
    const tmux = new FakeShellTmux({ outputDelayMs: 300, respond: () => ["done"] });
    const sessionManager = buildSessionManager({ tmux, stateDirectory });
    await sessionManager.open("fake-shell");
    const events = [];
    const sendPromise = sessionManager.send("slow").then((output) => events.push(`send:${output}`));
    await sleep(50);
    const closePromise = sessionManager.close().then(() => events.push("close"));
    await Promise.all([sendPromise, closePromise]);
    assert.deepEqual(events, ["send:done", "close"]);
    assert.equal(sessionManager.activeTargetKey, null);
  });

  it("interrupts an in-flight command: the pending send returns, not the interrupt", async () => {
    const tmux = new FakeShellTmux({ outputDelayMs: 5000, respond: () => ["never shown"] });
    const sessionManager = buildSessionManager({ tmux, stateDirectory });
    await sessionManager.open("fake-shell");
    const pendingSend = sessionManager.send("sleep 5000");
    await sleep(100);
    const interruptReport = await sessionManager.interrupt();
    assert.match(interruptReport, /in-flight command's call will return/);
    const interruptedOutput = await pendingSend;
    assert.match(interruptedOutput, /\^C/);
  });

  it("aborts a send whose liveness probe is still in flight when the interrupt lands", async () => {
    const tmux = new FakeShellTmux({ outputDelayMs: 5000, respond: () => ["never shown"] });
    const sessionManager = buildSessionManager({ tmux, stateDirectory });
    await sessionManager.open("fake-shell");
    // Slow ONLY the send's own liveness probe: the interrupt arrives while
    // the send is registered but has not yet touched the pane. The abort hook
    // is set synchronously at queue entry, so the interrupt must still see it.
    const realHasSession = tmux.hasSession.bind(tmux);
    let probeDelayMs = 150;
    tmux.hasSession = async () => {
      const delayMs = probeDelayMs;
      probeDelayMs = 0;
      if (delayMs > 0) await sleep(delayMs);
      return realHasSession();
    };
    const pendingSend = sessionManager.send("sleep 5000");
    const interruptReport = await sessionManager.interrupt();
    assert.match(interruptReport, /in-flight command's call will return/);
    const interruptedOutput = await pendingSend;
    assert.match(interruptedOutput, /\[Airlock: interrupted/);
    assert.doesNotMatch(interruptedOutput, /never shown/); // the command never pasted
  });

  it("says the Ctrl-C landed on a close, not a command, when close is in flight", async () => {
    // A fake whose `exit` does not end the pane: the graceful-close path
    // lingers long enough for an interrupt to land mid-close.
    class LingeringShellTmux extends FakeShellTmux {
      async sendEnter() {
        if (this.pendingPaste === "exit") {
          this.historyLines[this.historyLines.length - 1] = PROMPT + this.pendingPaste;
          this.pendingPaste = "";
          this.historyLines.push(PROMPT);
          return;
        }
        return super.sendEnter();
      }
    }
    const tmux = new LingeringShellTmux();
    const sessionManager = buildSessionManager({ tmux, stateDirectory });
    await sessionManager.open("fake-shell");
    const pendingClose = sessionManager.close();
    await sleep(100);
    const interruptReport = await sessionManager.interrupt();
    // Never "the in-flight command's call will return with the interrupted
    // output" — close_terminal returns a close report, not command output.
    assert.match(interruptReport, /close_terminal call continues/);
    assert.match(await pendingClose, /^Closed fake-shell\./);
  });

  it("fails send with a distinct liveness error when the pane dies, then requires reopen", async () => {
    const tmux = new FakeShellTmux();
    const sessionManager = buildSessionManager({ tmux, stateDirectory });
    await sessionManager.open("fake-shell");
    tmux.alive = false; // the connection dropped: the pane is gone
    await assert.rejects(sessionManager.send("pwd"), /session has ended \(remote connection or pane is gone\)/);
    // The dead session is cleared: the next failure is the plain no-session error.
    await assert.rejects(sessionManager.send("pwd"), /No session is open/);
    assert.ok(!existsSync(join(stateDirectory, "session.json")));
  });

  it("closes cleanly: graceful exit, tmux session gone, state removed, errors typed", async () => {
    const tmux = new FakeShellTmux();
    const sessionManager = buildSessionManager({ tmux, stateDirectory });
    await sessionManager.open("fake-shell");
    const report = await sessionManager.close();
    assert.match(report, /^Closed fake-shell\./);
    assert.equal(await tmux.hasSession(), false);
    assert.equal(sessionManager.activeTargetKey, null);
    assert.ok(!existsSync(join(stateDirectory, "session.json")));
    await assert.rejects(sessionManager.close(), (err) => err instanceof SessionStateError);
  });
});

// The lock is per OPEN session, not per bridge process: bridges in every
// Claude session run concurrently for discovery, and only an actual
// open_terminal contends. The lock is a kernel flock, so "another live
// bridge" must be a REAL process holding it (file content alone proves
// nothing), and any death of the holder — SIGKILL included — releases it.
describe("SessionManager — cross-bridge session lock", () => {
  let stateDirectory;
  let lockFile;
  beforeEach(() => {
    stateDirectory = mkdtempSync(join(scratch, "lock-"));
    lockFile = join(stateDirectory, "airlock.lock");
  });

  // Spawns a real second process that takes the flock (O_EXLOCK) on lockFile
  // and idles until killed. Resolves once the lock is held.
  async function spawnLockHolder() {
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `const { ftruncateSync, openSync, writeSync, constants } = require("node:fs");
         const fd = openSync(${JSON.stringify(lockFile)},
           constants.O_RDWR | constants.O_CREAT | 0x20 | constants.O_NONBLOCK, 0o600);
         ftruncateSync(fd, 0);
         writeSync(fd, String(process.pid));
         console.log("locked");
         setInterval(() => {}, 1e6);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise((resolve, reject) => {
      holder.stdout.once("data", resolve);
      holder.once("exit", (code) => reject(new Error(`lock holder exited ${code} before locking`)));
    });
    return holder;
  }

  function killAndAwaitExit(holder) {
    return new Promise((resolve) => {
      holder.once("exit", resolve);
      holder.kill("SIGKILL");
    });
  }

  function assertLockHeld() {
    assert.throws(() => acquireSessionLock(stateDirectory), SessionStateError);
  }

  function assertLockFree() {
    acquireSessionLock(stateDirectory)();
  }

  it("holds the kernel lock while open, releases on close, and can reopen", async () => {
    const sessionManager = buildSessionManager({ tmux: new FakeShellTmux(), stateDirectory });
    await sessionManager.open("fake-shell");
    assert.equal(readFileSync(lockFile, "utf8"), String(process.pid));
    assertLockHeld();
    await sessionManager.close();
    assertLockFree();
    await sessionManager.open("fake-shell");
    assertLockHeld();
  });

  it("rejects open while another live bridge holds the lock", async () => {
    const holder = await spawnLockHolder();
    try {
      const sessionManager = buildSessionManager({ tmux: new FakeShellTmux(), stateDirectory });
      await assert.rejects(
        sessionManager.open("fake-shell"),
        (err) =>
          err instanceof SessionStateError &&
          /Another Claude session's Airlock already has the remote session open/.test(err.message),
      );
      assert.equal(readFileSync(lockFile, "utf8"), String(holder.pid)); // untouched
    } finally {
      await killAndAwaitExit(holder);
    }
  });

  it("releases a SIGKILLed bridge's lock by itself — no stale state to clear", async () => {
    const holder = await spawnLockHolder();
    const sessionManager = buildSessionManager({ tmux: new FakeShellTmux(), stateDirectory });
    await assert.rejects(sessionManager.open("fake-shell"), /Another Claude session's Airlock/);
    await killAndAwaitExit(holder);
    await sessionManager.open("fake-shell");
    assert.equal(sessionManager.activeTargetKey, "fake-shell");
  });

  it("rides out another bridge's momentary shared-lock probe instead of faking a holder", async () => {
    // {sessionLockHolder}'s SHARED probe (any bridge's list_targets) briefly
    // denies O_EXLOCK too — BSD flock shared and exclusive locks conflict
    // cross-process. The acquire must retry through such a hold instead of
    // reporting a phantom "another session has it open". The child holds a
    // shared lock ~25ms, then exits (the kernel releases it on death).
    const prober = spawn(
      process.execPath,
      [
        "-e",
        `const { openSync, constants } = require("node:fs");
         openSync(${JSON.stringify(lockFile)},
           constants.O_RDWR | constants.O_CREAT | 0x10 | constants.O_NONBLOCK, 0o600);
         console.log("locked");
         setTimeout(() => process.exit(0), 25);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    await new Promise((resolve, reject) => {
      prober.stdout.once("data", resolve);
      prober.once("exit", (code) => reject(new Error(`prober exited ${code} before locking`)));
    });
    acquireSessionLock(stateDirectory)(); // succeeds only by retrying through the hold
    await new Promise((resolve) => prober.once("exit", resolve));
  });

  it("treats lock file content as advisory: leftover pids and garbage never block", async () => {
    for (const leftoverContent of ["999999", "1", "0", "-7", "", "not a pid"]) {
      writeFileSync(lockFile, leftoverContent);
      assertLockFree();
    }
    const sessionManager = buildSessionManager({ tmux: new FakeShellTmux(), stateDirectory });
    writeFileSync(lockFile, "999999");
    await sessionManager.open("fake-shell");
    assert.equal(readFileSync(lockFile, "utf8"), String(process.pid));
  });

  it("releases the lock when open fails partway", async () => {
    class ExplodingTmux extends FakeShellTmux {
      async createSession() {
        throw new Error("tmux exploded");
      }
    }
    const sessionManager = buildSessionManager({ tmux: new ExplodingTmux(), stateDirectory });
    await assert.rejects(sessionManager.open("fake-shell"), /tmux exploded/);
    assertLockFree();
  });

  it("releases the lock when the pane is found dead", async () => {
    const tmux = new FakeShellTmux();
    const sessionManager = buildSessionManager({ tmux, stateDirectory });
    await sessionManager.open("fake-shell");
    tmux.alive = false; // the connection dropped
    await assert.rejects(sessionManager.send("pwd"), /session has ended/);
    assertLockFree();
  });

  it("reports another live holder via otherSessionHolder, never itself", async () => {
    const sessionManager = buildSessionManager({ tmux: new FakeShellTmux(), stateDirectory });
    assert.equal(sessionManager.otherSessionHolder(), null); // no lock at all
    await sessionManager.open("fake-shell");
    assert.equal(sessionManager.otherSessionHolder(), null); // own lock is not "other"
    await sessionManager.close();
    const holder = await spawnLockHolder();
    try {
      // Lock held elsewhere, but that bridge's session.json is not written yet.
      assert.deepEqual(sessionManager.otherSessionHolder(), {
        pid: holder.pid,
        target: null,
        opened_at: null,
      });
      writeFileSync(
        join(stateDirectory, "session.json"),
        JSON.stringify({ target: "fake-shell", pid: holder.pid, opened_at: "2026-08-23T00:00:00Z" }),
      );
      assert.deepEqual(sessionManager.otherSessionHolder(), {
        pid: holder.pid,
        target: "fake-shell",
        opened_at: "2026-08-23T00:00:00Z",
      });
    } finally {
      await killAndAwaitExit(holder);
    }
    assert.equal(sessionManager.otherSessionHolder(), null); // released with the holder's death
  });
});

// The open handshake: the lock is taken in beginOpen — BEFORE the human is
// asked to approve — and settled by exactly one of commitOpen/abortOpen.
describe("SessionManager — open handshake (beginOpen/commitOpen/abortOpen)", () => {
  let stateDirectory;
  beforeEach(() => {
    stateDirectory = mkdtempSync(join(scratch, "handshake-"));
  });

  function assertLockHeld() {
    assert.throws(() => acquireSessionLock(stateDirectory), SessionStateError);
  }

  function assertLockFree() {
    acquireSessionLock(stateDirectory)();
  }

  it("beginOpen takes the lock; abortOpen releases it and is idempotent", async () => {
    const sessionManager = buildSessionManager({ tmux: new FakeShellTmux(), stateDirectory });
    const openHandle = sessionManager.beginOpen("fake-shell");
    assertLockHeld();
    sessionManager.abortOpen(openHandle);
    assertLockFree();
    sessionManager.abortOpen(openHandle); // second abort: no-op, no throw
    await sessionManager.open("fake-shell"); // the airlock is not wedged
  });

  it("abortOpen after commitOpen never releases the live session's lock", async () => {
    const sessionManager = buildSessionManager({ tmux: new FakeShellTmux(), stateDirectory });
    const openHandle = sessionManager.beginOpen("fake-shell");
    await sessionManager.commitOpen(openHandle);
    sessionManager.abortOpen(openHandle); // the server's unconditional finally
    assertLockHeld(); // still held by the open session
    await sessionManager.close();
    assertLockFree();
  });

  it("attributes a second open in the SAME bridge to this session, not another", async () => {
    const sessionManager = buildSessionManager({ tmux: new FakeShellTmux(), stateDirectory });
    const openHandle = sessionManager.beginOpen("fake-shell");
    assert.throws(
      () => sessionManager.beginOpen("fake-shell"),
      /already awaiting approval/, // NOT "Another Claude session's Airlock"
    );
    sessionManager.abortOpen(openHandle);
  });

  it("refuses to open over a leftover session instead of killing it", async () => {
    const tmux = new FakeShellTmux();
    // A live tmux session from an earlier bridge that died with it open.
    tmux.alive = true;
    tmux.historyLines = [PROMPT];
    writeFileSync(
      join(stateDirectory, "session.json"),
      JSON.stringify({ target: "fake-shell", pid: 999999, opened_at: "2026-08-23T00:00:00Z" }),
    );
    const sessionManager = buildSessionManager({ tmux, stateDirectory });
    const leftoverError = await sessionManager.open("fake-shell").then(
      () => assert.fail("open must refuse over a leftover session"),
      (err) => err,
    );
    assert.match(leftoverError.message, /never kills it automatically/);
    // The recorded target is a hedged hint (the state file may describe an
    // older leftover), and the refusal carries the one-click attach block.
    assert.match(leftoverError.message, /fake-shell/);
    assert.match(leftoverError.message, /possibly stale/);
    assert.match(leftoverError.message, /```bash\n\/.*\/bin\/airlock-attach\n```/);
    assert.equal(tmux.alive, true); // the leftover session was NOT killed
    assertLockFree(); // and the failed open released the lock
  });

  it("assertNoLeftoverSession is the pre-overlay leftover check", async () => {
    const tmux = new FakeShellTmux();
    const sessionManager = buildSessionManager({ tmux, stateDirectory });
    await sessionManager.assertNoLeftoverSession(); // nothing anywhere: clear
    tmux.alive = true; // a dead bridge's session, live on the socket
    await assert.rejects(
      sessionManager.assertNoLeftoverSession(),
      (err) => err instanceof SessionStateError && /never kills it automatically/.test(err.message),
    );
  });

  it("reaps its own newborn session when pane setup fails after new-session", async () => {
    // createSession is several tmux commands: new-session can succeed and a
    // later setup step fail, leaving a LIVE just-created session. That
    // newborn (never a leftover — the pre-check proved none existed) must be
    // reaped, or it becomes leftover debris that dooms every future open.
    class PartialSetupTmux extends FakeShellTmux {
      async createSession(commandArgv) {
        await super.createSession(commandArgv);
        throw new Error("resize-window exited 1");
      }
    }
    const tmux = new PartialSetupTmux();
    const sessionManager = buildSessionManager({ tmux, stateDirectory });
    await assert.rejects(sessionManager.open("fake-shell"), /resize-window/);
    assert.equal(tmux.alive, false); // the newborn was killed
    assertLockFree();
  });

  it("surfaces the original startup failure even when the cleanup kill fails too", async () => {
    const tmux = new FakeShellTmux();
    const sessionManager = buildSessionManager({ tmux, stateDirectory });
    mkdirSync(join(stateDirectory, "session.json")); // EISDIR at the state write
    tmux.killSession = async () => {
      throw new Error("kill failed too");
    };
    await assert.rejects(sessionManager.open("fake-shell"), /EISDIR/);
    assertLockFree();
  });

  it("leaves the bridge fully closed when the session state file cannot be written", async () => {
    const tmux = new FakeShellTmux();
    const sessionManager = buildSessionManager({ tmux, stateDirectory });
    // A directory at the state-file path makes writeFileSync fail (EISDIR).
    mkdirSync(join(stateDirectory, "session.json"));
    await assert.rejects(sessionManager.open("fake-shell"), /EISDIR/);
    assert.equal(sessionManager.activeTargetKey, null); // not "open but unlocked"
    assert.equal(tmux.alive, false); // the just-started session was killed
    assertLockFree();
  });
});

// Liveness handling: a failed probe is not a dead session, and teardown never
// races an in-flight operation.
describe("SessionManager — liveness probes and teardown safety", () => {
  let stateDirectory;
  beforeEach(() => {
    stateDirectory = mkdtempSync(join(scratch, "liveness-"));
  });

  function assertLockHeld() {
    assert.throws(() => acquireSessionLock(stateDirectory), SessionStateError);
  }

  it("keeps the session and the lock when the liveness probe itself fails", async () => {
    const tmux = new FakeShellTmux();
    const sessionManager = buildSessionManager({ tmux, stateDirectory });
    await sessionManager.open("fake-shell");
    const realHasSession = tmux.hasSession.bind(tmux);
    tmux.hasSession = async () => {
      throw new Error("tmux probe exploded");
    };
    await assert.rejects(sessionManager.send("pwd"), /Could not verify the remote session is alive/);
    assert.equal(sessionManager.activeTargetKey, "fake-shell"); // NOT torn down
    assertLockHeld();
    tmux.hasSession = realHasSession; // probe recovers → the session still works
    assert.equal(await sessionManager.send("echo hi"), "");
  });

  it("interrupt on a dead pane reports the death but never reaps or frees the lock", async () => {
    const tmux = new FakeShellTmux();
    const sessionManager = buildSessionManager({ tmux, stateDirectory });
    await sessionManager.open("fake-shell");
    tmux.alive = false;
    await assert.rejects(sessionManager.interrupt(), /session has ended/);
    assert.equal(sessionManager.activeTargetKey, "fake-shell"); // interrupt never tears down
    assertLockHeld();
    await assert.rejects(sessionManager.send("pwd"), /session has ended/); // the queued call reaps
    assert.equal(sessionManager.activeTargetKey, null);
  });

  it("maps a Ctrl-C send that fails because the session just died to the typed ended error", async () => {
    const tmux = new FakeShellTmux();
    const sessionManager = buildSessionManager({ tmux, stateDirectory });
    await sessionManager.open("fake-shell");
    // The session ends between interrupt's liveness probe and the C-c landing.
    tmux.sendInterrupt = async () => {
      tmux.alive = false;
      throw new Error("tmux send-keys exited 1: can't find session: airlock");
    };
    await assert.rejects(
      sessionManager.interrupt(),
      (err) => err instanceof SessionStateError && /session has ended/.test(err.message),
    );
    assert.equal(sessionManager.activeTargetKey, "fake-shell"); // interrupt never reaps
  });

  it("maps a Ctrl-C send that fails while the session lives to a retryable typed error", async () => {
    const tmux = new FakeShellTmux();
    const sessionManager = buildSessionManager({ tmux, stateDirectory });
    await sessionManager.open("fake-shell");
    const realSendInterrupt = tmux.sendInterrupt.bind(tmux);
    tmux.sendInterrupt = async () => {
      throw new Error("tmux send-keys exited 1: flaky");
    };
    await assert.rejects(
      sessionManager.interrupt(),
      (err) => err instanceof SessionStateError && /Could not deliver the Ctrl-C/.test(err.message),
    );
    tmux.sendInterrupt = realSendInterrupt; // transient — the retry works
    assert.match(await sessionManager.interrupt(), /remote prompt is ready again/);
  });

  it("close keeps the session, state, and lock when the kill cannot be verified", async () => {
    const tmux = new FakeShellTmux();
    const sessionManager = buildSessionManager({ tmux, stateDirectory });
    await sessionManager.open("fake-shell");
    const realKillSession = tmux.killSession.bind(tmux);
    tmux.killSession = async () => {
      throw new Error("tmux kill-session exited 1: server crashed");
    };
    await assert.rejects(sessionManager.close(), /server crashed/);
    // An unverifiable kill must never report "Closed" or free the lock over
    // a session that may still be running.
    assert.equal(sessionManager.activeTargetKey, "fake-shell");
    assert.ok(existsSync(join(stateDirectory, "session.json")));
    assertLockHeld();
    // The pane actually died (the graceful exit landed before the kill), so
    // a retried close verifies that and succeeds without needing the kill.
    tmux.killSession = realKillSession;
    assert.match(await sessionManager.close(), /^Closed fake-shell\./);
  });

  it("settles concurrent closes cleanly: one closes, the other gets the typed error", async () => {
    const sessionManager = buildSessionManager({ tmux: new FakeShellTmux(), stateDirectory });
    await sessionManager.open("fake-shell");
    const outcomes = await Promise.allSettled([sessionManager.close(), sessionManager.close()]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === "fulfilled");
    const rejected = outcomes.filter((outcome) => outcome.status === "rejected");
    assert.equal(fulfilled.length, 1);
    assert.match(fulfilled[0].value, /^Closed fake-shell\./);
    assert.equal(rejected.length, 1);
    assert.ok(rejected[0].reason instanceof SessionStateError); // never a TypeError
  });
});

describe("Tmux — killSession strictness", () => {
  it("swallows only tmux's definitive 'already gone' answers", async () => {
    const tmux = new Tmux({ socketPath: join(mkdtempSync(join(scratch, "tmuxdir-")), "tmux.sock") });
    tmux.command = async () => {
      throw new Error("tmux kill-session exited 1: can't find session: airlock");
    };
    await tmux.killSession(); // already gone IS success for a kill
    tmux.command = async () => {
      throw new Error("spawn tmux EMFILE");
    };
    // An unverifiable kill rethrows: close would otherwise report success
    // and release the cross-bridge lock over a possibly-live session.
    await assert.rejects(tmux.killSession(), /EMFILE/);
  });

  it("treats 'no current target' — a lingering server with no sessions — as gone", async () => {
    // After the last session is destroyed the private socket's server stays
    // up briefly and answers this to every -t lookup; a close landing in
    // that window must still count as closed.
    const tmux = new Tmux({ socketPath: join(mkdtempSync(join(scratch, "tmuxdir-")), "tmux.sock") });
    tmux.command = async () => {
      throw new Error("/opt/homebrew/bin/tmux -S exited 1: no current target");
    };
    await tmux.killSession();
    assert.equal(await tmux.hasSession(), false);
  });
});
