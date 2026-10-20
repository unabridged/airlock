// Airlock — private-socket tmux wrapper.
//
// Every invocation targets the bridge's own tmux server via `-S` under a 0700
// state directory — never the user's default server. All processes are
// spawned with explicit executable + argv arrays; no string is ever handed to
// a shell, and command text travels only through load-buffer/paste-buffer
// (a real C-c via send-keys is the single, deliberate exception).

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Short by design: macOS Unix-socket paths are capped near 104 bytes.
export const STATE_DIRECTORY = join(homedir(), ".local", "state", "airlock");
export const SOCKET_PATH = join(STATE_DIRECTORY, "tmux.sock");
export const SESSION_NAME = "airlock";

// Pinned geometry (window-size manual): reflow from an attach/resize would
// break last-line prompt matching mid-capture.
const PANE_WIDTH = 200;
const PANE_HEIGHT = 50;
const HISTORY_LIMIT = 50000;

// The bridge server's own options, set in the same invocation as the
// new-session that may start the server. tmux fixes a pane's history limit
// at window creation (a post-creation set-option is a no-op for the existing
// pane — verified on tmux 3.4), so the limit must already be the global
// default when new-session creates the window. The terminal-overrides entry
// strips the alternate-screen capability from every attaching client's
// terminal, so tmux paints the watcher's window in its primary buffer (real
// scrollback, no restore-on-exit). That alone does NOT preserve content at
// session end: the tmux client clears the screen unconditionally in its tty
// restore at exit (ESC[H ESC[2J — verified by recording a client's bytes), so
// the attach scripts repaint the bridge-saved final screen afterwards — see
// {Tmux#saveFinalScreen} and {watchCommandContent}.
const SERVER_OPTION_COMMANDS = [
  ...["set-option", "-g", "history-limit", String(HISTORY_LIMIT), ";"],
  ...["set-option", "-g", "terminal-overrides", ",*:smcup@:rmcup@", ";"],
];

// Every invocation names this config file, which stops the bridge server
// from reading the user's own ~/.tmux.conf (verified: without it, the user's
// history-limit leaked in).
const EMPTY_CONFIG_PATH = "/dev/null";

// The arguments every tmux invocation starts with, the attach scripts'
// included. tmux reads -f only in the invocation that starts the server, and
// attach-session starts one when none is running (a session that ends after
// a watcher's has-session check), so no call may leave the config out.
function serverArguments(socketPath) {
  return ["-S", socketPath, "-f", EMPTY_CONFIG_PATH];
}

// tmux ends a command at any argument that ends in ";", even after "--", and
// reads a trailing "\;" as a literal ";". Escaping that last character hands
// new-session its command argv verbatim, so no argument of a target can
// start a tmux command of its own.
function escapeTrailingCommandSeparator(argument) {
  return argument.endsWith(";") ? `${argument.slice(0, -1)}\\;` : argument;
}

// The terminal the attach scripts fall back to when the bundled tmux's
// terminfo directory has no entry for the human's TERM.
const FALLBACK_TERMINAL = "xterm-256color";

const TMUX_CANDIDATES = ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "tmux"];

// Wraps `word` in single quotes for a POSIX shell, whatever it contains.
export function shellQuote(word) {
  return `'${word.replaceAll("'", "'\\''")}'`;
}

// The tmux a development instance runs: the first Homebrew install found,
// else whatever `tmux` the PATH resolves.
export function defaultTmuxExecutable() {
  return TMUX_CANDIDATES.find((candidate) => candidate === "tmux" || existsSync(candidate)) ?? "tmux";
}

// Replaces `path` with a new file holding `content`. The content goes to a
// fresh file beside it (O_EXCL, so nothing planted there is written through)
// that is then renamed over `path`, which swaps the directory entry, a
// symlink included, without following it. Concurrent writers each rename a
// whole file, so the last one wins.
export function replaceFile(path, content, mode) {
  const temporaryPath = `${path}.${process.pid}-${randomBytes(6).toString("hex")}`;
  try {
    writeFileSync(temporaryPath, content, { mode, flag: "wx" });
    renameSync(temporaryPath, path);
  } catch (error) {
    rmSync(temporaryPath, { force: true });
    throw error;
  }
}

