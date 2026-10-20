// Airlock — install check: refuse to run from an installation a non-root user
// can modify.
//
// The agent Airlock gates runs as the same user as the bridge, so anything in
// the trust chain that user can write — the server's own source, the approval
// helper, the config, tmux, node, ssh, or any directory above them — lets the
// agent replace the gate it is asking to pass. A production instance checks
// the whole chain before it reads its config or answers any MCP traffic.

import { spawnSync } from "node:child_process";
import { lstatSync, readdirSync, readlinkSync } from "node:fs";
import { dirname, join } from "node:path";

const SYMBOLIC_LINK_HOP_LIMIT = 40;
const PRINTED_PROBLEM_LIMIT = 20;
const GROUP_WRITE_BIT = 0o020;
const OTHER_WRITE_BIT = 0o002;
const MISSING_ERROR_CODES = new Set(["ENOENT", "ENOTDIR"]);
const ACCESS_CONTROL_QUERY_BATCH_SIZE = 1000;

// The ACL rights that let their grantee change an entry, its metadata, or a
// directory's contents, whatever the entry's owner and mode bits say.
const MUTATING_RIGHTS = new Set([
  "write",
  "append",
  "delete",
  "writeattr",
  "writeextattr",
  "writesecurity",
  "chown",
  "add_file",
  "add_subdirectory",
  "delete_child",
]);

// An entry as `ls -le` prints it, without its index: "user:me allow write" or
// "group:staff inherited allow add_file,delete_child".
const ALLOWING_ACCESS_CONTROL_ENTRY = /^(.+?) (?:inherited )?allow ([a-z_,]+)$/;

// Executables outside the install that the bridge runs on every session.
const TRUSTED_SYSTEM_PATHS = ["/usr/bin/ssh"];

// Spawns `executable` and returns its stdout, throwing when it fails.
function standardOutputOf(executable, argv) {
  const { status, stdout, stderr, error } = spawnSync(executable, argv, { encoding: "utf8" });
  if (error) throw error;
  if (status !== 0) throw new Error(`${executable} exited ${status}: ${stderr.trim()}`);
  return stdout;
}

// Maps each of `paths` that carries an access control list to its entries as
// `ls -le` prints them. `find -acl` picks out the listed paths in batches, so
// a tree without ACLs costs one process per batch.
function readAccessControlLists(paths) {
  const listedPaths = [];
  for (let start = 0; start < paths.length; start += ACCESS_CONTROL_QUERY_BATCH_SIZE) {
    const batch = paths.slice(start, start + ACCESS_CONTROL_QUERY_BATCH_SIZE);
    const output = standardOutputOf("/usr/bin/find", [...batch, "-prune", "-acl", "-print0"]);
    listedPaths.push(...output.split("\0").filter((path) => path !== ""));
  }
  return new Map(listedPaths.map((path) => [path, listedAccessControlEntries(path)]));
}

function listedAccessControlEntries(path) {
  return standardOutputOf("/bin/ls", ["-lde", "--", path])
    .split("\n")
    .filter((line) => /^ *\d+: /.test(line))
    .map((line) => line.replace(/^ *\d+: /, ""));
}

// The grantee and mutating rights of an allowing access control entry, or
// undefined when it grants none.
function mutatingGrant(accessControlEntry) {
  const match = ALLOWING_ACCESS_CONTROL_ENTRY.exec(accessControlEntry);
  if (!match) return undefined;
  const [, grantee, rights] = match;
  const mutatingRights = rights.split(",").filter((right) => MUTATING_RIGHTS.has(right));
  return mutatingRights.length > 0 ? `${grantee} ${mutatingRights.join(",")}` : undefined;
}

// Collects the problems found across any number of checks, inspecting each
// filesystem entry once.
class TrustInspector {
  #lstat;
  #readlink;
  #readdir;
  #readAccessControlLists;
  #ownerUid;
  #inspectedPaths = new Set();
  #problems = [];

