// Airlock — PTY integration tests (node --test): a REAL tmux server on a
// private socket in a temp directory, driving a LOCAL /bin/bash and a local
// IRB (mise shims ruby) through the full SessionManager + driver stack.
// The launch seam injects the local command in place of `ssh <alias>`;
// nothing here opens an SSH connection or displays an approval panel.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { SessionManager } from "../src/session-manager.mjs";
import { PaneStateError } from "../src/output-stream.mjs";
import { Tmux } from "../src/tmux.mjs";

const IRB_EXECUTABLE = join(homedir(), ".local/share/mise/shims/irb");

// The test runner's environment may lack LANG/LC_*; in a C locale, bash 3.2
// readline treats UTF-8 bytes as meta-key commands and scrambles pasted
// lines. Real SSH targets have a configured locale — pin one here too.
const LOCAL_BASH_ARGV = [
  "/usr/bin/env",
  "LANG=en_US.UTF-8",
  "/bin/bash",
  "--norc",
  "--noprofile",
];

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function buildHarness({ targets, launchArgv, timeouts = {} }) {
  // Temp socket dir: short path (macOS ~104-byte socket cap) and never the
  // real ~/.local/state/airlock.
  const stateDirectory = mkdtempSync(join(tmpdir(), "airlock-int-"));
  const tmux = new Tmux({
    socketPath: join(stateDirectory, "tmux.sock"),
    sessionName: `airlock-test-${process.pid}`,
  });
  const config = {
    sshConfigPath: "/dev/null",
    instructions: "integration",
    targets,
    overlay_timeout_seconds: 5,
    open_timeout_seconds: 30,
    command_timeout_seconds: 15,
    output_max_lines: 400,
    output_max_bytes: 65536,
    ...timeouts,
  };
  const sessionManager = new SessionManager({
    config,
    tmux,
    stateDirectory,
    buildLaunchArgv: () => launchArgv,
  });
  const cleanup = async () => {
    await tmux.killSession();
    rmSync(stateDirectory, { recursive: true, force: true });
  };
  return { sessionManager, tmux, cleanup };
}

