// Airlock — packaging tests (node --test test/package.test.mjs).
// Zero-dependency: node:test + node:assert only.
//
// The launcher, attach client, and preinstall cases run in every suite
// against temporary trees. The package cases run only with
// AIRLOCK_PACKAGE_TEST=1 on macOS (npm run test:package): they build the .pkg
// with bin/build-pkg into a temporary directory, expand it with pkgutil, and
// check the payload the installer would lay down under
// /usr/local/libexec/airlock. No test ever installs the package.

import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { defaultTmuxExecutable, shellQuote } from "../src/tmux.mjs";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const LAUNCHER_PATH = join(REPO_ROOT, "bin", "airlock-server");
const ATTACH_CLIENT_PATH = join(REPO_ROOT, "bin", "airlock-attach");
const PREINSTALL_PATH = join(REPO_ROOT, "packaging", "scripts", "preinstall");
const BUMP_CASK_PATH = join(REPO_ROOT, "bin", "bump-cask");
const CASK_PATH = join(REPO_ROOT, "Casks", "airlock.rb");
const INSTALL_LOCATION = "usr/local/libexec/airlock";
const BUILD_TIMEOUT_MILLISECONDS = 5 * 60 * 1000;
const PACKAGE_TESTS_ENABLED =
  process.env.AIRLOCK_PACKAGE_TEST === "1" && process.platform === "darwin";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "airlock-package-test-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

function makeScratchDirectory(name) {
  const directoryPath = join(scratch, name);
  mkdirSync(directoryPath, { recursive: true });
  return directoryPath;
}

function walkTree(rootPath) {
  const entries = [];
  const pending = [rootPath];
  while (pending.length > 0) {
    const directoryPath = pending.pop();
    for (const name of readdirSync(directoryPath)) {
      const entryPath = join(directoryPath, name);
      const stats = lstatSync(entryPath);
      entries.push({ path: entryPath, stats });
      if (stats.isDirectory()) pending.push(entryPath);
    }
  }
  return entries;
}

function parseEnvironmentDump(dump) {
  return Object.fromEntries(
    dump
      .split("\n")
      .filter((line) => line.includes("="))
      .map((line) => [line.slice(0, line.indexOf("=")), line.slice(line.indexOf("=") + 1)]),
  );
}

// ---- launcher ---------------------------------------------------------------

// A fake install root: the real launcher plus a runtime/bin/node stand-in
// that records the environment and argv it receives.
function writeFakeInstall() {
  const installRoot = makeScratchDirectory(`install-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(installRoot, "bin"));
  mkdirSync(join(installRoot, "runtime", "bin"), { recursive: true });
  copyFileSync(LAUNCHER_PATH, join(installRoot, "bin", "airlock-server"));
  chmodSync(join(installRoot, "bin", "airlock-server"), 0o755);
  const environmentDumpPath = join(installRoot, "environment.out");
  const argumentsDumpPath = join(installRoot, "arguments.out");
  writeFileSync(
    join(installRoot, "runtime", "bin", "node"),
    `#!/bin/sh\n/usr/bin/env > '${environmentDumpPath}'\nprintf '%s\\n' "$@" > '${argumentsDumpPath}'\n`,
    { mode: 0o755 },
  );
  return { installRoot, environmentDumpPath, argumentsDumpPath };
}

// Extracts the sed expression {bin/airlock-server} uses to turn its
// environment into the variable names it unsets.
function launcherScrubExpression() {
  const match = readFileSync(LAUNCHER_PATH, "utf8").match(/\/usr\/bin\/sed -n -E '([^']+)'/);
  assert.ok(match, "bin/airlock-server has no sed scrub expression");
  return match[1];
}

