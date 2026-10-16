// Airlock — bridge configuration: load and validate ~/.config/airlock/config.json.
//
// The config is the authority for which destinations exist. A missing or
// invalid config is a hard startup error naming that path — the bridge never
// falls back to config.example.json or any built-in inventory.

import { accessSync, constants, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { expandTilde, explicitHostAliases } from "./ssh-config.mjs";

export const CONFIG_PATH = join(homedir(), ".config", "airlock", "config.json");

const DRIVERS = ["shell", "rails_irb"];
// How a target is reached: `ssh` (an explicit Host alias) or `script` (a
// local executable named in the config, run with fixed arguments — typically
// a project's own connection helper such as `bin/shell staging`). Absent
// means ssh, so inventories written before transports existed stay valid.
const TRANSPORTS = ["ssh", "script"];
const DEFAULT_TRANSPORT = "ssh";

// Optional tuning knobs (all top-level, all with defaults). PLAN.md calls the
// overlay timeout, the command safety timeout, and the output cap
// "configurable" without fixing a schema; these names are that schema.
const DEFAULTS = {
  overlay_timeout_seconds: 300,
  command_timeout_seconds: 300,
  open_timeout_seconds: 300,
  output_max_lines: 400,
  output_max_bytes: 65536,
};

export function loadConfig(configPath = CONFIG_PATH) {
  let rawContent;
  try {
    rawContent = readFileSync(configPath, "utf8");
  } catch (err) {
    throw new Error(
      `Airlock config not readable at ${configPath}: ${err.message}. ` +
        `Create it (see config.example.json in the airlock repo) — the bridge never falls back to the example.`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(rawContent);
  } catch (err) {
    throw new Error(`Airlock config at ${configPath} is not valid JSON: ${err.message}`);
  }

  const problems = [];
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`Airlock config at ${configPath} must be a JSON object`);
  }

  if (typeof parsed.ssh_config !== "string" || parsed.ssh_config.trim() === "") {
    problems.push('"ssh_config" must be a non-empty string path');
  }
  if (typeof parsed.instructions !== "string" || parsed.instructions.trim() === "") {
    problems.push('"instructions" must be a non-empty string');
  }
  if (
    parsed.targets === null ||
    typeof parsed.targets !== "object" ||
    Array.isArray(parsed.targets) ||
    Object.keys(parsed.targets ?? {}).length === 0
  ) {
    problems.push('"targets" must be a non-empty object');
  }

  const tuning = {};
  for (const [key, defaultValue] of Object.entries(DEFAULTS)) {
    const value = parsed[key];
    if (value === undefined) {
      tuning[key] = defaultValue;
    } else if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      tuning[key] = value;
    } else {
      problems.push(`"${key}" must be a positive number when present`);
    }
  }

  if (problems.length > 0) {
    throw configError(configPath, problems);
  }

  const targets = {};
  for (const [targetKey, target] of Object.entries(parsed.targets)) {
    targets[targetKey] = validateTarget(targetKey, target, problems);
  }
  if (problems.length > 0) {
    throw configError(configPath, problems);
  }

  // Every ssh_host must resolve to an explicit (non-wildcard) Host alias.
  const sshConfigPath = expandTilde(parsed.ssh_config);
  let aliases;
  try {
    aliases = explicitHostAliases(sshConfigPath);
  } catch (err) {
    throw configError(configPath, [err.message]);
  }
  for (const [targetKey, target] of Object.entries(targets)) {
    if (target.transport === "ssh" && !aliases.has(target.ssh_host)) {
      problems.push(
        `targets.${targetKey}.ssh_host "${target.ssh_host}" is not an explicit Host alias in ${sshConfigPath} ` +
          `(wildcard patterns do not count)`,
      );
    }
  }
  if (problems.length > 0) {
    throw configError(configPath, problems);
  }

  return {
    sshConfigPath,
    instructions: parsed.instructions,
    targets,
    ...tuning,
  };
}

