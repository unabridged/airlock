// Airlock — install check tests (node --test). Zero-dependency: node:test +
// node:assert only. Real-filesystem cases use paths macOS ships root-owned
// and temp files the test user owns; the ownership and mode rules run against
// an in-memory filesystem.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { basename, dirname, join } from "node:path";
import { after, describe, it } from "node:test";

import {
  installationProblems,
  installTreeProblems,
  pathChainProblems,
  refusalText,
} from "../src/install-check.mjs";

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "airlock-install-test-")));
after(() => rmSync(scratch, { recursive: true, force: true }));

const TEST_USER_UID = process.getuid();

// An in-memory filesystem: `entries` maps each absolute path to
// { type: "directory" | "file" | "symlink", uid, mode, target, acl },
// defaulting to a root-owned 0755 entry without an ACL. `acl` lists the
// entries as `ls -le` prints them. A path mapped to undefined does not exist.
function fakeFilesystem(entryDefinitions) {
  const entries = Object.fromEntries(Object.entries(entryDefinitions).filter(([, entry]) => entry !== undefined));
  const entryAt = (path) => {
    const entry = entries[path];
    if (entry) return entry;
    throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${path}'`), { code: "ENOENT" });
  };
  return {
    lstatSync(path) {
      const entry = entryAt(path);
      if (entry.error) throw Object.assign(new Error(`${entry.error}: ${path}`), { code: entry.error });
      return {
        uid: entry.uid ?? 0,
        mode: entry.mode ?? 0o755,
        isDirectory: () => entry.type === "directory",
        isSymbolicLink: () => entry.type === "symlink",
      };
    },
    readlinkSync(path) {
      return entryAt(path).target;
    },
    readdirSync(path) {
      entryAt(path);
      return Object.keys(entries)
        .filter((entryPath) => entryPath !== "/" && dirname(entryPath) === path)
        .map((entryPath) => basename(entryPath));
    },
    readAccessControlLists(paths) {
      return new Map(paths.filter((path) => entries[path]?.acl).map((path) => [path, entries[path].acl]));
    },
  };
}

function rootDirectories(...paths) {
  return Object.fromEntries(paths.map((path) => [path, { type: "directory" }]));
}

describe("pathChainProblems — the real filesystem", () => {
  it("passes the root-owned system executables", () => {
    assert.deepEqual(pathChainProblems("/usr/bin/ssh"), []);
    assert.deepEqual(pathChainProblems("/bin/sh"), []);
  });

  it("reports a temp file the test user owns", () => {
    const filePath = join(scratch, "owned-by-user");
    writeFileSync(filePath, "");
    const problems = pathChainProblems(filePath);
    assert.ok(problems.includes(`${filePath}: owned by uid ${TEST_USER_UID}, not root`), problems.join("\n"));
  });

  it("reports a symlink to a trusted file when the symlink sits in a writable directory", () => {
    const linkDirectory = mkdtempSync(join(scratch, "links-"));
    const linkPath = join(linkDirectory, "ssh");
    symlinkSync("/usr/bin/ssh", linkPath);
    const problems = pathChainProblems(linkPath);
    assert.ok(problems.includes(`${linkDirectory}: owned by uid ${TEST_USER_UID}, not root`), problems.join("\n"));
    assert.ok(problems.includes(`${linkPath}: owned by uid ${TEST_USER_UID}, not root`), problems.join("\n"));
    assert.ok(!problems.some((problem) => problem.startsWith("/usr/bin/ssh")), problems.join("\n"));
  });

  it("reports an access control entry that lets the test user add files", () => {
    const directory = mkdtempSync(join(scratch, "acl-"));
    chmodSync(directory, 0o755);
    execFileSync("/bin/chmod", ["+a", `user:${userInfo().username} allow add_file,delete_child,list`, directory]);
    assert.deepEqual(pathChainProblems(directory, { ownerUid: TEST_USER_UID }).slice(-1), [
      `${directory}: ACL allows user:${userInfo().username} add_file,delete_child`,
    ]);
  });

  it("reports a missing path by the name it was asked about", () => {
    assert.deepEqual(pathChainProblems("/airlock-install-check-missing"), ["/airlock-install-check-missing: missing"]);
    const missingPath = join(scratch, "missing", "deeper");
    assert.ok(pathChainProblems(missingPath).includes(`${missingPath}: missing`));
  });
});