// The `NAME='value' ` prefix that hands `environment` to a shell command.
function environmentPrefix(environment) {
  return Object.entries(environment)
    .map(([name, value]) => `${name}=${shellQuote(value)} `)
    .join("");
}

// The zsh lines that switch TERM to {FALLBACK_TERMINAL} unless the TERMINFO
// directory in `environment` holds an entry for it. The attaching client's
// ncurses searches $TERMINFO first, so a hit there ends its lookup before
// ~/.terminfo, $TERMINFO_DIRS, or its own Homebrew prefix, all writable by
// the user.
function terminalFallbackLines(environment) {
  if (!environment.TERMINFO) return "";
  const entryPath = `${shellQuote(environment.TERMINFO)}/$(printf %02x "'\${TERM[1]}")/$TERM`;
  return `if [[ $TERM == */* || ! -f ${entryPath} ]]; then
  export TERM=${FALLBACK_TERMINAL}
fi
`;
}

// One-shot attach script for the approval overlay's 👀 button: the helper
// hands it to /usr/bin/open, Terminal runs it, and it attaches to the bridge
// session. It polls first because open_terminal creates the session only
// AFTER approval — at 👀-press time the session may not exist yet. The
// escape sequence resizes the Terminal window to the pinned pane geometry so
// the attach shows the full pane instead of a shrunken reflow.
function watchCommandContent({ executable, environment, socketPath, sessionName, finalScreenPath }) {
  const tmuxWords = [executable, ...serverArguments(socketPath)].map(shellQuote);
  const tmuxArgv = `${environmentPrefix(environment)}${tmuxWords.join(" ")}`;
  return `#!/bin/zsh
# Airlock — one-shot attach for the approval overlay's eyes button.
# Generated by src/tmux.mjs; regenerated on every bridge start. Do not edit.
printf '\\033[8;${PANE_HEIGHT};${PANE_WIDTH}t'
${terminalFallbackLines(environment)}for _ in {1..100}; do
  if ${tmuxArgv} has-session -t ${shellQuote(sessionName)} 2>/dev/null; then
    ${tmuxArgv} attach-session -t ${shellQuote(sessionName)}
    # The tmux client clears the screen unconditionally when it exits, even
    # with the alternate screen suppressed. The bridge saves the pane's final
    # screen right before closing the session (and deletes it when a new
    # session starts), so a present file means this attach just ended in a
    # close — repaint it so the rendered session content survives.
    if [[ -f ${shellQuote(finalScreenPath)} ]]; then
      printf '\\033[H\\033[2J'
      cat -- ${shellQuote(finalScreenPath)}
      printf '\\n[airlock] session closed — its final screen is restored above.\\n'
    fi
    # Never exit: the terminal may close the window when its command ends
    # (an iTerm/Terminal profile setting), taking the preserved screen with
    # it. Handing the window to an interactive shell keeps it open — and
    # banner-free — until the human closes it.
    exec /bin/zsh -i
  fi
  sleep 0.2
done
echo 'airlock: no session appeared within 20 seconds.' >&2
exec /bin/zsh -i
`;
}

// tmux's definitive "that session does not exist" answers — "no session",
// "no server", and "no current target" (on the private socket: the server has
// no sessions at all, which it lingers in briefly after the last one is
// destroyed) all mean gone. Anything else (binary missing, socket unreadable,
// spawn failure) is NOT evidence of session death.
const SESSION_DEFINITIVELY_GONE_PATTERN =
  /no server running|error connecting|failed to connect|can't find session|session not found|no current session|no current target/i;

export function ensurePrivateDirectory(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  // mkdir's mode applies only to a directory it creates — a pre-existing
  // looser directory must be tightened explicitly or the private socket sits
  // in a group/other-traversable directory.
  chmodSync(directory, 0o700);
}