  constructor({
    lstatSync: lstat = lstatSync,
    readlinkSync: readlink = readlinkSync,
    readdirSync: readdir = readdirSync,
    readAccessControlLists: accessControlListReader = readAccessControlLists,
    ownerUid = 0,
  } = {}) {
    this.#lstat = lstat;
    this.#readlink = readlink;
    this.#readdir = readdir;
    this.#readAccessControlLists = accessControlListReader;
    this.#ownerUid = ownerUid;
  }

  get problems() {
    return [...this.#problems];
  }

  // Records every access control entry that lets anyone change an entry
  // inspected so far: an ACL grant bypasses the owner and mode bits the other
  // checks read.
  inspectAccessControlLists() {
    let accessControlLists;
    try {
      accessControlLists = this.#readAccessControlLists([...this.#inspectedPaths]);
    } catch (err) {
      this.#problems.push(`access control lists unreadable (${err.message})`);
      return;
    }
    for (const [entryPath, accessControlEntries] of accessControlLists) {
      for (const accessControlEntry of accessControlEntries) {
        const grant = mutatingGrant(accessControlEntry);
        if (grant) this.#problems.push(`${entryPath}: ACL allows ${grant}`);
      }
    }
  }

  // Resolves `path` one component at a time from /, following each symbolic
  // link through its target and inspecting every entry it passes through, so
  // a writable directory anywhere on the way is caught even when it is not
  // an ancestor of the final file.
  inspectPathChain(path) {
    const pendingComponents = pathComponents(path);
    let currentPath = "/";
    let symbolicLinkHops = 0;
    if (!this.#inspectExistingEntry(path, currentPath)) return;
    while (pendingComponents.length > 0) {
      const component = pendingComponents.shift();
      if (component === ".") continue;
      if (component === "..") {
        currentPath = dirname(currentPath);
        continue;
      }
      const candidatePath = join(currentPath, component);
      const stats = this.#inspectExistingEntry(path, candidatePath);
      if (!stats) return;
      if (!stats.isSymbolicLink()) {
        currentPath = candidatePath;
        continue;
      }
      symbolicLinkHops += 1;
      if (symbolicLinkHops > SYMBOLIC_LINK_HOP_LIMIT) {
        this.#problems.push(`${path}: more than ${SYMBOLIC_LINK_HOP_LIMIT} symbolic links`);
        return;
      }
      const linkTarget = this.#readLinkTarget(candidatePath);
      if (linkTarget === undefined) return;
      if (linkTarget.startsWith("/")) currentPath = "/";
      pendingComponents.unshift(...pathComponents(linkTarget));
    }
  }

  // Inspects everything below `directory`. Nothing inside the tree may be a
  // symbolic link: its target lies outside what this walk covers.
  inspectTree(directory) {
    let entryNames;
    try {
      entryNames = this.#readdir(directory);
    } catch (err) {
      this.#problems.push(`${directory}: unreadable (${err.code ?? err.message})`);
      return;
    }
    for (const entryName of [...entryNames].sort()) {
      const entryPath = join(directory, entryName);
      const stats = this.#inspectExistingEntry(entryPath, entryPath, { insideTree: true });
      if (!stats || stats.isSymbolicLink()) continue;
      if (stats.isDirectory()) this.inspectTree(entryPath);
    }
  }

  // Returns the entry's stats after recording its problems, or undefined
  // (with `requestedPath` reported) when it cannot be read.
  #inspectExistingEntry(requestedPath, entryPath, { insideTree = false } = {}) {
    let stats;
    try {
      stats = this.#lstat(entryPath);
    } catch (err) {
      const reason = MISSING_ERROR_CODES.has(err.code) ? "missing" : `unreadable (${err.code ?? err.message})`;
      this.#problems.push(`${requestedPath}: ${reason}`);
      return undefined;
    }
    this.#recordEntryProblems(entryPath, stats, insideTree);
    return stats;
  }

  #recordEntryProblems(entryPath, stats, insideTree) {
    if (this.#inspectedPaths.has(entryPath)) return;
    this.#inspectedPaths.add(entryPath);
    if (insideTree && stats.isSymbolicLink()) {
      this.#problems.push(`${entryPath}: symlink inside the install tree`);
      return;
    }
    if (stats.uid !== this.#ownerUid) {
      this.#problems.push(`${entryPath}: owned by uid ${stats.uid}, not ${this.#expectedOwnerName()}`);
    }
    if (stats.mode & GROUP_WRITE_BIT) this.#problems.push(`${entryPath}: group-writable`);
    if (stats.mode & OTHER_WRITE_BIT) this.#problems.push(`${entryPath}: other-writable`);
  }

  #expectedOwnerName() {
    return this.#ownerUid === 0 ? "root" : `uid ${this.#ownerUid}`;
  }