describe("pathChainProblems — ownership and mode rules", () => {
  const entries = {
    ...rootDirectories("/", "/opt"),
    "/opt/group-writable": { type: "directory", mode: 0o775 },
    "/opt/group-writable/other-writable": { type: "directory", mode: 0o757 },
    "/opt/group-writable/other-writable/user-owned": { type: "file", uid: 501, mode: 0o644 },
  };

  it("names every entry on the way that is not root-owned and closed to writes", () => {
    assert.deepEqual(pathChainProblems("/opt/group-writable/other-writable/user-owned", fakeFilesystem(entries)), [
      "/opt/group-writable: group-writable",
      "/opt/group-writable/other-writable: other-writable",
      "/opt/group-writable/other-writable/user-owned: owned by uid 501, not root",
    ]);
  });

  it("checks / itself", () => {
    const filesystem = fakeFilesystem({ "/": { type: "directory", mode: 0o777 } });
    assert.deepEqual(pathChainProblems("/", filesystem), ["/: group-writable", "/: other-writable"]);
  });

  it("names the expected owner when one is injected", () => {
    const filesystem = { ...fakeFilesystem(entries), ownerUid: 501 };
    assert.deepEqual(pathChainProblems("/opt", filesystem), [
      "/: owned by uid 0, not uid 501",
      "/opt: owned by uid 0, not uid 501",
    ]);
  });

  it("reports an entry it cannot read", () => {
    const filesystem = fakeFilesystem({ ...rootDirectories("/", "/opt"), "/opt/secret": { error: "EACCES" } });
    assert.deepEqual(pathChainProblems("/opt/secret/file", filesystem), ["/opt/secret/file: unreadable (EACCES)"]);
  });

  it("names every access control entry that allows changing a root-owned entry", () => {
    const filesystem = fakeFilesystem({
      ...rootDirectories("/"),
      "/opt": {
        type: "directory",
        acl: [
          "group:everyone deny delete",
          "user:me allow list,add_file,search,delete_child,directory_inherit",
          "user:me allow read,readattr",
        ],
      },
      "/opt/airlock": { type: "file", acl: ["group:staff inherited allow write,append"] },
    });
    assert.deepEqual(pathChainProblems("/opt/airlock", filesystem), [
      "/opt: ACL allows user:me add_file,delete_child",
      "/opt/airlock: ACL allows group:staff write,append",
    ]);
  });

  it("refuses when it cannot read the access control lists", () => {
    const filesystem = {
      ...fakeFilesystem(rootDirectories("/")),
      readAccessControlLists() {
        throw new Error("/usr/bin/find exited 1: unreadable");
      },
    };
    assert.deepEqual(pathChainProblems("/", filesystem), [
      "access control lists unreadable (/usr/bin/find exited 1: unreadable)",
    ]);
  });
});

describe("pathChainProblems — symbolic links", () => {
  // A root-owned link whose target is root-owned too, reached through a
  // second link in a user-owned directory: resolving the final path alone
  // would pass it.
  const entries = {
    ...rootDirectories("/", "/usr", "/usr/local", "/usr/local/bin", "/Users", "/opt", "/opt/real"),
    "/usr/local/bin/node": { type: "symlink", target: "../../../Users/me/node" },
    "/Users/me": { type: "directory", uid: 501 },
    "/Users/me/node": { type: "symlink", target: "/opt/real/node" },
    "/opt/real/node": { type: "file" },
  };

  it("checks every directory a hop passes through, relative and absolute", () => {
    assert.deepEqual(pathChainProblems("/usr/local/bin/node", fakeFilesystem(entries)), [
      "/Users/me: owned by uid 501, not root",
    ]);
  });

  it("passes a chain of root-owned links", () => {
    const filesystem = fakeFilesystem({ ...entries, "/Users/me": { type: "directory" } });
    assert.deepEqual(pathChainProblems("/usr/local/bin/node", filesystem), []);
  });

  it("reports a link to a missing target as missing", () => {
    const filesystem = fakeFilesystem({ ...entries, "/opt/real/node": undefined });
    assert.ok(pathChainProblems("/usr/local/bin/node", filesystem).includes("/usr/local/bin/node: missing"));
  });

  it("gives up on a link loop after 40 hops", () => {
    const filesystem = fakeFilesystem({
      ...rootDirectories("/"),
      "/first": { type: "symlink", target: "/second" },
      "/second": { type: "symlink", target: "first" },
    });
    assert.deepEqual(pathChainProblems("/first", filesystem), ["/first: more than 40 symbolic links"]);
  });
});

