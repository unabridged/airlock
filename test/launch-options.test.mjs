// Airlock — launch option tests (node --test). Zero-dependency: node:test +
// node:assert only.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { INSTALL_ROOT, parseLaunchOptions, USAGE_TEXT, UsageError } from "../src/launch-options.mjs";
import { defaultTmuxExecutable, Tmux } from "../src/tmux.mjs";

const scratch = mkdtempSync(join(tmpdir(), "airlock-launch-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

const INSTALL_ROOT_FIXTURE = "/opt/airlock-fixture";
const PRODUCTION_STATE_DIRECTORY = join(scratch, "home", ".local", "state", "airlock");
mkdirSync(PRODUCTION_STATE_DIRECTORY, { recursive: true });

function parseFixture(argv, environment = {}) {
  return parseLaunchOptions(argv, {
    environment,
    installRoot: INSTALL_ROOT_FIXTURE,
    productionStateDirectory: PRODUCTION_STATE_DIRECTORY,
  });
}

function assertUsageError(work, messagePattern) {
  assert.throws(work, (err) => {
    assert.ok(err instanceof UsageError, `expected a UsageError, got ${err}`);
    assert.match(err.message, messagePattern);
    return true;
  });
}

describe("parseLaunchOptions — production", () => {
  it("takes every path from the install root and the production state directory", () => {
    const launchOptions = parseFixture([]);
    assert.deepEqual(launchOptions, {
      dev: false,
      installRoot: INSTALL_ROOT_FIXTURE,
      configPath: "/opt/airlock-fixture/config.json",
      stateDirectory: PRODUCTION_STATE_DIRECTORY,
      approvalHelperPath: "/opt/airlock-fixture/bin/airlock-approve",
      tmuxExecutable: "/opt/airlock-fixture/runtime/bin/tmux",
      tmuxEnvironment: { TERMINFO: "/usr/share/terminfo" },
      attachCommandLine: "/opt/airlock-fixture/bin/airlock-attach",
    });
    assert.ok(Object.isFrozen(launchOptions));
    assert.ok(Object.isFrozen(launchOptions.tmuxEnvironment));
  });

  it("defaults the install root to the real path of the directory containing src/", () => {
    const checkoutRoot = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
    assert.equal(INSTALL_ROOT, checkoutRoot);
    assert.equal(parseLaunchOptions([], { environment: {} }).installRoot, checkoutRoot);
  });

  it("defaults the state directory to the one under the user's home", () => {
    const launchOptions = parseLaunchOptions([], { environment: {} });
    assert.equal(launchOptions.stateDirectory, join(homedir(), ".local", "state", "airlock"));
  });

  for (const option of ["--config", "--state-dir", "--approval-helper"]) {
    it(`rejects ${option} without --dev`, () => {
      assertUsageError(() => parseFixture([option, "/tmp/anything"]), new RegExp(`^${option} requires --dev$`));
    });
  }
});

describe("parseLaunchOptions — development", () => {
  it("requires --config", () => {
    assertUsageError(() => parseFixture(["--dev", "--state-dir", "/tmp/state"]), /^--dev requires --config <path>$/);
  });

  it("requires --state-dir", () => {
    assertUsageError(() => parseFixture(["--dev", "--config", "/tmp/config.json"]), /^--dev requires --state-dir <path>$/);
  });

  it("rejects an empty path", () => {
    assertUsageError(
      () => parseFixture(["--dev", "--config", "", "--state-dir", "/tmp/state"]),
      /^--config requires a path$/,
    );
  });

  it("uses absolute paths as given, with the checkout's helper and the Homebrew tmux", () => {
    const launchOptions = parseFixture(["--dev", "--config", "/tmp/dev/config.json", "--state-dir", "/tmp/dev/state"]);
    assert.deepEqual(launchOptions, {
      dev: true,
      installRoot: INSTALL_ROOT_FIXTURE,
      configPath: "/tmp/dev/config.json",
      stateDirectory: "/tmp/dev/state",
      approvalHelperPath: "/opt/airlock-fixture/bin/airlock-approve",
      tmuxExecutable: defaultTmuxExecutable(),
      tmuxEnvironment: {},
      attachCommandLine: "/opt/airlock-fixture/bin/airlock-attach --state-dir /tmp/dev/state",
    });
    assert.ok(Object.isFrozen(launchOptions));
    assert.ok(Object.isFrozen(launchOptions.tmuxEnvironment));
  });

  it("resolves relative paths against the checkout, not the working directory", () => {
    const launchOptions = parseFixture([
      "--dev",
      "--config",
      "config.dev.json",
      "--state-dir",
      ".airlock-state",
      "--approval-helper",
      "build/airlock-approve",
    ]);
    assert.equal(launchOptions.configPath, "/opt/airlock-fixture/config.dev.json");
    assert.equal(launchOptions.stateDirectory, "/opt/airlock-fixture/.airlock-state");
    assert.equal(launchOptions.approvalHelperPath, "/opt/airlock-fixture/build/airlock-approve");
  });

  it("rejects the production state directory", () => {
    assertUsageError(
      () => parseFixture(["--dev", "--config", "c.json", "--state-dir", PRODUCTION_STATE_DIRECTORY]),
      /is the production state directory/,
    );
  });

  it("rejects the production state directory spelled another way", () => {
    const spelledWithDots = join(scratch, "home", ".local", "state", "..", "state", "airlock");
    const spelledInCapitals = join(scratch, "home", ".local", "state", "AIRLOCK");
    const linkToLocal = join(scratch, "link-to-local");
    symlinkSync(join(scratch, "home", ".local"), linkToLocal);
    const spelledThroughSymlink = join(linkToLocal, "state", "airlock");
    for (const stateDirectory of [spelledWithDots, `${PRODUCTION_STATE_DIRECTORY}/`, spelledInCapitals, spelledThroughSymlink]) {
      assertUsageError(
        () => parseFixture(["--dev", "--config", "c.json", "--state-dir", stateDirectory]),
        /is the production state directory/,
      );
    }
  });

  it("rejects the real production state directory by default", () => {
    assertUsageError(
      () =>
        parseLaunchOptions(
          ["--dev", "--config", "c.json", "--state-dir", join(homedir(), ".local", "state", "airlock")],
          { environment: {} },
        ),
      /is the production state directory/,
    );
  });

  it("accepts a state directory that does not exist yet", () => {
    const stateDirectory = join(scratch, "not", "created", "yet");
    assert.equal(parseFixture(["--dev", "--config", "c.json", "--state-dir", stateDirectory]).stateDirectory, stateDirectory);
  });
});

describe("parseLaunchOptions — the attach command line", () => {
  it("quotes only the words a shell would split or expand", () => {
    const productionOptions = parseLaunchOptions([], {
      environment: {},
      installRoot: "/Applications/Air Lock",
      productionStateDirectory: PRODUCTION_STATE_DIRECTORY,
    });
    assert.equal(productionOptions.attachCommandLine, "'/Applications/Air Lock/bin/airlock-attach'");

    const developmentOptions = parseFixture(["--dev", "--config", "c.json", "--state-dir", "/tmp/it's state"]);
    assert.equal(
      developmentOptions.attachCommandLine,
      "/opt/airlock-fixture/bin/airlock-attach --state-dir '/tmp/it'\\''s state'",
    );
  });

  it("leaves a plain path unquoted", () => {
    const developmentOptions = parseFixture(["--dev", "--config", "c.json", "--state-dir", "/tmp/dev-state_1.0"]);
    assert.equal(developmentOptions.attachCommandLine, "/opt/airlock-fixture/bin/airlock-attach --state-dir /tmp/dev-state_1.0");
  });
});

describe("Tmux.forLaunch", () => {
  it("runs a production launch's bundled tmux with its TERMINFO", () => {
    const tmux = Tmux.forLaunch(parseFixture([]));
    assert.equal(tmux.socketPath, join(PRODUCTION_STATE_DIRECTORY, "tmux.sock"));
    assert.equal(tmux.executable, "/opt/airlock-fixture/runtime/bin/tmux");
    assert.deepEqual(tmux.environment, { TERMINFO: "/usr/share/terminfo" });
    assert.ok(
      readFileSync(join(PRODUCTION_STATE_DIRECTORY, "watch.command"), "utf8").includes(
        `TERMINFO='/usr/share/terminfo' '/opt/airlock-fixture/runtime/bin/tmux' '-S' '${tmux.socketPath}' '-f' '/dev/null' attach-session`,
      ),
    );
  });

  it("runs a development launch's Homebrew tmux with the bridge's environment", () => {
    const stateDirectory = join(scratch, "dev-state");
    const tmux = Tmux.forLaunch(parseFixture(["--dev", "--config", "c.json", "--state-dir", stateDirectory]));
    assert.equal(tmux.socketPath, join(stateDirectory, "tmux.sock"));
    assert.equal(tmux.executable, defaultTmuxExecutable());
    assert.deepEqual(tmux.environment, {});
  });
});

describe("parseLaunchOptions — malformed launches", () => {
  it("rejects an unknown option", () => {
    assertUsageError(() => parseFixture(["--bogus"]), /Unknown option '--bogus'/);
  });

  it("rejects a positional argument", () => {
    assertUsageError(() => parseFixture(["config.json"]), /Unexpected argument 'config.json'/);
  });

  it("rejects a path option without its value", () => {
    assertUsageError(() => parseFixture(["--dev", "--state-dir", "/tmp/state", "--config"]), /--config/);
  });

  it("names the flags in its usage text", () => {
    assert.match(USAGE_TEXT, /^usage: airlock-server \[--dev --config PATH --state-dir PATH \[--approval-helper PATH\]\]$/);
  });
});

describe("parseLaunchOptions — retired environment overrides", () => {
  const retiredVariables = {
    AIRLOCK_CONFIG: "--config",
    AIRLOCK_STATE_DIR: "--state-dir",
    AIRLOCK_APPROVE_HELPER: "--approval-helper",
  };
  const developmentArgv = ["--dev", "--config", "c.json", "--state-dir", "/tmp/dev/state"];

  for (const [variable, flag] of Object.entries(retiredVariables)) {
    it(`rejects ${variable} in production and development, naming ${flag}`, () => {
      const message = new RegExp(`^${variable} is no longer supported; pass ${flag} instead \\(it requires --dev\\)$`);
      assertUsageError(() => parseFixture([], { [variable]: "/tmp/override" }), message);
      assertUsageError(() => parseFixture(developmentArgv, { [variable]: "/tmp/override" }), message);
    });
  }

  it("rejects one set to the empty string", () => {
    assertUsageError(() => parseFixture([], { AIRLOCK_CONFIG: "" }), /^AIRLOCK_CONFIG is no longer supported/);
  });

  it("names every retired variable present", () => {
    assertUsageError(
      () => parseFixture([], { AIRLOCK_CONFIG: "/a", AIRLOCK_APPROVE_HELPER: "/b" }),
      /^AIRLOCK_CONFIG is no longer supported; pass --config .*; AIRLOCK_APPROVE_HELPER is no longer supported; pass --approval-helper /,
    );
  });
});