  #readLinkTarget(linkPath) {
    try {
      return this.#readlink(linkPath);
    } catch (err) {
      this.#problems.push(`${linkPath}: unreadable (${err.code ?? err.message})`);
      return undefined;
    }
  }
}

function pathComponents(path) {
  return path.split("/").filter((component) => component !== "");
}

// The problems on the way from / to `path`, through every symbolic link.
export function pathChainProblems(path, filesystem = {}) {
  const inspector = new TrustInspector(filesystem);
  inspector.inspectPathChain(path);
  inspector.inspectAccessControlLists();
  return inspector.problems;
}

// The problems anywhere below `root`.
export function installTreeProblems(root, filesystem = {}) {
  const inspector = new TrustInspector(filesystem);
  inspector.inspectTree(root);
  inspector.inspectAccessControlLists();
  return inspector.problems;
}

// Every reason the installation cannot be trusted, empty when it can: the
// install root's ancestors, the whole install tree, the node running this
// server, the files the server runs or reads by name, and the system
// executables it relies on.
export function installationProblems(
  { installRoot, configPath, approvalHelperPath, tmuxExecutable },
  { nodeExecutable = process.execPath, ...filesystem } = {},
) {
  const inspector = new TrustInspector(filesystem);
  inspector.inspectPathChain(installRoot);
  inspector.inspectTree(installRoot);
  inspector.inspectPathChain(nodeExecutable);
  for (const path of [configPath, approvalHelperPath, tmuxExecutable]) {
    inspector.inspectPathChain(path);
  }
  for (const path of TRUSTED_SYSTEM_PATHS) inspector.inspectPathChain(path);
  inspector.inspectAccessControlLists();
  return inspector.problems;
}

// The stderr text a production instance prints before it exits over
// `problems`. A configuration the admin has yet to create is named on its own,
// since installing the package again does not create it.
export function refusalText({ installRoot, configPath }, problems) {
  const configurationMissing = `${configPath}: missing`;
  const configurationHint =
    `Create it as root (see README): sudo cp ${join(installRoot, "config.example.json")} ${configPath}`;
  const otherProblems = problems.filter((problem) => problem !== configurationMissing);
  if (otherProblems.length === 0) {
    return [
      `[airlock] refusing to start: the configuration ${configPath} is missing.`,
      configurationHint,
      "",
    ].join("\n");
  }
  const printedProblems = problems.slice(0, PRINTED_PROBLEM_LIMIT).map((problem) => `  ${problem}`);
  if (problems.length > PRINTED_PROBLEM_LIMIT) {
    printedProblems.push(`  and ${problems.length - PRINTED_PROBLEM_LIMIT} more`);
  }
  return [
    `[airlock] refusing to start: the Airlock installation at ${installRoot} fails its trust check.`,
    ...printedProblems,
    "Everything the server trusts must exist, be owned by root, and allow no other user to write it, " +
      "or an agent could replace the approval gate.",
    ...(problems.includes(configurationMissing) ? [`The configuration is missing too. ${configurationHint}`] : []),
    "Install the package (see README), or run a development instance with --dev --config <path> " +
      "--state-dir <path>.",
    "",
  ].join("\n");
}