export function ensureStateDirectory() {
  ensurePrivateDirectory(STATE_DIRECTORY);
}

function run(executable, argv, { input, environment = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, argv, {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...environment },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    // A child that exits before draining stdin raises an async EPIPE on the
    // stream; without a listener it becomes an uncaughtException that kills
    // the whole bridge. The real failure still surfaces as a non-zero exit
    // code on 'close'.
    child.stdin.on("error", () => {});
    child.on("close", (exitCode) => {
      if (exitCode === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${executable} ${argv[0]} exited ${exitCode}: ${stderr.trim() || stdout.trim()}`));
      }
    });
    if (input !== undefined) child.stdin.write(input);
    child.stdin.end();
  });
}

export class Tmux {
  // The Tmux a launch runs: its socket in the launch's state directory, and
  // the launch's tmux executable and environment.
  static forLaunch({ stateDirectory, tmuxExecutable, tmuxEnvironment }) {
    return new Tmux({
      socketPath: join(stateDirectory, "tmux.sock"),
      executable: tmuxExecutable,
      environment: tmuxEnvironment,
    });
  }

  // The bridge-owned files live next to the socket, so a Tmux pointed at a
  // test socket in a temp directory never touches the real state dir.
  // `environment` is merged over the bridge's own for every tmux it runs,
  // including the one the watch script starts.
  constructor({
    socketPath = SOCKET_PATH,
    sessionName = SESSION_NAME,
    executable = defaultTmuxExecutable(),
    environment = {},
  } = {}) {
    this.socketPath = socketPath;
    this.sessionName = sessionName;
    this.executable = executable;
    this.environment = environment;
    // The private socket lives in a 0700 directory, beside the files below.
    ensurePrivateDirectory(dirname(socketPath));
    // The pane's rendered screen, saved by {Tmux#saveFinalScreen} just before
    // a close and repainted by the attach scripts after their tmux client
    // exits (which clears the terminal unconditionally).
    this.finalScreenPath = join(dirname(socketPath), "final-screen");
    // The overlay's 👀 button opens this via /usr/bin/open. Values are baked
    // in at write time.
    this.watchCommandPath = join(dirname(socketPath), "watch.command");
    replaceFile(
      this.watchCommandPath,
      watchCommandContent({
        executable,
        environment,
        socketPath,
        sessionName,
        finalScreenPath: this.finalScreenPath,
      }),
      0o700,
    );
  }

  command(argv, options) {
    return run(this.executable, [...serverArguments(this.socketPath), ...argv], {
      ...options,
      environment: this.environment,
    });
  }

  // Creates the session with `commandArgv` as the pane's DIRECT command (no
  // local login shell): the pane dies with the process, so a dead pane is the
  // SSH-liveness signal.
  async createSession(commandArgv) {
    ensurePrivateDirectory(dirname(this.socketPath));
    // A surviving final screen belongs to the PREVIOUS session: the attach
    // scripts treat the file's presence as "that attach ended in a close",
    // so it must be gone before a new session accepts watchers.
    rmSync(this.finalScreenPath, { force: true });
    await this.command([
      ...SERVER_OPTION_COMMANDS,
      "new-session",
      "-d",
      "-s",
      this.sessionName,
      "-x",
      String(PANE_WIDTH),
      "-y",
      String(PANE_HEIGHT),
      "--",
      ...commandArgv.map(escapeTrailingCommandSeparator),
    ]);
    // Unmistakable, geometry-stable bridge server (PLAN: Bridge state
    // security). history-limit is NOT set here: it only takes effect at
    // window creation, so {SERVER_OPTION_COMMANDS} sets it with new-session.
    await this.command(["set-option", "-t", this.sessionName, "status", "off"]);
    await this.command(["set-option", "-t", this.sessionName, "detach-on-destroy", "on"]);
    await this.command(["set-window-option", "-t", this.sessionName, "window-size", "manual"]);
    await this.command([
      "resize-window",
      "-t",
      this.sessionName,
      "-x",
      String(PANE_WIDTH),
      "-y",
      String(PANE_HEIGHT),
    ]);
  }

  // True/false ONLY on tmux's definitive answers ("no session" and "no
  // server" both mean the session is gone). Any other failure — tmux binary
  // missing, socket unreadable — throws: callers treat false as session
  // death, and a failed probe is not evidence of that.
  async hasSession() {
    try {
      await this.command(["has-session", "-t", this.sessionName]);
      return true;
    } catch (err) {
      if (SESSION_DEFINITIVELY_GONE_PATTERN.test(err.message ?? "")) {
        return false;
      }
      throw err;
    }
  }

  // Already gone is success for a kill — but ONLY definitively gone. Any
  // other failure rethrows: a close that cannot verify the kill must not go
  // on to report success and release the cross-bridge lock over a session
  // that may still be running.
  async killSession() {
    try {
      await this.command(["kill-session", "-t", this.sessionName]);
    } catch (err) {
      if (!SESSION_DEFINITIVELY_GONE_PATTERN.test(err.message ?? "")) throw err;
    }
  }

  // Command transport: load-buffer from stdin + bracketed paste-buffer.
  // Never send-keys for command text.
  async pasteText(text) {
    const bufferName = `airlock-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    await this.command(["load-buffer", "-b", bufferName, "-"], { input: text });
    // -d deletes the buffer after pasting; -p is bracketed paste (one atomic
    // input for Reline instead of line-by-line evaluation).
    await this.command(["paste-buffer", "-p", "-d", "-b", bufferName, "-t", this.sessionName]);
  }

  sendEnter() {
    return this.command(["send-keys", "-t", this.sessionName, "Enter"]);
  }

  // The one sanctioned send-keys for content: a real interrupt.
  sendInterrupt() {
    return this.command(["send-keys", "-t", this.sessionName, "C-c"]);
  }

  // Visible pane text, wrap-joined (-J) so prompts are matched on logical
  // lines. `fullHistory` starts the capture at the top of the scrollback.
  async capturePane({ fullHistory = false } = {}) {
    const argv = ["capture-pane", "-p", "-J", "-t", this.sessionName];
    if (fullHistory) argv.push("-S", "-");
    const { stdout } = await this.command(argv);
    // capture-pane's own trailing newline would register as a phantom line.
    return stdout.replace(/\n$/, "");
  }

  // Writes the pane's rendered screen — with its colors (-e) — beside the
  // socket for the attach scripts to repaint after the tmux client's
  // exit-time clear. Best-effort by contract: a close must never fail (or a
  // watcher-less close slow down) over a snapshot; a pane already dead has
  // no screen to save, and the scripts simply skip a missing file.
  async saveFinalScreen() {
    try {
      const { stdout } = await this.command(["capture-pane", "-p", "-e", "-t", this.sessionName]);
      replaceFile(this.finalScreenPath, stdout, 0o600);
    } catch {
      // Missing session or unwritable state directory: the repaint is a
      // nicety, never worth blocking the close over.
    }
  }

  async displayMessage(format) {
    const { stdout } = await this.command(["display-message", "-p", "-t", this.sessionName, format]);
    return stdout.replace(/\n$/, "");
  }

  async cursorAndScreenState() {
    // Comma-separated: display-message sanitizes control characters (a tab
    // separator comes back as "_", silently breaking the split).
    const raw = await this.displayMessage("#{cursor_x},#{cursor_y},#{alternate_on}");
    const [cursorX, cursorY, alternateOn] = raw.split(",");
    return {
      cursorX: Number(cursorX),
      cursorY: Number(cursorY),
      // alternate_on = pane is in the alternate screen: a pager/editor opened
      // (escape sequences pass through SSH, so this sees the REMOTE pager).
      alternateScreen: alternateOn === "1",
    };
  }
}