describe("installTreeProblems", () => {
  it("recurses into every directory of the in-memory tree", () => {
    const filesystem = fakeFilesystem({
      ...rootDirectories("/", "/opt", "/opt/airlock", "/opt/airlock/src", "/opt/airlock/src/drivers"),
      "/opt/airlock/src/drivers/shell.mjs": { type: "file", uid: 501, mode: 0o644 },
      "/opt/airlock/src/server.mjs": { type: "file", mode: 0o664 },
      "/opt/airlock/src/link": { type: "symlink", target: "/usr/bin/ssh" },
    });
    assert.deepEqual(installTreeProblems("/opt/airlock", filesystem), [
      "/opt/airlock/src/drivers/shell.mjs: owned by uid 501, not root",
      "/opt/airlock/src/link: symlink inside the install tree",
      "/opt/airlock/src/server.mjs: group-writable",
    ]);
  });

  it("walks a real tree, reporting writable files and symlinks at any depth", () => {
    const installRoot = mkdtempSync(join(scratch, "tree-"));
    mkdirSync(join(installRoot, "src", "drivers"), { recursive: true, mode: 0o755 });
    chmodSync(join(installRoot, "src"), 0o755);
    chmodSync(join(installRoot, "src", "drivers"), 0o755);
    writeFileSync(join(installRoot, "src", "server.mjs"), "", { mode: 0o644 });
    const writableDriver = join(installRoot, "src", "drivers", "shell.mjs");
    writeFileSync(writableDriver, "");
    chmodSync(writableDriver, 0o666);
    symlinkSync("/usr/bin/ssh", join(installRoot, "src", "drivers", "ssh"));
    assert.deepEqual(installTreeProblems(installRoot, { ownerUid: TEST_USER_UID }), [
      `${writableDriver}: group-writable`,
      `${writableDriver}: other-writable`,
      `${join(installRoot, "src", "drivers", "ssh")}: symlink inside the install tree`,
    ]);
  });
});