describe("bin/airlock-server", () => {
  // SIP strips DYLD_* variables before the launcher's /bin/sh starts, so none
  // can reach it here; the scrub expression test covers the DYLD_* names.
  it("unsets NODE_* and OPENSSL_* variables and runs the bundled server", () => {
    const { installRoot, environmentDumpPath, argumentsDumpPath } = writeFakeInstall();
    const result = spawnSync(join(installRoot, "bin", "airlock-server"), ["--dev", "two words"], {
      encoding: "utf8",
      env: {
        ...process.env,
        NODE_OPTIONS: "--require /nonexistent-airlock-probe",
        NODE_PATH: "/nonexistent-airlock-probe",
        OPENSSL_CONF: "/nonexistent-airlock-probe.cnf",
        OPENSSL_MODULES: "/nonexistent-airlock-probe",
        XNODE_OPTIONS: "kept",
        AIRLOCK_PACKAGE_TEST_KEPT: "kept",
      },
    });
    assert.equal(result.status, 0, result.stderr);

    const environment = parseEnvironmentDump(readFileSync(environmentDumpPath, "utf8"));
    const scrubbedNames = Object.keys(environment).filter((name) => /^(NODE|OPENSSL)_/.test(name));
    assert.deepEqual(scrubbedNames, []);
    assert.equal(environment.XNODE_OPTIONS, "kept");
    assert.equal(environment.AIRLOCK_PACKAGE_TEST_KEPT, "kept");
    assert.deepEqual(readFileSync(argumentsDumpPath, "utf8").split("\n").slice(0, -1), [
      join(installRoot, "src", "server.mjs"),
      "--dev",
      "two words",
    ]);
  });

  it("selects every NODE_*, DYLD_*, and OPENSSL_* name of the environment to unset", () => {
    const environmentDump = [
      "DYLD_INSERT_LIBRARIES=/nonexistent-airlock-probe.dylib",
      "DYLD_LIBRARY_PATH=/nonexistent-airlock-probe",
      "NODE_OPTIONS=--require /nonexistent-airlock-probe",
      "OPENSSL_CONF=/nonexistent-airlock-probe.cnf",
      "XDYLD_KEPT=kept",
      "PATH=/usr/bin:/bin",
      "MY_DYLD_KEPT=DYLD_FAKE=kept",
      "",
    ].join("\n");
    const selection = spawnSync("/usr/bin/sed", ["-n", "-E", launcherScrubExpression()], {
      encoding: "utf8",
      input: environmentDump,
    });
    assert.equal(selection.status, 0, selection.stderr);
    assert.deepEqual(selection.stdout.split("\n").slice(0, -1), [
      "DYLD_INSERT_LIBRARIES",
      "DYLD_LIBRARY_PATH",
      "NODE_OPTIONS",
      "OPENSSL_CONF",
    ]);
  });

  it("runs the install a symlink to the launcher points into", () => {
    const { installRoot, argumentsDumpPath } = writeFakeInstall();
    const linkDirectory = makeScratchDirectory(`links-${Math.random().toString(36).slice(2)}`);
    mkdirSync(join(linkDirectory, "bin"));
    const linkPath = join(linkDirectory, "bin", "airlock-server");
    symlinkSync(join(installRoot, "bin", "airlock-server"), linkPath);
    const result = spawnSync(linkPath, ["--dev"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readFileSync(argumentsDumpPath, "utf8").split("\n").slice(0, -1), [
      join(installRoot, "src", "server.mjs"),
      "--dev",
    ]);
  });

  it("does not import shell functions from the environment", () => {
    const { installRoot, argumentsDumpPath } = writeFakeInstall();
    const result = spawnSync(join(installRoot, "bin", "airlock-server"), [], {
      encoding: "utf8",
      env: {
        ...process.env,
        "BASH_FUNC_cd%%": "() { echo /nonexistent-airlock-probe; }",
        "BASH_FUNC_pwd%%": "() { echo /nonexistent-airlock-probe; }",
      },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(argumentsDumpPath, "utf8").trim(),
      join(installRoot, "src", "server.mjs"),
    );
  });

  it("refuses to run from a checkout, which has no bundled node", () => {
    const result = spawnSync(LAUNCHER_PATH, [], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /runtime\/bin\/node is missing/);
  });
});

// ---- attach client ----------------------------------------------------------

// A fake install root: the real attach client plus `tmuxSource` as its
// bundled runtime/bin/tmux.
function writeFakeAttachInstall(tmuxSource) {
  const installRoot = makeScratchDirectory(`attach-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(installRoot, "bin"));
  mkdirSync(join(installRoot, "runtime", "bin"), { recursive: true });
  copyFileSync(ATTACH_CLIENT_PATH, join(installRoot, "bin", "airlock-attach"));
  chmodSync(join(installRoot, "bin", "airlock-attach"), 0o755);
  writeFileSync(join(installRoot, "runtime", "bin", "tmux"), tmuxSource, { mode: 0o755 });
  return installRoot;
}

// Runs the attach client on a bundled tmux stand-in that records the
// terminal it runs with, then ends the client.
function attachClientTerminal(terminal) {
  const terminalDumpPath = join(scratch, `terminal-${Math.random().toString(36).slice(2)}.out`);
  const installRoot = writeFakeAttachInstall(
    `#!/bin/sh\nprintf '%s\\n' "$TERM" "$TERMINFO" > '${terminalDumpPath}'\nkill $PPID\n`,
  );
  spawnSync(join(installRoot, "bin", "airlock-attach"), [], {
    encoding: "utf8",
    env: { ...process.env, TERM: terminal },
  });
  return readFileSync(terminalDumpPath, "utf8").split("\n").slice(0, -1);
}

describe("bin/airlock-attach", () => {
  it("runs the bundled tmux on the system terminfo database with a TERM it describes", () => {
    assert.deepEqual(attachClientTerminal("vt100"), ["vt100", "/usr/share/terminfo"]);
  });

  it("falls back to xterm-256color for a TERM the system terminfo database lacks", () => {
    assert.deepEqual(attachClientTerminal("airlock-unlisted"), ["xterm-256color", "/usr/share/terminfo"]);
    assert.deepEqual(attachClientTerminal("../76/vt100"), ["xterm-256color", "/usr/share/terminfo"]);
  });

  it("starts no server on the user's tmux config when the session ends before the attach", async () => {
    // The stand-in tells has-session the session exists, as when the session
    // ends between the client's check and its attach, runs the real tmux for
    // everything else, and then ends the client.
    const installRoot = writeFakeAttachInstall(`#!/bin/sh
case " $* " in *" has-session "*) exit 0 ;; esac
${shellQuote(defaultTmuxExecutable())} "$@"
kill $PPID
`);
    // This config keeps a server without sessions running, so a server that
    // read it outlives the failed attach that started it.
    const homeDirectory = join(installRoot, "home");
    mkdirSync(homeDirectory);
    writeFileSync(join(homeDirectory, ".tmux.conf"), "set -g exit-empty off\n");
    const environment = { ...process.env, HOME: homeDirectory, XDG_CONFIG_HOME: join(homeDirectory, ".config") };
    delete environment.TMUX;
    // A directory of its own beside the system temporary directory keeps the
    // socket path under the macOS limit.
    const stateDirectory = mkdtempSync(join(tmpdir(), "airlock-attach-"));
    const serverArgv = ["-S", join(stateDirectory, "tmux.sock"), "-f", "/dev/null"];
    try {
      spawnSync(join(installRoot, "bin", "airlock-attach"), ["--state-dir", stateDirectory], {
        env: environment,
        stdio: "ignore",
        timeout: 10_000,
      });
      let serverRunning = true;
      for (let attempt = 0; attempt < 20 && serverRunning; attempt += 1) {
        await sleep(100);
        serverRunning =
          spawnSync(defaultTmuxExecutable(), [...serverArgv, "show-options", "-g", "exit-empty"]).status === 0;
      }
      assert.equal(serverRunning, false);
    } finally {
      spawnSync(defaultTmuxExecutable(), [...serverArgv, "kill-server"]);
      rmSync(stateDirectory, { recursive: true, force: true });
    }
  });
});

// ---- preinstall -------------------------------------------------------------

// The real preinstall script pointed at a temporary install root, which is
// owned by the test user rather than root.
function writePreinstallFor(installRoot) {
  const scriptSource = readFileSync(PREINSTALL_PATH, "utf8");
  const pointedSource = scriptSource.replace(/^INSTALL_ROOT=.*$/m, `INSTALL_ROOT='${installRoot}'`);
  assert.notEqual(pointedSource, scriptSource, "preinstall has no INSTALL_ROOT= line");
  const scriptPath = join(scratch, `preinstall-${Math.random().toString(36).slice(2)}`);
  writeFileSync(scriptPath, pointedSource, { mode: 0o755 });
  return scriptPath;
}

function writePreviousInstall() {
  const installRoot = makeScratchDirectory(`previous-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(installRoot, "bin"));
  writeFileSync(join(installRoot, "config.json"), "{}\n");
  return installRoot;
}

describe("packaging/scripts/preinstall", () => {
  it("refuses an install root not owned by root and removes nothing", () => {
    const installRoot = writePreviousInstall();
    const result = spawnSync(writePreinstallFor(installRoot), ["airlock.pkg", "/", "/"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /owned by uid \d+, not root/);
    assert.ok(existsSync(join(installRoot, "bin")));
    assert.ok(existsSync(join(installRoot, "config.json")));
  });

  it("refuses an install root whose access control list allows changing it", () => {
    const installRoot = writePreviousInstall();
    execFileSync("/bin/chmod", ["+a", "everyone allow add_file,add_subdirectory,delete_child", installRoot]);
    const result = spawnSync(writePreinstallFor(installRoot), ["airlock.pkg", "/", "/"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.ok(
      result.stderr.includes(`${installRoot} has an access control entry that allows changing it`),
      result.stderr,
    );
    assert.ok(existsSync(join(installRoot, "bin")));
  });

  it("passes an access control entry that only allows reading on to the owner check", () => {
    const installRoot = writePreviousInstall();
    execFileSync("/bin/chmod", ["+a", "everyone allow list,search,readattr", installRoot]);
    const result = spawnSync(writePreinstallFor(installRoot), ["airlock.pkg", "/", "/"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /owned by uid \d+, not root/);
  });

  it("refuses a symlinked install root", () => {
    const installRoot = writePreviousInstall();
    const linkPath = join(scratch, `link-${Math.random().toString(36).slice(2)}`);
    symlinkSync(installRoot, linkPath);
    const result = spawnSync(writePreinstallFor(linkPath), ["airlock.pkg", "/", "/"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.ok(result.stderr.includes(`${linkPath} is a symlink`), result.stderr);
    assert.ok(existsSync(join(installRoot, "bin")));
  });

  it("refuses a target volume other than the startup volume", () => {
    const result = spawnSync(PREINSTALL_PATH, ["airlock.pkg", "/", "/Volumes/Elsewhere"], {
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /only on the startup volume/);
  });
});

// ---- cask -------------------------------------------------------------------

function caskMacosLine(caskSource) {
  return caskSource.split("\n").find((line) => line.trim().startsWith("depends_on macos:"));
}

// Runs bin/bump-cask on `packagePath` against a copy of the repository's cask
// and returns the result with the rewritten copy.
function bumpCaskCopy(packagePath) {
  const caskCopyPath = join(makeScratchDirectory(`cask-${Math.random().toString(36).slice(2)}`), "airlock.rb");
  copyFileSync(CASK_PATH, caskCopyPath);
  const result = spawnSync(BUMP_CASK_PATH, [packagePath, "--cask", caskCopyPath], { encoding: "utf8" });
  return { result, caskSource: readFileSync(caskCopyPath, "utf8") };
}

describe("bin/bump-cask", () => {
  it("rewrites the version, sha256, and macOS minimum from the package", () => {
    const packageDirectory = makeScratchDirectory(`bump-${Math.random().toString(36).slice(2)}`);
    writeFileSync(
      join(packageDirectory, "Distribution"),
      '<installer-gui-script>\n    <allowed-os-versions>\n        <os-version min="14.0"/>\n' +
        "    </allowed-os-versions>\n</installer-gui-script>\n",
    );
    const packagePath = join(packageDirectory, "airlock-1.2.3.pkg");
    execFileSync("/usr/bin/xar", ["-c", "-f", packagePath, "Distribution"], { cwd: packageDirectory });
    const packageSha256 = execFileSync("/usr/bin/shasum", ["-a", "256", packagePath], { encoding: "utf8" })
      .split(" ")[0];

    const { result, caskSource } = bumpCaskCopy(packagePath);
    assert.equal(result.status, 0, result.stderr);
    assert.match(caskSource, /^ {2}version "1\.2\.3"$/m);
    assert.ok(caskSource.includes(`\n  sha256 "${packageSha256}"\n`), caskSource);
    assert.equal(caskMacosLine(caskSource), "  depends_on macos: :sonoma");
  });
});

// ---- package ----------------------------------------------------------------

describe("bin/build-pkg", {
  skip: !PACKAGE_TESTS_ENABLED && "set AIRLOCK_PACKAGE_TEST=1 on macOS to build the package",
  timeout: BUILD_TIMEOUT_MILLISECONDS,
}, () => {
  let packagePath;
  let expandedDirectory;
  let payloadRoot;
  let bomEntries;

  before(() => {
    const outputDirectory = makeScratchDirectory("dist");
    const build = spawnSync(join(REPO_ROOT, "bin", "build-pkg"), ["--output", outputDirectory], {
      encoding: "utf8",
      timeout: BUILD_TIMEOUT_MILLISECONDS,
    });
    assert.equal(build.status, 0, `build-pkg failed:\n${build.stdout}\n${build.stderr}`);

    const packageNames = readdirSync(outputDirectory).filter((name) =>
      /^airlock-\d+\.\d+\.\d+\.pkg$/.test(name),
    );
    assert.equal(packageNames.length, 1, `expected one package, found ${packageNames}`);
    packagePath = join(outputDirectory, packageNames[0]);

    expandedDirectory = join(scratch, "expanded");
    const expansion = spawnSync(
      "/usr/sbin/pkgutil",
      ["--expand-full", packagePath, expandedDirectory],
      { encoding: "utf8" },
    );
    assert.equal(expansion.status, 0, expansion.stderr);
    payloadRoot = join(expandedDirectory, "airlock-component.pkg", "Payload", INSTALL_LOCATION);

    const listing = spawnSync(
      "/usr/bin/lsbom",
      [join(expandedDirectory, "airlock-component.pkg", "Bom")],
      { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    assert.equal(listing.status, 0, listing.stderr);
    bomEntries = listing.stdout
      .trim()
      .split("\n")
      .map((line) => {
        const [path, mode, ownership] = line.split("\t");
        return { path, mode: Number.parseInt(mode, 8), ownership };
      });
  }, { timeout: BUILD_TIMEOUT_MILLISECONDS });

  it("lays out the install root", () => {
    for (const entry of [
      "bin/airlock-server",
      "bin/airlock-approve",
      "bin/airlock-attach",
      "runtime/bin/node",
      "runtime/bin/tmux",
      "src/server.mjs",
      "node_modules/shiki",
      "config.example.json",
    ]) {
      assert.ok(existsSync(join(payloadRoot, entry)), `${entry} is missing from the payload`);
    }
  });

  it("ships no config, dev config, tests, or other checkout-only files", () => {
    const payloadNames = readdirSync(payloadRoot);
    assert.ok(!payloadNames.includes("config.json"));
    assert.deepEqual(payloadNames.filter((name) => name.startsWith("config.dev")), []);
    for (const name of ["test", "docs", "packaging", "Casks", "PLAN.md", "airlock-approve.swift", ".git"]) {
      assert.ok(!payloadNames.includes(name), `${name} is in the payload`);
    }
    assert.ok(!existsSync(join(payloadRoot, "node_modules", ".bin")));
    assert.deepEqual(
      bomEntries.filter(({ path }) => /\/config(\.dev[^/]*)?\.json$/.test(path)),
      [],
    );
  });

  it("contains no symlinks", () => {
    const symlinkPaths = walkTree(join(expandedDirectory, "airlock-component.pkg", "Payload"))
      .filter(({ stats }) => stats.isSymbolicLink())
      .map(({ path }) => path);
    assert.deepEqual(symlinkPaths, []);
    assert.deepEqual(
      bomEntries.filter(({ mode }) => (mode & 0o170000) === 0o120000).map(({ path }) => path),
      [],
    );
  });

  it("has no group- or other-writable entries", () => {
    const writableExpandedPaths = walkTree(payloadRoot)
      .filter(({ stats }) => (stats.mode & 0o022) !== 0)
      .map(({ path }) => path);
    assert.deepEqual(writableExpandedPaths, []);
    const writableBomPaths = bomEntries
      .filter(({ mode }) => (mode & 0o022) !== 0)
      .map(({ path }) => path);
    assert.deepEqual(writableBomPaths, []);
  });

  it("records every Bom entry as owned by uid 0 and gid 0", () => {
    assert.ok(bomEntries.length > 0);
    assert.deepEqual(
      bomEntries.filter(({ ownership }) => ownership !== "0/0").map(({ path }) => path),
      [],
    );
  });

  it("bundles a tmux that loads only system and bundled libraries", () => {
    const libraryDirectory = join(payloadRoot, "runtime", "lib");
    const machoPaths = [
      join(payloadRoot, "runtime", "bin", "tmux"),
      ...readdirSync(libraryDirectory).map((name) => join(libraryDirectory, name)),
    ];
    for (const machoPath of machoPaths) {
      const listing = spawnSync("/usr/bin/otool", ["-L", machoPath], { encoding: "utf8" });
      assert.equal(listing.status, 0, listing.stderr);
      // The first line echoes the Mach-O's own path; the rest are its loads.
      const libraryReferences = listing.stdout.split("\n").slice(1).join("\n");
      assert.doesNotMatch(libraryReferences, /\/opt\/homebrew|\/usr\/local/, listing.stdout);
    }

    const version = spawnSync(join(payloadRoot, "runtime", "bin", "tmux"), ["-V"], {
      encoding: "utf8",
      env: { ...process.env, TERMINFO: "/usr/share/terminfo" },
    });
    assert.equal(version.status, 0, version.stderr);
    assert.match(version.stdout, /^tmux \d/);
  });

  it("limits the distribution to Apple silicon and a minimum macOS", () => {
    const distribution = readFileSync(join(expandedDirectory, "Distribution"), "utf8");
    assert.match(distribution, /hostArchitectures="arm64"/);
    assert.match(distribution, /<os-version min="\d+(\.\d+)*"\/>/);
    assert.match(distribution, /customize="never"/);
  });

  it("declares the package's minimum macOS in the cask", () => {
    const { result, caskSource } = bumpCaskCopy(packagePath);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(caskMacosLine(caskSource), caskMacosLine(readFileSync(CASK_PATH, "utf8")));
  });

  it("ships an executable preinstall script", () => {
    const preinstallPath = join(expandedDirectory, "airlock-component.pkg", "Scripts", "preinstall");
    assert.ok(existsSync(preinstallPath));
    assert.notEqual(statSync(preinstallPath).mode & 0o111, 0);
  });

  it("launches the bundled server without the NODE_OPTIONS injection", () => {
    const result = spawnSync(join(payloadRoot, "bin", "airlock-server"), ["--config", "x"], {
      encoding: "utf8",
      timeout: 30_000,
      env: { ...process.env, NODE_OPTIONS: "--require /nonexistent-airlock-probe" },
    });
    assert.equal(result.status, 1, `exit ${result.status} ${result.signal}: ${result.stderr}`);
    assert.ok(!result.stderr.includes("nonexistent-airlock-probe"), result.stderr);
  });
});
