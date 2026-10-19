// Airlock — smoke tests (node --test test/smoke.test.mjs). Zero-dependency:
// node:test + node:assert only. No test ever displays a real approval panel
// (AIRLOCK_APPROVE_HELPER substitutes fake helpers) and none opens a real
// SSH connection.

import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { approvalHelperProblem, requestApproval } from "../src/approval.mjs";
import { currentClaudeSessionTitle } from "../src/claude-session.mjs";
import { buildApprovalHtml, highlightRuby, escapeHtml } from "../src/colorize.mjs";
import { COMMAND_COLUMNS, CONTRACT_SPEC_TEXT } from "../src/command-contract.mjs";
import { loadConfig } from "../src/config.mjs";
import { capOutput } from "../src/output-stream.mjs";
import { explicitHostAliases } from "../src/ssh-config.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SERVER_PATH = join(REPO_ROOT, "src", "server.mjs");

const scratch = mkdtempSync(join(tmpdir(), "airlock-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

// ---- fixtures -------------------------------------------------------------

function writeFakeHelper(name, script) {
  const helperPath = join(scratch, name);
  writeFileSync(helperPath, `#!/bin/sh\n${script}\n`);
  chmodSync(helperPath, 0o755);
  return helperPath;
}

function writeSshConfig(content) {
  const sshConfigPath = join(scratch, `ssh_config_${Math.random().toString(36).slice(2)}`);
  writeFileSync(sshConfigPath, content);
  return sshConfigPath;
}

function writeBridgeConfig(overrides = {}) {
  const sshConfigPath = writeSshConfig("Host testhost\n  HostName 127.0.0.1\n");
  const config = {
    ssh_config: sshConfigPath,
    instructions: "Test instructions.",
    targets: {
      "test-shell": {
        description: "Test shell target",
        display_command: "ssh testhost",
        ssh_host: "testhost",
        driver: "shell",
      },
      "test-console": {
        description: "Test Rails console target",
        display_command: "ssh testhost\ncd app\nbin/rails console",
        ssh_host: "testhost",
        startup: ["cd app", "bin/rails console"],
        driver: "rails_irb",
      },
    },
    ...overrides,
  };
  const configPath = join(scratch, `config_${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(configPath, JSON.stringify(config));
  return configPath;
}

async function withApprovalHelper(helperPath, work) {
  const previous = process.env.AIRLOCK_APPROVE_HELPER;
  process.env.AIRLOCK_APPROVE_HELPER = helperPath;
  try {
    return await work();
  } finally {
    if (previous === undefined) delete process.env.AIRLOCK_APPROVE_HELPER;
    else process.env.AIRLOCK_APPROVE_HELPER = previous;
  }
}

// ---- approval gate --------------------------------------------------------

describe("requestApproval", () => {
  const approvalRequest = {
    command: "User.count",
    badge: "test",
    actionDescription: "Send?",
    claudeSessionName: null,
    timeoutSeconds: 5,
  };

  it("approves only on a literal parsed approve decision, relaying the message", async () => {
    const helper = writeFakeHelper(
      "approve",
      `cat > /dev/null; printf '{"decision":"approve","message":"careful"}'`,
    );
    const approval = await withApprovalHelper(helper, () => requestApproval(approvalRequest));
    assert.equal(approval.approved, true);
    assert.equal(approval.decision, "approve");
    assert.equal(approval.message, "careful");
  });

  it("treats deny as a clean non-approval with the message relayed", async () => {
    const helper = writeFakeHelper(
      "deny",
      `cat > /dev/null; printf '{"decision":"deny","message":"use a count first"}'`,
    );
    const approval = await withApprovalHelper(helper, () => requestApproval(approvalRequest));
    assert.equal(approval.approved, false);
    assert.equal(approval.decision, "deny");
    assert.equal(approval.message, "use a count first");
  });

  it("treats a literal null stdout (valid JSON, exit 0) as unparseable, not a crash", async () => {
    const helper = writeFakeHelper("null-output", `cat > /dev/null; printf 'null'`);
    const approval = await withApprovalHelper(helper, () => requestApproval(approvalRequest));
    assert.equal(approval.approved, false);
    assert.equal(approval.decision, "helper-crash");
  });

  it("treats garbage stdout as a non-approval", async () => {
    const helper = writeFakeHelper("garbage", `cat > /dev/null; printf 'not json at all'`);
    const approval = await withApprovalHelper(helper, () => requestApproval(approvalRequest));
    assert.equal(approval.approved, false);
    assert.equal(approval.decision, "helper-crash");
  });

  it("treats a helper-reported timeout as a clean non-approval", async () => {
    const helper = writeFakeHelper("timeout", `cat > /dev/null; printf '{"decision":"timeout"}'`);
    const approval = await withApprovalHelper(helper, () => requestApproval(approvalRequest));
    assert.equal(approval.approved, false);
    assert.equal(approval.decision, "timeout");
  });

  it("kills a hung helper via the backstop and returns timeout, never approve", async () => {
    // The backstop fires at (timeoutSeconds + 30)s; the negative offset
    // compresses that window to ~300ms so the test proves a helper that
    // ignores its own timeout still cannot stall the bridge or approve.
    // exec replaces the shell so the backstop's SIGKILL reaps the sleep too
    // (an orphaned sleep would hold the stdout pipe open for its full 30s).
    const helper = writeFakeHelper("hang", `cat > /dev/null; exec sleep 30`);
    const approval = await withApprovalHelper(helper, () =>
      requestApproval({ ...approvalRequest, timeoutSeconds: -29.7 }),
    );
    assert.equal(approval.approved, false);
    assert.equal(approval.decision, "timeout");
  });

  it("hands the helper {html, timeoutSeconds, title} on stdin, html carrying the command", async () => {
    const payloadPath = join(scratch, "helper-stdin-payload");
    const helper = writeFakeHelper(
      "payload-dump",
      `cat > ${payloadPath}; printf '{"decision":"deny"}'`,
    );
    await withApprovalHelper(helper, () =>
      requestApproval({ ...approvalRequest, command: "User.where(id: 42).count" }),
    );
    const { readFileSync } = await import("node:fs");
    const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
    assert.deepEqual(Object.keys(payload).sort(), ["html", "timeoutSeconds", "title"]);
    assert.equal(payload.timeoutSeconds, 5);
    assert.equal(payload.title, "Airlock — approval required"); // no session name known
    // Colorization may span-wrap each token; assert the pieces, not the join.
    assert.match(payload.html, /User/);
    assert.match(payload.html, /where/);
    assert.match(payload.html, /Deny <span class="countdown" id="countdown">5<\/span>/);
  });

  it("hands the helper the watch script path when one is provided", async () => {
    const payloadPath = join(scratch, "helper-stdin-watch");
    const helper = writeFakeHelper(
      "payload-dump-watch",
      `cat > ${payloadPath}; printf '{"decision":"deny"}'`,
    );
    await withApprovalHelper(helper, () =>
      requestApproval({ ...approvalRequest, watchCommandPath: "/fake/state/watch.command" }),
    );
    const { readFileSync } = await import("node:fs");
    const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
    assert.equal(payload.watchCommandPath, "/fake/state/watch.command");
    // The page's 👀 segment posts "watch"; the helper opens the terminal and
    // records it as an approval.
    assert.match(payload.html, /decide\("watch"\)/);
  });

  it("puts the requesting Claude session name in the overlay title and header", async () => {
    const payloadPath = join(scratch, "helper-stdin-named");
    const helper = writeFakeHelper(
      "payload-dump-named",
      `cat > ${payloadPath}; printf '{"decision":"deny"}'`,
    );
    await withApprovalHelper(helper, () =>
      requestApproval({ ...approvalRequest, claudeSessionName: "Fix PROJ-123" }),
    );
    const { readFileSync } = await import("node:fs");
    const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
    assert.equal(payload.title, "Airlock — Fix PROJ-123");
    assert.match(payload.html, /Fix PROJ-123/);
  });

  it("treats a non-zero exit as a non-approval", async () => {
    const helper = writeFakeHelper("crash", `cat > /dev/null; exit 3`);
    const approval = await withApprovalHelper(helper, () => requestApproval(approvalRequest));
    assert.equal(approval.approved, false);
    assert.equal(approval.decision, "helper-crash");
  });

  it("treats a missing helper binary as a non-approval", async () => {
    const approval = await withApprovalHelper(join(scratch, "does-not-exist"), () =>
      requestApproval(approvalRequest),
    );
    assert.equal(approval.approved, false);
    assert.equal(approval.decision, "helper-unavailable");
  });

  it("serializes overlays: one pending at a time, later calls queue", async () => {
    const markerPath = join(scratch, "serialize-marker");
    // Each helper appends start/end markers; overlap would interleave them.
    const helper = writeFakeHelper(
      "serialize",
      `cat > /dev/null; echo "start $$" >> ${markerPath}; sleep 0.3; echo "end $$" >> ${markerPath}; printf '{"decision":"deny"}'`,
    );
    await withApprovalHelper(helper, () =>
      Promise.all([requestApproval(approvalRequest), requestApproval(approvalRequest)]),
    );
    const { readFileSync } = await import("node:fs");
    const events = readFileSync(markerPath, "utf8").trim().split("\n");
    assert.equal(events.length, 4);
    assert.match(events[0], /^start /);
    assert.match(events[1], /^end /);
    assert.equal(events[0].slice(6), events[1].slice(4)); // same pid: first finished before second started
  });
});

// ---- approval helper setup -------------------------------------------------

describe("approvalHelperProblem", () => {
  const sourcePath = join(scratch, "helper-source.swift");
  writeFileSync(sourcePath, "// helper source\n");

  it("names a missing helper with the build command", () => {
    const problem = approvalHelperProblem({ helperPath: join(scratch, "no-helper-here"), sourcePath });
    assert.match(problem, /missing or not executable at .*no-helper-here/);
    assert.match(problem, /swiftc -O -o bin\/airlock-approve airlock-approve\.swift/);
  });

  it("names a helper built before its source last changed", () => {
    const helperPath = writeFakeHelper("stale-helper", "exit 0");
    utimesSync(helperPath, 0, 0);
    const problem = approvalHelperProblem({ helperPath, sourcePath });
    assert.match(problem, /stale-helper is older than .*helper-source\.swift/);
    assert.match(problem, /Rebuild it with: swiftc -O -o bin\/airlock-approve airlock-approve\.swift/);
  });

  it("passes a helper built after its source last changed", () => {
    const helperPath = writeFakeHelper("fresh-helper", "exit 0");
    const olderSourcePath = join(scratch, "older-helper-source.swift");
    writeFileSync(olderSourcePath, "// helper source\n");
    utimesSync(olderSourcePath, 0, 0);
    assert.equal(approvalHelperProblem({ helperPath, sourcePath: olderSourcePath }), null);
  });

  it("passes a helper whose source is not around to compare against", () => {
    const helperPath = writeFakeHelper("sourceless-helper", "exit 0");
    utimesSync(helperPath, 0, 0);
    assert.equal(approvalHelperProblem({ helperPath, sourcePath: join(scratch, "no-source-here") }), null);
  });
});

// ---- requesting-session title ----------------------------------------------

describe("currentClaudeSessionTitle", () => {
  function writeClaudeConfigDir({ hostSessionFile, registryFile } = {}) {
    const configDir = mkdtempSync(join(scratch, "claude-config-"));
    let hostSessionPath = null;
    if (hostSessionFile) {
      // The desktop store nests session files under opaque UUID directories.
      const storeDirectory = join(configDir, "claude-code-sessions", "org-uuid", "project-uuid");
      mkdirSync(storeDirectory, { recursive: true });
      hostSessionPath = join(storeDirectory, hostSessionFile.name);
      writeFileSync(hostSessionPath, hostSessionFile.content);
    }
    if (registryFile) {
      const registryDirectory = join(configDir, "sessions");
      mkdirSync(registryDirectory, { recursive: true });
      writeFileSync(join(registryDirectory, registryFile.name), registryFile.content);
    }
    return { configDir, hostSessionPath };
  }

  function withSessionEnv(overrides, work) {
    const keys = ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_SESSION_ID"];
    const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
    for (const key of keys) {
      if (overrides[key] === undefined) delete process.env[key];
      else process.env[key] = overrides[key];
    }
    try {
      return work();
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  }

  it("resolves the desktop app's session title from the host-session store", () => {
    const { configDir } = writeClaudeConfigDir({
      hostSessionFile: {
        name: "local_host-title.json",
        content: JSON.stringify({ title: "Fix PROJ-123", titleSource: "auto" }),
      },
    });
    withSessionEnv(
      { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_HOST_SESSION_ID: "local_host-title" },
      () => assert.equal(currentClaudeSessionTitle(), "Fix PROJ-123"),
    );
  });

  it("re-reads the title on every call so a rename shows on the next approval", () => {
    const { configDir, hostSessionPath } = writeClaudeConfigDir({
      hostSessionFile: {
        name: "local_host-rename.json",
        content: JSON.stringify({ title: "New session" }),
      },
    });
    withSessionEnv(
      { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_HOST_SESSION_ID: "local_host-rename" },
      () => {
        assert.equal(currentClaudeSessionTitle(), "New session");
        writeFileSync(hostSessionPath, JSON.stringify({ title: "Debug flaky specs" }));
        assert.equal(currentClaudeSessionTitle(), "Debug flaky specs");
      },
    );
  });

  it("falls back to the CLI registry's agent-messaging name", () => {
    const { configDir } = writeClaudeConfigDir({
      registryFile: {
        name: "12345.json",
        content: JSON.stringify({ sessionId: "cli-session-9", name: "airlock-42" }),
      },
    });
    withSessionEnv(
      { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_SESSION_ID: "cli-session-9" },
      () => assert.equal(currentClaudeSessionTitle(), "airlock-42"),
    );
  });

  it("returns null when the environment names no session", () => {
    const { configDir } = writeClaudeConfigDir();
    withSessionEnv({ CLAUDE_CONFIG_DIR: configDir }, () =>
      assert.equal(currentClaudeSessionTitle(), null),
    );
  });

  it("returns null when the identified session is missing from the stores", () => {
    const { configDir } = writeClaudeConfigDir();
    withSessionEnv(
      {
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_CODE_HOST_SESSION_ID: "local_host-absent",
        CLAUDE_CODE_SESSION_ID: "cli-session-absent",
      },
      () => assert.equal(currentClaudeSessionTitle(), null),
    );
  });

  it("returns null on a malformed store file instead of throwing", () => {
    const { configDir } = writeClaudeConfigDir({
      hostSessionFile: { name: "local_host-garbage.json", content: "not json at all" },
    });
    withSessionEnv(
      { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_HOST_SESSION_ID: "local_host-garbage" },
      () => assert.equal(currentClaudeSessionTitle(), null),
    );
  });
});

// ---- output cap -----------------------------------------------------------

describe("capOutput", () => {
  it("returns short output unchanged", () => {
    assert.equal(capOutput("one\ntwo", { maxLines: 10, maxBytes: 1000 }), "one\ntwo");
  });

  it("caps by line count with an elision marker", () => {
    const text = Array.from({ length: 100 }, (_, index) => `line ${index}`).join("\n");
    const capped = capOutput(text, { maxLines: 10, maxBytes: 100000 });
    assert.match(capped, /Airlock output cap/);
    assert.ok(capped.split("\n").length <= 11);
    assert.match(capped, /^line 0/);
    assert.match(capped, /line 99$/);
  });

  it("caps by byte count", () => {
    const text = Array.from({ length: 50 }, () => "x".repeat(100)).join("\n");
    const capped = capOutput(text, { maxLines: 1000, maxBytes: 500 });
    assert.ok(Buffer.byteLength(capped, "utf8") < 1000);
    assert.match(capped, /Airlock output cap/);
  });
});

// ---- colorize -------------------------------------------------------------

describe("highlightRuby", () => {
  it("escapes HTML and wraps tokens in colored spans, preserving newlines", async () => {
    const html = await highlightRuby('User.where(id: 42)\nputs "<script>"');
    assert.match(html, /<span style="color:#[0-9a-fA-F]{6}">User<\/span>/);
    assert.match(html, /&quot;&lt;script&gt;&quot;/);
    assert.doesNotMatch(html, /<script>/);
    assert.equal(html.split("\n").length, 2); // rows split on the raw newlines
  });

  it("escapes all reserved characters", () => {
    assert.equal(escapeHtml(`<a href="x">&`), "&lt;a href=&quot;x&quot;&gt;&amp;");
  });
});

describe("buildApprovalHtml", () => {
  // The text a reviewer reads: each row's code cell with the highlighting
  // tags stripped and the HTML escapes undone.
  function renderedCommandText(html) {
    return [...html.matchAll(/<span class="c">([\s\S]*?)<\/span><\/div>/g)]
      .map(([, cellHtml]) =>
        cellHtml
          .replace(/<[^>]+>/g, "")
          .replaceAll("&lt;", "<")
          .replaceAll("&gt;", ">")
          .replaceAll("&quot;", '"')
          .replaceAll("&amp;", "&"),
      )
      .join("\n");
  }

  const command = [
    "report = <<~TEXT",
    '  a < b && c > "d" & e',
    "",
    "  emoji 👀  two  spaces, \\ and 'quotes'",
    "TEXT",
    'puts "report: #{report}"',
  ].join("\n");

  it("shows every byte of the command, blank lines included", async () => {
    const html = await buildApprovalHtml({ command, badge: "test-shell", headerText: "Send?", timeoutSeconds: 30 });
    assert.equal(renderedCommandText(html), command);
  });

  it(`lays the page out at ${COMMAND_COLUMNS} columns with wrapping instead of a fade`, async () => {
    const html = await buildApprovalHtml({ command, badge: "test-shell", headerText: "Send?", timeoutSeconds: 30 });
    assert.doesNotMatch(html, /mask-image/);
    assert.match(html, new RegExp(`width: calc\\(2\\.5em \\+ ${COMMAND_COLUMNS}ch \\+ 66px\\); max-width: 100vw;`));
    assert.match(html, /\.ln \.c \{ white-space: pre-wrap; overflow-wrap: anywhere; min-width: 0;/);
    assert.match(html, /<span id="more-lines" hidden><\/span>/);
  });
});

// ---- ssh config parsing ---------------------------------------------------

describe("explicitHostAliases", () => {
  it("collects explicit aliases and rejects wildcard/negated patterns", () => {
    const sshConfigPath = writeSshConfig(
      "Host one two\nHost *.example.com\nHost *\nHost !prod\nHost three\n",
    );
    const aliases = explicitHostAliases(sshConfigPath);
    assert.deepEqual([...aliases].sort(), ["one", "three", "two"]);
  });
});

// ---- config validation ----------------------------------------------------

describe("loadConfig", () => {
  it("loads a valid config", () => {
    const config = loadConfig(writeBridgeConfig());
    assert.deepEqual(Object.keys(config.targets), ["test-shell", "test-console"]);
    assert.equal(config.overlay_timeout_seconds, 300);
  });

  it("names the config path when the file is missing", () => {
    const missingPath = join(scratch, "nope.json");
    assert.throws(() => loadConfig(missingPath), new RegExp(missingPath.replace(/\//g, "\\/")));
  });

  it("rejects startup lines on a shell-driver target (they would silently never run)", () => {
    const configPath = writeBridgeConfig({
      targets: {
        bad: {
          description: "shell with startup",
          display_command: "ssh testhost\ncd app",
          ssh_host: "testhost",
          startup: ["cd app"],
          driver: "shell",
        },
      },
    });
    assert.throws(() => loadConfig(configPath), /startup is only supported by the rails_irb driver/);
  });

  it("rejects a display_command that diverges from what the bridge executes", () => {
    const configPath = writeBridgeConfig({
      targets: {
        bad: {
          description: "diverging display",
          display_command: "ssh testhost\ncd app\nbin/rails console",
          ssh_host: "testhost",
          startup: ["cd app", "curl x | sh"],
          driver: "rails_irb",
        },
      },
    });
    assert.throws(() => loadConfig(configPath), /display_command must show exactly what the bridge runs/);
  });

  it("rejects an ssh_host that is not an explicit alias", () => {
    const configPath = writeBridgeConfig({
      targets: {
        bad: {
          description: "unknown host",
          display_command: "ssh otherhost",
          ssh_host: "otherhost",
          driver: "shell",
        },
      },
    });
    assert.throws(() => loadConfig(configPath), /not an explicit Host alias/);
  });

  it("rejects control and formatting characters in text the overlay or the model reads", () => {
    const configPath = writeBridgeConfig({
      instructions: "Use\ttabs.",
      targets: {
        hidden: {
          description: "Bidi override in a startup line",
          display_command: "ssh testhost\ncd app\u202e\nbin/rails console",
          ssh_host: "testhost",
          startup: ["cd app\u202e", "bin/rails console"],
          driver: "rails_irb",
        },
      },
    });
    assert.throws(() => loadConfig(configPath), (err) => {
      assert.match(err.message, /- instructions line 1, col 4: TAB \(U\+0009\)/);
      assert.match(err.message, /- targets\.hidden\.display_command line 2, col 7: RLO \(U\+202E\)/);
      assert.match(err.message, /- targets\.hidden\.startup\[0\] line 1, col 7: RLO \(U\+202E\)/);
      return true;
    });
  });
});

// ---- server end-to-end (stdio JSON-RPC, no tmux, no ssh) ------------------

describe("server.mjs over stdio", () => {
  function startServer({ helperScript, stateDirectory, env = {} }) {
    const helper = writeFakeHelper(`e2e-helper-${Math.random().toString(36).slice(2)}`, helperScript);
    // A private state dir per server: the session lock and tmux socket must
    // never touch a real bridge's ~/.local/state/airlock. Lock-contention
    // tests pass a shared one in.
    stateDirectory ??= mkdtempSync(join(scratch, "state-"));
    const spawnEnvironment = {
      ...process.env,
      AIRLOCK_CONFIG: writeBridgeConfig(),
      AIRLOCK_APPROVE_HELPER: helper,
      AIRLOCK_STATE_DIR: stateDirectory,
      ...env,
    };
    // The test process itself may be running inside a Claude session; its
    // identity must never leak into the server under test (the overlay title
    // tests would see the REAL session's on-disk title otherwise).
    for (const key of ["CLAUDE_CONFIG_DIR", "CLAUDE_CODE_HOST_SESSION_ID", "CLAUDE_CODE_SESSION_ID"]) {
      if (!(key in env)) delete spawnEnvironment[key];
    }
    const child = spawn(process.execPath, [SERVER_PATH], {
      env: spawnEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let buffer = "";
    const pending = new Map();
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (line.trim() === "") continue;
        const message = JSON.parse(line);
        const resolver = pending.get(message.id);
        if (resolver) {
          pending.delete(message.id);
          resolver(message);
        }
      }
    });
    let nextId = 1;
    function call(method, params) {
      const id = nextId++;
      const response = new Promise((resolve) => pending.set(id, resolve));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return response;
    }
    return { child, call, stateDirectory };
  }

  it("initializes, lists tools, and cleanly rejects prototype-key targets", async () => {
    const { child, call } = startServer({
      helperScript: `cat > /dev/null; printf '{"decision":"deny"}'`,
    });
    try {
      const initialized = await call("initialize", {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "test-client" },
      });
      assert.match(initialized.result.instructions, /Test instructions\./);
      assert.match(initialized.result.instructions, /test-shell/);
      // Standing guidance: relay open_terminal's attach block so the human
      // gets a one-click Run button to watch the session.
      assert.match(initialized.result.instructions, /attach block/);
      assert.ok(initialized.result.instructions.includes(CONTRACT_SPEC_TEXT));

      const toolsListed = await call("tools/list", {});
      assert.deepEqual(
        toolsListed.result.tools.map((tool) => tool.name).sort(),
        ["close_terminal", "interrupt_terminal", "list_targets", "open_terminal", "send_terminal"],
      );
      const openTool = toolsListed.result.tools.find((tool) => tool.name === "open_terminal");
      assert.deepEqual(openTool.inputSchema.properties.target.enum, ["test-shell", "test-console"]);
      assert.equal(openTool.inputSchema.additionalProperties, false);

      // Closing is a pure de-escalation and must advertise itself as ungated.
      const closeTool = toolsListed.result.tools.find((tool) => tool.name === "close_terminal");
      assert.match(closeTool.description, /No approval needed/);

      // The model reads the contract where it writes the command.
      const sendTool = toolsListed.result.tools.find((tool) => tool.name === "send_terminal");
      assert.ok(sendTool.description.endsWith(CONTRACT_SPEC_TEXT));

      for (const prototypeKey of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
        const rejected = await call("tools/call", {
          name: "open_terminal",
          arguments: { target: prototypeKey },
        });
        assert.equal(rejected.result.isError, true);
        assert.match(rejected.result.content[0].text, /^Unknown target: /);
      }

      const noSession = await call("tools/call", {
        name: "send_terminal",
        arguments: { command: "pwd" },
      });
      assert.equal(noSession.result.isError, true);
      assert.match(noSession.result.content[0].text, /No session is open/);
    } finally {
      child.kill();
    }
  });

  it("survives a helper printing literal null and returns a clean non-error result", async () => {
    const { child, call } = startServer({ helperScript: `cat > /dev/null; printf 'null'` });
    try {
      await call("initialize", { protocolVersion: "2025-06-18" });
      const notApproved = await call("tools/call", {
        name: "open_terminal",
        arguments: { target: "test-shell" },
      });
      assert.notEqual(notApproved.result.isError, true);
      assert.match(notApproved.result.content[0].text, /Not approved \(helper-crash\)/);
      // The server must still be alive and answering.
      const pinged = await call("ping", {});
      assert.deepEqual(pinged.result, {});
    } finally {
      child.kill();
    }
  });

  it("serves list_targets ungated (helper denies everything) with live state", async () => {
    const { child, call } = startServer({
      helperScript: `cat > /dev/null; printf '{"decision":"deny"}'`,
    });
    try {
      await call("initialize", { protocolVersion: "2025-06-18" });
      const listed = await call("tools/call", { name: "list_targets", arguments: {} });
      assert.notEqual(listed.result.isError, true);
      const inventory = JSON.parse(listed.result.content[0].text);
      assert.equal(inventory.active_session, null);
      assert.deepEqual(
        inventory.targets.map((target) => target.target),
        ["test-shell", "test-console"],
      );
      assert.equal(inventory.targets[0].display_command, "ssh testhost");
    } finally {
      child.kill();
    }
  });

  it("passes clientInfo through initialize into the overlay title", async () => {
    const payloadPath = join(scratch, `e2e-payload-${Math.random().toString(36).slice(2)}`);
    const { child, call } = startServer({
      helperScript: `cat > ${payloadPath}; printf '{"decision":"deny"}'`,
    });
    try {
      await call("initialize", {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "claude-code", title: "Debug PROJ-99" },
      });
      await call("tools/call", { name: "open_terminal", arguments: { target: "test-shell" } });
      const { readFileSync } = await import("node:fs");
      const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
      assert.equal(payload.title, "Airlock — Debug PROJ-99");
      assert.match(payload.html, /Debug PROJ-99/);
      // The resolved display_command (colorized: tokens may be span-wrapped).
      assert.match(payload.html, /ssh/);
      assert.match(payload.html, /testhost/);
    } finally {
      child.kill();
    }
  });

  it("names the overlay from the on-disk session title, out-ranking clientInfo", async () => {
    // The store layout Claude Code's desktop app actually writes; the ids
    // reach the bridge through the environment it is spawned with.
    const configDir = mkdtempSync(join(scratch, "e2e-claude-config-"));
    const storeDirectory = join(configDir, "claude-code-sessions", "org-uuid", "project-uuid");
    mkdirSync(storeDirectory, { recursive: true });
    writeFileSync(
      join(storeDirectory, "local_e2e-host.json"),
      JSON.stringify({ title: "Investigate PROJ-500", titleSource: "auto" }),
    );
    const payloadPath = join(scratch, `e2e-title-payload-${Math.random().toString(36).slice(2)}`);
    const { child, call } = startServer({
      helperScript: `cat > ${payloadPath}; printf '{"decision":"deny"}'`,
      env: { CLAUDE_CONFIG_DIR: configDir, CLAUDE_CODE_HOST_SESSION_ID: "local_e2e-host" },
    });
    try {
      // The constant product clientInfo Claude Code really sends must never
      // reach the header when the real session title is on disk.
      await call("initialize", {
        protocolVersion: "2025-06-18",
        clientInfo: { name: "claude-ai", version: "0.1.0" },
      });
      await call("tools/call", { name: "open_terminal", arguments: { target: "test-shell" } });
      const payload = JSON.parse(readFileSync(payloadPath, "utf8"));
      assert.equal(payload.title, "Airlock — Investigate PROJ-500");
      assert.match(payload.html, /Investigate PROJ-500/);
      assert.doesNotMatch(payload.html, /claude-ai/);
    } finally {
      child.kill();
    }
  });

  it("answers unknown methods (including server/discover) with -32601 and drops notifications", async () => {
    const { child, call } = startServer({
      helperScript: `cat > /dev/null; printf '{"decision":"deny"}'`,
    });
    try {
      await call("initialize", { protocolVersion: "2025-06-18" });
      const discovered = await call("server/discover", {});
      assert.equal(discovered.error.code, -32601);
      // A notification (no id) must never get a response; prove liveness after.
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/cancelled" })}\n`);
      const pinged = await call("ping", {});
      assert.deepEqual(pinged.result, {});
    } finally {
      child.kill();
    }
  });

  it("relays deny feedback verbatim as a non-error result", async () => {
    const { child, call } = startServer({
      helperScript: `cat > /dev/null; printf '{"decision":"deny","message":"use a count first, then resend"}'`,
    });
    try {
      await call("initialize", { protocolVersion: "2025-06-18" });
      const denied = await call("tools/call", {
        name: "open_terminal",
        arguments: { target: "test-shell" },
      });
      assert.notEqual(denied.result.isError, true);
      assert.match(denied.result.content[0].text, /Not approved \(deny\)/);
      assert.match(denied.result.content[0].text, /use a count first, then resend/);
    } finally {
      child.kill();
    }
  });

  it("warns about a stale approval helper when the open is denied", async () => {
    const staleHelper = writeFakeHelper("e2e-stale-helper", `cat > /dev/null; printf '{"decision":"deny"}'`);
    utimesSync(staleHelper, 0, 0);
    const stale = startServer({ helperScript: "", env: { AIRLOCK_APPROVE_HELPER: staleHelper } });
    const fresh = startServer({ helperScript: `cat > /dev/null; printf '{"decision":"deny"}'` });
    try {
      const openArguments = { name: "open_terminal", arguments: { target: "test-shell" } };
      await stale.call("initialize", { protocolVersion: "2025-06-18" });
      const staleResult = await stale.call("tools/call", openArguments);
      assert.match(staleResult.result.content[0].text, /Not approved \(deny\)/);
      assert.match(staleResult.result.content[0].text, /\n\nSetup warning: approval helper at .*e2e-stale-helper is older than/);
      await fresh.call("initialize", { protocolVersion: "2025-06-18" });
      const freshResult = await fresh.call("tools/call", openArguments);
      assert.doesNotMatch(freshResult.result.content[0].text, /Setup warning/);
    } finally {
      stale.child.kill();
      fresh.child.kill();
    }
  });

  it("warns about a stale approval helper when the open is approved", async () => {
    // A script target wrapping a local bash stands in for a remote shell.
    const localShellPath = writeFakeHelper(
      `local-shell-${Math.random().toString(36).slice(2)}`,
      "exec /usr/bin/env LANG=en_US.UTF-8 /bin/bash --norc --noprofile",
    );
    const configPath = writeBridgeConfig({
      targets: {
        "local-shell": {
          description: "Local bash standing in for a remote shell",
          display_command: localShellPath,
          transport: "script",
          script: localShellPath,
          driver: "shell",
        },
      },
    });
    const staleHelper = writeFakeHelper(
      "e2e-stale-approving-helper",
      `cat > /dev/null; printf '{"decision":"approve"}'`,
    );
    utimesSync(staleHelper, 0, 0);
    const { child, call, stateDirectory } = startServer({
      helperScript: "",
      env: { AIRLOCK_CONFIG: configPath, AIRLOCK_APPROVE_HELPER: staleHelper },
    });
    try {
      await call("initialize", { protocolVersion: "2025-06-18" });
      const opened = await call("tools/call", { name: "open_terminal", arguments: { target: "local-shell" } });
      assert.notEqual(opened.result.isError, true, opened.result.content[0].text);
      assert.match(
        opened.result.content[0].text,
        /\n\nSetup warning: approval helper at .*e2e-stale-approving-helper is older than/,
      );
      await call("tools/call", { name: "close_terminal", arguments: {} });
    } finally {
      spawnSync(tmuxBinaryForTests(), ["-S", join(stateDirectory, "tmux.sock"), "kill-server"]);
      child.kill();
    }
  });

  it("starts a bridge in EVERY Claude session: two servers share one state dir", async () => {
    // Regression: the lock used to be taken at startup, so only the first
    // session's bridge connected and every other session saw "airlock
    // unavailable". Discovery must now work in all of them concurrently.
    const denyHelper = `cat > /dev/null; printf '{"decision":"deny"}'`;
    const first = startServer({ helperScript: denyHelper });
    const second = startServer({ helperScript: denyHelper, stateDirectory: first.stateDirectory });
    try {
      for (const server of [first, second]) {
        const initialized = await server.call("initialize", { protocolVersion: "2025-06-18" });
        assert.match(initialized.result.instructions, /Test instructions\./);
        const toolsListed = await server.call("tools/list", {});
        assert.equal(toolsListed.result.tools.length, 5);
      }
    } finally {
      first.child.kill();
      second.child.kill();
    }
  });

  // The session lock is a kernel flock: a fake holder must be a REAL process
  // holding it (file content alone proves nothing to the kernel).
  function spawnLockHolder(lockFile) {
    const holder = spawn(
      process.execPath,
      [
        "-e",
        `const { openSync, writeSync, constants } = require("node:fs");
         const fd = openSync(${JSON.stringify(lockFile)},
           constants.O_RDWR | constants.O_CREAT | 0x20 | constants.O_NONBLOCK, 0o600);
         writeSync(fd, String(process.pid));
         console.log("locked");
         setInterval(() => {}, 1e6);`,
      ],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    const locked = new Promise((resolve, reject) => {
      holder.stdout.once("data", () => resolve(holder));
      holder.once("exit", (code) => reject(new Error(`lock holder exited ${code} before locking`)));
    });
    return locked;
  }

  // Exit 0 when the flock is free (acquire + release), 7 when held.
  function probeLockIsFree(lockFile) {
    const probe = spawnSync(process.execPath, [
      "-e",
      `const { openSync, constants } = require("node:fs");
       try {
         openSync(${JSON.stringify(lockFile)},
           constants.O_RDWR | constants.O_CREAT | 0x20 | constants.O_NONBLOCK, 0o600);
       } catch (err) {
         process.exit(err.code === "EAGAIN" || err.code === "EWOULDBLOCK" ? 7 : 1);
       }`,
    ]);
    return probe.status === 0;
  }

  it("refuses open while another session holds the lock — before the overlay pops", async () => {
    const overlayMarker = join(scratch, `e2e-overlay-marker-${Math.random().toString(36).slice(2)}`);
    const { child, call, stateDirectory } = startServer({
      // An approving helper that records that it ran: the conflict must come
      // back WITHOUT ever popping the panel.
      helperScript: `touch ${overlayMarker}; cat > /dev/null; printf '{"decision":"approve"}'`,
    });
    const holder = await spawnLockHolder(join(stateDirectory, "airlock.lock"));
    try {
      await call("initialize", { protocolVersion: "2025-06-18" });
      const refused = await call("tools/call", {
        name: "open_terminal",
        arguments: { target: "test-shell" },
      });
      assert.equal(refused.result.isError, true);
      assert.match(refused.result.content[0].text, /Another Claude session's Airlock/);
      assert.ok(!existsSync(overlayMarker), "the approval overlay must not have popped");

      // list_targets names the cross-session holder once its state is readable.
      writeFileSync(
        join(stateDirectory, "session.json"),
        JSON.stringify({ target: "test-shell", pid: holder.pid, opened_at: "2026-08-23T00:00:00Z" }),
      );
      const listed = await call("tools/call", { name: "list_targets", arguments: {} });
      const inventory = JSON.parse(listed.result.content[0].text);
      assert.deepEqual(inventory.held_by_another_claude_session, {
        target: "test-shell",
        opened_at: "2026-08-23T00:00:00Z",
      });
    } finally {
      holder.kill("SIGKILL");
      child.kill();
    }
  });

  it("releases the session lock when the human denies the open", async () => {
    const { child, call, stateDirectory } = startServer({
      helperScript: `cat > /dev/null; printf '{"decision":"deny"}'`,
    });
    try {
      await call("initialize", { protocolVersion: "2025-06-18" });
      const denied = await call("tools/call", {
        name: "open_terminal",
        arguments: { target: "test-shell" },
      });
      assert.notEqual(denied.result.isError, true);
      assert.match(denied.result.content[0].text, /Not approved \(deny\)/);
      // The lock taken for the approval window must be free again: a denied
      // open must never wedge the airlock for every other session.
      assert.ok(probeLockIsFree(join(stateDirectory, "airlock.lock")));
    } finally {
      child.kill();
    }
  });

  function tmuxBinaryForTests() {
    return ["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux"].find(existsSync) ?? "tmux";
  }

  it("refuses open over a leftover tmux session — before the overlay pops", async () => {
    const overlayMarker = join(scratch, `e2e-leftover-marker-${Math.random().toString(36).slice(2)}`);
    const { child, call, stateDirectory } = startServer({
      // An approving helper that records that it ran: the refusal must come
      // back WITHOUT ever popping the panel (the human must never approve an
      // open that is already doomed).
      helperScript: `touch ${overlayMarker}; cat > /dev/null; printf '{"decision":"approve"}'`,
    });
    const socketPath = join(stateDirectory, "tmux.sock");
    // A real leftover: a live session named airlock on this bridge's socket.
    const created = spawnSync(tmuxBinaryForTests(), [
      "-S", socketPath, "new-session", "-d", "-s", "airlock", "--", "sleep", "60",
    ]);
    assert.equal(created.status, 0, String(created.stderr));
    try {
      await call("initialize", { protocolVersion: "2025-06-18" });
      const refused = await call("tools/call", {
        name: "open_terminal",
        arguments: { target: "test-shell" },
      });
      assert.equal(refused.result.isError, true);
      assert.match(refused.result.content[0].text, /left by an earlier Airlock bridge/);
      assert.match(refused.result.content[0].text, /bin\/airlock-attach/);
      assert.ok(!existsSync(overlayMarker), "the approval overlay must not have popped");
    } finally {
      spawnSync(tmuxBinaryForTests(), ["-S", socketPath, "kill-server"]);
      child.kill();
    }
  });

  it("rejects a command that breaks the contract before the overlay pops", async () => {
    const overlayLog = join(scratch, `e2e-contract-overlays-${Math.random().toString(36).slice(2)}`);
    // A script target wrapping a local bash stands in for a remote shell.
    const localShellPath = writeFakeHelper(
      `local-shell-${Math.random().toString(36).slice(2)}`,
      "exec /usr/bin/env LANG=en_US.UTF-8 /bin/bash --norc --noprofile",
    );
    const configPath = writeBridgeConfig({
      targets: {
        "local-shell": {
          description: "Local bash standing in for a remote shell",
          display_command: localShellPath,
          transport: "script",
          script: localShellPath,
          driver: "shell",
        },
      },
    });
    const { child, call, stateDirectory } = startServer({
      // Approves everything and logs one line per panel shown.
      helperScript: `echo shown >> ${overlayLog}; cat > /dev/null; printf '{"decision":"approve"}'`,
      env: { AIRLOCK_CONFIG: configPath },
    });
    const overlayCount = () => (existsSync(overlayLog) ? readFileSync(overlayLog, "utf8").split("\n").length - 1 : 0);
    try {
      await call("initialize", { protocolVersion: "2025-06-18" });
      const opened = await call("tools/call", { name: "open_terminal", arguments: { target: "local-shell" } });
      assert.notEqual(opened.result.isError, true, opened.result.content[0].text);
      assert.equal(overlayCount(), 1);

      const wideCommand = `echo ${"a".repeat(115)}`;
      assert.equal(wideCommand.length, 120);
      const rejected = await call("tools/call", { name: "send_terminal", arguments: { command: wideCommand } });
      assert.equal(rejected.result.isError, true);
      assert.match(rejected.result.content[0].text, /^send_terminal rejected before approval/);
      assert.match(rejected.result.content[0].text, /line 1, col 81: \[width\] 120 columns; the limit is 80/);
      assert.equal(overlayCount(), 1, "the approval overlay must not have popped");

      const sent = await call("tools/call", { name: "send_terminal", arguments: { command: "echo hello\n" } });
      assert.notEqual(sent.result.isError, true, sent.result.content[0].text);
      assert.match(sent.result.content[0].text, /hello/);
      assert.equal(overlayCount(), 2);

      await call("tools/call", { name: "close_terminal", arguments: {} });
    } finally {
      spawnSync(tmuxBinaryForTests(), ["-S", join(stateDirectory, "tmux.sock"), "kill-server"]);
      child.kill();
    }
  });

  it("takes an in-flight approval panel down with the bridge when the bridge exits", async () => {
    const helperPidPath = join(scratch, `e2e-helper-pid-${Math.random().toString(36).slice(2)}`);
    const { child, call } = startServer({
      // Records its pid, then hangs; exec replaces the shell so the recorded
      // pid stays the process the bridge must kill.
      helperScript: `echo $$ > ${helperPidPath}; cat > /dev/null; exec sleep 300`,
    });
    try {
      await call("initialize", { protocolVersion: "2025-06-18" });
      // Fire-and-forget: this call's response never arrives — the helper
      // hangs and the bridge exits first.
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: 999,
          method: "tools/call",
          params: { name: "open_terminal", arguments: { target: "test-shell" } },
        })}\n`,
      );
      const spawnDeadline = Date.now() + 5000;
      while (!existsSync(helperPidPath) && Date.now() < spawnDeadline) await sleep(20);
      const helperPid = Number(readFileSync(helperPidPath, "utf8").trim());
      assert.ok(Number.isInteger(helperPid) && helperPid > 0, "helper never spawned");
      // The Claude session ends: the bridge exits on stdin close, and its
      // exit handler must take the orphaned panel down with it.
      child.stdin.end();
      await new Promise((resolve) => child.once("exit", resolve));
      const killDeadline = Date.now() + 3000;
      for (;;) {
        try {
          process.kill(helperPid, 0);
        } catch (err) {
          assert.equal(err.code, "ESRCH");
          break; // the helper is gone
        }
        assert.ok(Date.now() < killDeadline, `helper ${helperPid} outlived the bridge`);
        await sleep(50);
      }
    } finally {
      child.kill();
    }
  });
});