describe("installationProblems", () => {
  const cleanInstall = {
    ...rootDirectories("/", "/usr", "/usr/bin", "/opt", "/opt/airlock", "/opt/airlock/bin"),
    ...rootDirectories("/opt/airlock/runtime", "/opt/airlock/runtime/bin"),
    "/opt/airlock/config.json": { type: "file", mode: 0o644 },
    "/opt/airlock/bin/airlock-approve": { type: "file" },
    "/opt/airlock/runtime/bin/node": { type: "file" },
    "/opt/airlock/runtime/bin/tmux": { type: "file" },
    "/usr/bin/ssh": { type: "file" },
  };
  const locations = {
    installRoot: "/opt/airlock",
    configPath: "/opt/airlock/config.json",
    approvalHelperPath: "/opt/airlock/bin/airlock-approve",
    tmuxExecutable: "/opt/airlock/runtime/bin/tmux",
  };
  const nodeExecutable = "/opt/airlock/runtime/bin/node";

  it("passes a root-owned installation", () => {
    assert.deepEqual(installationProblems(locations, { ...fakeFilesystem(cleanInstall), nodeExecutable }), []);
  });

  it("reports each missing file it runs or reads by name", () => {
    const filesystem = fakeFilesystem({
      ...cleanInstall,
      "/opt/airlock/config.json": undefined,
      "/opt/airlock/bin/airlock-approve": undefined,
      "/opt/airlock/runtime/bin/tmux": undefined,
      "/usr/bin/ssh": undefined,
    });
    assert.deepEqual(installationProblems(locations, { ...filesystem, nodeExecutable }), [
      "/opt/airlock/config.json: missing",
      "/opt/airlock/bin/airlock-approve: missing",
      "/opt/airlock/runtime/bin/tmux: missing",
      "/usr/bin/ssh: missing",
    ]);
  });

  it("checks the ancestors, the tree, node, and ssh, each entry once", () => {
    const filesystem = fakeFilesystem({
      ...cleanInstall,
      "/opt": { type: "directory", uid: 501 },
      "/opt/airlock/runtime/bin/tmux": { type: "file", mode: 0o775 },
      "/usr/local": { type: "directory", mode: 0o777 },
      "/usr/local/node": { type: "file" },
      "/usr/bin/ssh": { type: "file", uid: 501 },
    });
    assert.deepEqual(installationProblems(locations, { ...filesystem, nodeExecutable: "/usr/local/node" }), [
      "/opt: owned by uid 501, not root",
      "/opt/airlock/runtime/bin/tmux: group-writable",
      "/usr/local: group-writable",
      "/usr/local: other-writable",
      "/usr/bin/ssh: owned by uid 501, not root",
    ]);
  });

  it("refuses the checkout these tests run from", () => {
    const checkoutRoot = realpathSync(new URL("..", import.meta.url));
    const problems = installationProblems({
      installRoot: checkoutRoot,
      configPath: join(checkoutRoot, "config.json"),
      approvalHelperPath: join(checkoutRoot, "bin", "airlock-approve"),
      tmuxExecutable: join(checkoutRoot, "runtime", "bin", "tmux"),
    });
    assert.ok(problems.includes(`${checkoutRoot}: owned by uid ${TEST_USER_UID}, not root`), problems.join("\n"));
    assert.ok(problems.includes(`${join(checkoutRoot, "runtime", "bin", "tmux")}: missing`));
  });
});

describe("refusalText", () => {
  const locations = { installRoot: "/opt/airlock", configPath: "/opt/airlock/config.json" };

  it("explains the refusal, lists the problems, and says how to run instead", () => {
    assert.equal(
      refusalText(locations, ["/opt: owned by uid 501, not root"]),
      "[airlock] refusing to start: the Airlock installation at /opt/airlock fails its trust check.\n" +
        "  /opt: owned by uid 501, not root\n" +
        "Everything the server trusts must exist, be owned by root, and allow no other user to write it, " +
        "or an agent could replace the approval gate.\n" +
        "Install the package (see README), or run a development instance with --dev --config <path> " +
        "--state-dir <path>.\n",
    );
  });

  it("asks only for the configuration when nothing else is wrong", () => {
    assert.equal(
      refusalText(locations, ["/opt/airlock/config.json: missing"]),
      "[airlock] refusing to start: the configuration /opt/airlock/config.json is missing.\n" +
        "Create it as root (see README): sudo cp /opt/airlock/config.example.json /opt/airlock/config.json\n",
    );
  });

  it("asks for the configuration as well when other problems refuse the installation", () => {
    const lines = refusalText(locations, ["/opt/airlock/config.json: missing", "/opt: group-writable"]).split("\n");
    assert.deepEqual(lines.slice(1, 3), ["  /opt/airlock/config.json: missing", "  /opt: group-writable"]);
    assert.equal(
      lines[4],
      "The configuration is missing too. Create it as root (see README): " +
        "sudo cp /opt/airlock/config.example.json /opt/airlock/config.json",
    );
  });

  it("prints the first 20 problems and counts the rest", () => {
    const problems = Array.from({ length: 23 }, (_, index) => `/opt/file-${index}: group-writable`);
    const lines = refusalText(locations, problems).trimEnd().split("\n");
    assert.equal(lines.length, 1 + 20 + 1 + 2);
    assert.equal(lines[1], "  /opt/file-0: group-writable");
    assert.equal(lines[20], "  /opt/file-19: group-writable");
    assert.equal(lines[21], "  and 3 more");
  });
});