describe("shell driver against a local bash", () => {
  const { sessionManager, tmux, cleanup } = buildHarness({
    targets: {
      "local-shell": {
        description: "Local bash standing in for a remote shell",
        display_command: "ssh local",
        ssh_host: "local",
        driver: "shell",
      },
    },
    launchArgv: LOCAL_BASH_ARGV,
  });
  after(cleanup);

  it("opens, detects the prompt, and leaks no transport details", async () => {
    const report = await sessionManager.open("local-shell");
    assert.match(report, /^Opened local-shell\. Remote shell ready \(detected prompt:/);
    assert.doesNotMatch(report, /tmux|\.sock/);
    // The one sanctioned transport reference: the attach-client path, fenced
    // so the app renders a one-click Run button for the human.
    assert.match(report, /```bash\n\/.*\/bin\/airlock-attach\n```/);
    assert.equal(sessionManager.activeTargetKey, "local-shell");
  });

  it("runs a single-line command and returns exactly its output (echo absent)", async () => {
    const output = await sessionManager.send("echo hello-airlock");
    assert.equal(output, "hello-airlock");
  });

  it("preserves quotes and metacharacters", async () => {
    const output = await sessionManager.send(`echo "a'b\\"c \\$HOME * | ; unicode: ünï"`);
    assert.equal(output, `a'b"c $HOME * | ; unicode: ünï`);
  });

  it("carries a heredoc across continuation prompts, keeping interior blank lines", async () => {
    const output = await sessionManager.send("cat <<EOF\nfirst\n\nthird\nEOF");
    assert.equal(output, "first\n\nthird");
  });

  it("keeps shell state across separate sends (cd, then pwd)", async () => {
    await sessionManager.send("cd /private/tmp");
    assert.equal(await sessionManager.send("pwd"), "/private/tmp");
  });

  it("runs a several-seconds command by real completion detection, not a guess", async () => {
    const startedAt = Date.now();
    const output = await sessionManager.send("sleep 2 && echo done-sleeping");
    const elapsedMs = Date.now() - startedAt;
    assert.equal(output, "done-sleeping");
    assert.ok(elapsedMs >= 2000, `returned before the command finished (${elapsedMs}ms)`);
    assert.ok(elapsedMs < 6000, `took far longer than completion (${elapsedMs}ms)`);
  });

  it("fails fast on an incomplete command, refuses sends mid-continuation, and recovers via Ctrl-C", async () => {
    await assert.rejects(
      sessionManager.send('echo "unterminated'),
      (err) => err instanceof PaneStateError && /command is incomplete/.test(err.message),
    );
    // The pane is at PS2: a further send must refuse, not type into it.
    await assert.rejects(
      sessionManager.send("echo should-not-run"),
      /not at a recognized command prompt/,
    );
    const interruptReport = await sessionManager.interrupt();
    assert.match(interruptReport, /Sent Ctrl-C\. The remote prompt is ready again\./);
    assert.equal(await sessionManager.send("echo recovered"), "recovered");
  });

  it("interrupts a sleeping command; the in-flight send returns", async () => {
    const pendingSend = sessionManager.send("sleep 30");
    await sleep(800); // let the line reach the shell
    const interruptReport = await sessionManager.interrupt();
    assert.match(interruptReport, /in-flight command's call will return/);
    await pendingSend; // must settle promptly instead of running 30s
    assert.equal(await sessionManager.send("echo alive"), "alive");
  });

  it("closes cleanly: tmux session gone, further sends rejected", async () => {
    const report = await sessionManager.close();
    assert.match(report, /^Closed local-shell\./);
    assert.equal(await tmux.hasSession(), false);
    await assert.rejects(sessionManager.send("echo nope"), /No session is open/);
  });
});

describe("rails_irb driver against a local IRB", () => {
  const { sessionManager, tmux, cleanup } = buildHarness({
    targets: {
      "local-irb": {
        description: "Local IRB standing in for a remote Rails console",
        display_command: "ssh local",
        ssh_host: "local",
        driver: "rails_irb",
        // The startup path a real console target takes (cd … then the
        // console command), against a local bash: prelude line + IRB line.
        startup: ["cd /private/tmp", `${IRB_EXECUTABLE} --noautocomplete`],
      },
    },
    launchArgv: LOCAL_BASH_ARGV,
    timeouts: { command_timeout_seconds: 6 },
  });
  after(cleanup);

  it("opens through the startup sequence to a learned IRB prompt, pager disabled", async () => {
    const report = await sessionManager.open("local-irb");
    assert.match(
      report,
      /^Opened local-irb\. Rails console ready \(detected prompt: "irb\(main\):\d+> ?"; pager disabled via IRB\.conf/,
    );
    assert.doesNotMatch(report, /tmux|\.sock/);
    assert.match(report, /```bash\n\/.*\/bin\/airlock-attach\n```/);
  });

  it("evaluates a single-line expression through the paste-buffer path", async () => {
    assert.equal(await sessionManager.send("1 + 2"), "=> 3");
  });

  it("evaluates a multiline definition as one bracketed paste, echo stripped", async () => {
    const output = await sessionManager.send(
      "def airlock_add(first_number, second_number)\n  first_number + second_number\nend",
    );
    assert.equal(output, "=> :airlock_add");
  });

  it("keeps locals and definitions across separate sends", async () => {
    assert.equal(await sessionManager.send("x = 7"), "=> 7");
    assert.equal(await sessionManager.send("airlock_add(x, 35)"), "=> 42");
  });

  it("returns back-to-back results without misattribution (completion race)", async () => {
    assert.equal(await sessionManager.send("10"), "=> 10");
    assert.equal(await sessionManager.send("20"), "=> 20");
    assert.equal(await sessionManager.send("30"), "=> 30");
  });

  it("captures a runtime exception's message and backtrace", async () => {
    const output = await sessionManager.send('raise "testing-airlock"');
    assert.match(output, /testing-airlock \(RuntimeError\)/);
  });

  it("returns multi-line output uncorrupted", async () => {
    const output = await sessionManager.send('3.times { |n| puts "row #{n}" }');
    assert.equal(output, "row 0\nrow 1\nrow 2\n=> 3");
  });

  it("preserves the session on a continuation deadlock and recovers via Ctrl-C", async () => {
    await assert.rejects(
      sessionManager.send("[1, 2,"),
      (err) => err instanceof PaneStateError && /continuation prompt/.test(err.message),
    );
    const interruptReport = await sessionManager.interrupt();
    assert.match(interruptReport, /ready again/);
    assert.equal(await sessionManager.send("5 + 5"), "=> 10");
  });

  it("interrupts a sleeping evaluation; the in-flight send returns", async () => {
    const pendingSend = sessionManager.send("sleep 30");
    await sleep(800);
    const interruptReport = await sessionManager.interrupt();
    assert.match(interruptReport, /in-flight command's call will return/);
    await pendingSend;
    assert.equal(await sessionManager.send("6 * 7"), "=> 42");
  });

  it("closes cleanly out of IRB and the shell", async () => {
    const report = await sessionManager.close();
    assert.match(report, /^Closed local-irb\./);
    assert.equal(await tmux.hasSession(), false);
  });
});

// The 2026-08-23 staging incident: acme's .irbrc renders
// `acme(staging):main>` — no `irb(main)`, no input counter — and the
// driver's hardcoded stock pattern never matched, hanging open_terminal
// until the open timeout. This harness reproduces that prompt shape locally.
describe("rails_irb driver against a custom-prompt IRB (the acme-staging shape)", () => {
  const scratchDirectory = mkdtempSync(join(tmpdir(), "airlock-irbrc-"));
  const customIrbrcPath = join(scratchDirectory, "irbrc.rb");
  writeFileSync(
    customIrbrcPath,
    [
      "IRB.conf[:PROMPT][:AIRLOCK_TEST] = {",
      '  PROMPT_I: "testapp(staging):main> ",',
      '  PROMPT_S: "testapp(staging):main%l ",',
      '  PROMPT_C: "testapp(staging):main* ",',
      '  RETURN: "=> %s\\n"',
      "}",
      "IRB.conf[:PROMPT_MODE] = :AIRLOCK_TEST",
      "",
    ].join("\n"),
  );
  const { sessionManager, tmux, cleanup } = buildHarness({
    targets: {
      "local-irb-custom": {
        description: "Local IRB with a acme-style custom prompt",
        display_command: "ssh local",
        ssh_host: "local",
        driver: "rails_irb",
        startup: [
          "cd /private/tmp",
          `IRBRC=${customIrbrcPath} ${IRB_EXECUTABLE} --noautocomplete`,
        ],
      },
    },
    launchArgv: LOCAL_BASH_ARGV,
    timeouts: { command_timeout_seconds: 6 },
  });
  after(async () => {
    await cleanup();
    rmSync(scratchDirectory, { recursive: true, force: true });
  });

  it("opens by learning the custom prompt instead of assuming the stock shape", async () => {
    const report = await sessionManager.open("local-irb-custom");
    assert.match(
      report,
      /^Opened local-irb-custom\. Rails console ready \(detected prompt: "testapp\(staging\):main> ?"; pager disabled/,
    );
  });

  it("returns back-to-back results without misattribution despite no counter", async () => {
    assert.equal(await sessionManager.send("10"), "=> 10");
    assert.equal(await sessionManager.send("20"), "=> 20");
    assert.equal(await sessionManager.send("30"), "=> 30");
  });

  it("evaluates a multiline definition, echo stripped by the learned patterns", async () => {
    const output = await sessionManager.send(
      "def airlock_custom_add(first_number, second_number)\n  first_number + second_number\nend",
    );
    assert.equal(output, "=> :airlock_custom_add");
    assert.equal(await sessionManager.send("airlock_custom_add(40, 2)"), "=> 42");
  });

  it("recovers from a continuation deadlock via Ctrl-C", async () => {
    await assert.rejects(
      sessionManager.send("[1, 2,"),
      (err) => err instanceof PaneStateError && /continuation prompt/.test(err.message),
    );
    const interruptReport = await sessionManager.interrupt();
    assert.match(interruptReport, /ready again/);
    assert.equal(await sessionManager.send("5 + 5"), "=> 10");
  });

  it("closes cleanly out of IRB and the shell", async () => {
    const report = await sessionManager.close();
    assert.match(report, /^Closed local-irb-custom\./);
    assert.equal(await tmux.hasSession(), false);
  });
});

// The staging hosts' PS1 renders `ACME-STAGING (web) ~$` — no user@host,
// no colon — which used to fall back to a literal anchor, so the first `cd`
// changed the prompt and wedged every later command. This harness reproduces
// that PS1 shape against a local bash.
describe("shell driver against a custom-PS1 bash (the acme-staging shape)", () => {
  const scratchDirectory = mkdtempSync(join(tmpdir(), "airlock-ps1-"));
  const rcfilePath = join(scratchDirectory, "bashrc");
  writeFileSync(rcfilePath, "PS1='TESTHOST (web) \\w$ '\n");
  const { sessionManager, tmux, cleanup } = buildHarness({
    targets: {
      "local-shell-custom": {
        description: "Local bash with a acme-style PS1",
        display_command: "ssh local",
        ssh_host: "local",
        driver: "shell",
      },
    },
    launchArgv: [
      "/usr/bin/env",
      "LANG=en_US.UTF-8",
      "/bin/bash",
      "--noprofile",
      "--rcfile",
      rcfilePath,
    ],
  });
  after(async () => {
    await cleanup();
    rmSync(scratchDirectory, { recursive: true, force: true });
  });

  it("opens and anchors the prompt around a free cwd segment", async () => {
    const report = await sessionManager.open("local-shell-custom");
    assert.match(report, /detected prompt: "TESTHOST \(web\) .*\$ ?"/);
  });

  it("keeps matching after cd changes the rendered cwd", async () => {
    await sessionManager.send("cd /private/tmp");
    assert.equal(await sessionManager.send("pwd"), "/private/tmp");
    assert.equal(await sessionManager.send("echo after-cd"), "after-cd");
  });

  it("closes cleanly", async () => {
    const report = await sessionManager.close();
    assert.match(report, /^Closed local-shell-custom\./);
    assert.equal(await tmux.hasSession(), false);
  });
});