// Returns the target normalized with its transport made explicit (and, for a
// script target, its arguments defaulted and its path expanded); problems
// found are appended, and an unusable target comes back as given.
function validateTarget(targetKey, target, problems) {
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    problems.push(`targets.${targetKey} must be an object`);
    return target;
  }
  // description is Claude-facing discovery data, not decoration.
  for (const field of ["description", "display_command"]) {
    if (typeof target[field] !== "string" || target[field].trim() === "") {
      problems.push(`targets.${targetKey}.${field} must be a non-empty string`);
    }
  }
  if (!DRIVERS.includes(target.driver)) {
    problems.push(`targets.${targetKey}.driver must be one of: ${DRIVERS.join(", ")}`);
  }
  const transport = target.transport ?? DEFAULT_TRANSPORT;
  if (!TRANSPORTS.includes(transport)) {
    problems.push(`targets.${targetKey}.transport must be one of: ${TRANSPORTS.join(", ")}`);
    return target;
  }
  const transportValid =
    transport === "ssh"
      ? validateSshFields(targetKey, target, problems)
      : validateScriptFields(targetKey, target, problems);
  if (target.startup !== undefined) {
    const valid =
      Array.isArray(target.startup) &&
      target.startup.length > 0 &&
      target.startup.every((line) => typeof line === "string" && line.trim() !== "" && !/[\r\n]/.test(line));
    if (!valid) {
      problems.push(`targets.${targetKey}.startup must be a non-empty array of single-line strings`);
      return target;
    }
    // Only the rails_irb driver runs startup lines; accepting them on a
    // shell target would silently drop configured lines the overlay implies
    // will run.
    if (target.driver === "shell") {
      problems.push(
        `targets.${targetKey}.startup is only supported by the rails_irb driver — the shell driver never runs startup lines`,
      );
    }
  }
  const normalized = { ...target, transport };
  if (!transportValid) return normalized;
  if (transport === "script") {
    normalized.args = target.args ?? [];
    normalized.scriptPath = expandTilde(target.script);
  }
  validateDisplayCommandMatchesExecution(targetKey, normalized, problems);
  return normalized;
}

function validateSshFields(targetKey, target, problems) {
  for (const field of ["script", "args"]) {
    if (target[field] !== undefined) {
      problems.push(`targets.${targetKey}.${field} is only supported by the script transport`);
    }
  }
  if (typeof target.ssh_host !== "string" || target.ssh_host.trim() === "") {
    problems.push(`targets.${targetKey}.ssh_host must be a non-empty string`);
    return false;
  }
  return true;
}

// The script is named explicitly (like the SSH config) rather than found on
// the bridge's PATH. Its arguments become argv entries and overlay text:
// single tokens only, so one value can never read as several arguments on
// the approval surface.
function validateScriptFields(targetKey, target, problems) {
  if (target.ssh_host !== undefined) {
    problems.push(`targets.${targetKey}.ssh_host is only supported by the ssh transport`);
  }
  let valid = validateScriptPath(targetKey, target.script, problems);
  if (target.args !== undefined) {
    const argsValid =
      Array.isArray(target.args) && target.args.every((arg) => typeof arg === "string" && /^\S+$/.test(arg));
    if (!argsValid) {
      problems.push(`targets.${targetKey}.args must be an array of non-empty strings without whitespace`);
      valid = false;
    }
  }
  return valid;
}

function validateScriptPath(targetKey, script, problems) {
  if (typeof script !== "string" || script.trim() === "") {
    problems.push(`targets.${targetKey}.script must be a non-empty string path`);
    return false;
  }
  const scriptPath = expandTilde(script);
  if (!isAbsolute(scriptPath)) {
    problems.push(`targets.${targetKey}.script must be an absolute path (got ${JSON.stringify(script)})`);
    return false;
  }
  try {
    if (!statSync(scriptPath).isFile()) throw new Error("not a regular file");
    accessSync(scriptPath, constants.X_OK);
  } catch (err) {
    problems.push(`targets.${targetKey}.script ${scriptPath} is not an executable file: ${err.message}`);
    return false;
  }
  return true;
}

// The overlay is the security surface: what it shows must be what the bridge
// runs, by construction. The bridge executes the transport's command line
// (`ssh <ssh_host>`, or the script with its arguments) followed by the
// startup lines, so display_command must be exactly those lines — nothing
// validated independently can silently diverge.
function validateDisplayCommandMatchesExecution(targetKey, target, problems) {
  if (typeof target.display_command !== "string") return;
  if (target.startup !== undefined && !Array.isArray(target.startup)) return;
  const displayedLines = target.display_command
    .replace(/\n+$/, "")
    .split("\n")
    .map((line) => line.trim());
  const executedLines = [transportCommandLine(target), ...(target.startup ?? []).map((line) => line.trim())];
  const matches =
    displayedLines.length === executedLines.length &&
    displayedLines.every((line, index) => line === executedLines[index]);
  if (!matches) {
    problems.push(
      `targets.${targetKey}.display_command must show exactly what the bridge runs: ` +
        `${JSON.stringify(executedLines.join("\n"))} (the transport's command line, then each startup line)`,
    );
  }
}

// The one line a target's transport contributes to the overlay and the
// inventory: the ssh alias, or the script as configured (tilde and all) with
// its arguments.
export function transportCommandLine(target) {
  if (target.transport === "script") return [target.script, ...target.args].join(" ");
  return `ssh ${target.ssh_host}`;
}

function configError(configPath, problems) {
  return new Error(
    `Airlock config at ${configPath} is invalid:\n- ${problems.join("\n- ")}`,
  );
}
