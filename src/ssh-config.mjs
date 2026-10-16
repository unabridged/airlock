// Airlock — SSH config parsing, just enough to validate destinations.
//
// The bridge only ever needs one question answered: is a configured
// `ssh_host` an EXPLICIT Host alias in the user's SSH config? Wildcard or
// negated patterns (`*`, `?`, `!…`) are never selectable destinations.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join } from "node:path";

const MAX_INCLUDE_DEPTH = 8;

export function expandTilde(path) {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return join(homedir(), path.slice(2));
  return path;
}

// Returns the Set of explicit (non-wildcard, non-negated) Host aliases found
// in the SSH config at `sshConfigPath`, following Include directives.
export function explicitHostAliases(sshConfigPath) {
  const aliases = new Set();
  collectHostAliases(expandTilde(sshConfigPath), aliases, 0);
  return aliases;
}

function collectHostAliases(filePath, aliases, depth) {
  if (depth > MAX_INCLUDE_DEPTH) {
    throw new Error(`SSH config Include nesting exceeds ${MAX_INCLUDE_DEPTH} levels at ${filePath}`);
  }

  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (err) {
    throw new Error(`Cannot read SSH config ${filePath}: ${err.message}`);
  }

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;

    // "Host a b c" and "Host=a" are both valid ssh_config syntax.
    const match = line.match(/^(\w+)\s*[=\s]\s*(.*)$/);
    if (!match) continue;
    const keyword = match[1].toLowerCase();
    const value = match[2].trim();

    if (keyword === "host") {
      for (const name of splitConfigValue(value)) {
        if (isExplicitAlias(name)) aliases.add(name);
      }
    } else if (keyword === "include") {
      for (const includePattern of splitConfigValue(value)) {
        for (const includedPath of resolveIncludePattern(includePattern, dirname(filePath))) {
          collectHostAliases(includedPath, aliases, depth + 1);
        }
      }
    }
  }
}

function splitConfigValue(value) {
  // Values may be double-quoted to embed spaces ("Host \"a b\"").
  const names = [];
  const pattern = /"([^"]*)"|(\S+)/g;
  let match;
  while ((match = pattern.exec(value)) !== null) {
    names.push(match[1] ?? match[2]);
  }
  return names;
}

function isExplicitAlias(name) {
  return name !== "" && !name.includes("*") && !name.includes("?") && !name.startsWith("!");
}

// Per ssh_config(5): unqualified Include paths are relative to ~/.ssh, and
// may contain glob wildcards. Only basename-level `*` globs are supported
// (this machine has zero Includes, so this is not on the critical path);
// a missing non-glob include is skipped, matching ssh's own leniency.
function resolveIncludePattern(includePattern, currentDirectory) {
  let expanded = expandTilde(includePattern);
  if (!isAbsolute(expanded)) {
    expanded = join(join(homedir(), ".ssh"), expanded);
  }

  if (!expanded.includes("*")) {
    return fileExists(expanded) ? [expanded] : [];
  }

  const directory = dirname(expanded);
  const namePattern = basename(expanded);
  if (directory.includes("*")) {
    throw new Error(`Unsupported SSH config Include glob (wildcard directory): ${includePattern}`);
  }
  const nameRegex = new RegExp(
    `^${namePattern.split("*").map(escapeRegExp).join(".*")}$`,
  );
  let entries;
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries
    .filter((entry) => nameRegex.test(entry))
    .map((entry) => join(directory, entry))
    .filter(fileExists)
    .sort();
}

function fileExists(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
