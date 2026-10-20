// Airlock — launch options: which instance this server is, and where it
// reads and writes.
//
// A production instance (no flags) trusts only its root-owned install: the
// config, approval helper, tmux, and attach client all sit inside the install
// root, and the state directory is the one under the user's home. A
// development instance (--dev) runs from a checkout and must name its config
// and state directory explicitly, so it can never pick up the production
// config or share the production lock, tmux socket, or session file.
//
// The paths come from argv alone. AIRLOCK_CONFIG, AIRLOCK_STATE_DIR, and
// AIRLOCK_APPROVE_HELPER are refused outright, since a writable launch
// environment could otherwise point the production server at an attacker's
// helper.

import { existsSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { defaultTmuxExecutable, shellQuote, STATE_DIRECTORY } from "./tmux.mjs";

// The directory containing src/: the install root of a package, or the
// checkout root of a development instance.
export const INSTALL_ROOT = realpathSync(fileURLToPath(new URL("..", import.meta.url)));

export const USAGE_TEXT =
  "usage: airlock-server [--dev --config PATH --state-dir PATH [--approval-helper PATH]]";

const OPTION_DEFINITIONS = {
  dev: { type: "boolean" },
  config: { type: "string" },
  "state-dir": { type: "string" },
  "approval-helper": { type: "string" },
};

const DEV_ONLY_OPTIONS = ["config", "state-dir", "approval-helper"];

const RETIRED_ENVIRONMENT_VARIABLES = {
  AIRLOCK_CONFIG: "--config",
  AIRLOCK_STATE_DIR: "--state-dir",
  AIRLOCK_APPROVE_HELPER: "--approval-helper",
};

// The bundled tmux's ncurses searches $TERMINFO before ~/.terminfo,
// $TERMINFO_DIRS, and its own Homebrew prefix, all writable by the user. The
// bridge's own tmux calls read no terminal description; the attach scripts
// set TERMINFO too and fall back to a TERM it holds, so their lookup ends in
// the system database.
const BUNDLED_TMUX_ENVIRONMENT = Object.freeze({ TERMINFO: "/usr/share/terminfo" });

// Characters a shell reads literally, so a word made only of them needs no
// quoting in the attach command line the model relays.
const SHELL_SAFE_WORD = /^[A-Za-z0-9_\/.,:@%+=-]+$/;

export class UsageError extends Error {}

// Returns the frozen launch options for `argv` (process.argv without node and
// the script), throwing {UsageError} for anything the server must refuse.
export function parseLaunchOptions(
  argv,
  {
    environment = process.env,
    installRoot = INSTALL_ROOT,
    productionStateDirectory = STATE_DIRECTORY,
  } = {},
) {
  rejectRetiredEnvironmentVariables(environment);
  const values = parseArgvStrictly(argv);
  if (!values.dev) {
    const devOnlyOption = DEV_ONLY_OPTIONS.find((option) => values[option] !== undefined);
    if (devOnlyOption) throw new UsageError(`--${devOnlyOption} requires --dev`);
    return productionOptions(installRoot, productionStateDirectory);
  }
  return developmentOptions(values, installRoot, productionStateDirectory);
}

function rejectRetiredEnvironmentVariables(environment) {
  const messages = Object.entries(RETIRED_ENVIRONMENT_VARIABLES)
    .filter(([variable]) => environment[variable] !== undefined)
    .map(
      ([variable, flag]) =>
        `${variable} is no longer supported; pass ${flag} instead (it requires --dev)`,
    );
  if (messages.length > 0) throw new UsageError(messages.join("; "));
}

function parseArgvStrictly(argv) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTION_DEFINITIONS, strict: true, allowPositionals: false });
  } catch (err) {
    throw new UsageError(err.message);
  }
  for (const option of DEV_ONLY_OPTIONS) {
    if (parsed.values[option] === "") throw new UsageError(`--${option} requires a path`);
  }
  return parsed.values;
}

function productionOptions(installRoot, productionStateDirectory) {
  return Object.freeze({
    dev: false,
    installRoot,
    configPath: join(installRoot, "config.json"),
    stateDirectory: productionStateDirectory,
    approvalHelperPath: join(installRoot, "bin", "airlock-approve"),
    tmuxExecutable: join(installRoot, "runtime", "bin", "tmux"),
    tmuxEnvironment: BUNDLED_TMUX_ENVIRONMENT,
    attachCommandLine: attachWord(join(installRoot, "bin", "airlock-attach")),
  });
}

// Relative paths resolve against the checkout, never the working directory:
// a client may spawn the server from anywhere.
function developmentOptions(values, installRoot, productionStateDirectory) {
  for (const option of ["config", "state-dir"]) {
    if (values[option] === undefined) throw new UsageError(`--dev requires --${option} <path>`);
  }
  const stateDirectory = resolve(installRoot, values["state-dir"]);
  if (sameDirectory(stateDirectory, productionStateDirectory)) {
    throw new UsageError(
      `--state-dir ${stateDirectory} is the production state directory; a development ` +
        `instance must never share its lock, tmux socket, or session file`,
    );
  }
  const attachClientPath = join(installRoot, "bin", "airlock-attach");
  return Object.freeze({
    dev: true,
    installRoot,
    configPath: resolve(installRoot, values.config),
    stateDirectory,
    approvalHelperPath: resolve(installRoot, values["approval-helper"] ?? join("bin", "airlock-approve")),
    tmuxExecutable: defaultTmuxExecutable(),
    tmuxEnvironment: Object.freeze({}),
    attachCommandLine: `${attachWord(attachClientPath)} --state-dir ${attachWord(stateDirectory)}`,
  });
}

function attachWord(word) {
  return SHELL_SAFE_WORD.test(word) ? word : shellQuote(word);
}

// Compares where the two paths land on disk, not how they are spelled: a
// symlinked parent or a case variant (APFS is case-insensitive by default)
// reaches the same directory.
function sameDirectory(firstDirectory, secondDirectory) {
  return (
    canonicalPathForComparison(firstDirectory) === canonicalPathForComparison(secondDirectory)
  );
}

// Resolves the longest existing prefix of the path through realpath, keeps
// the components that do not exist yet as spelled, and folds case.
function canonicalPathForComparison(directory) {
  const missingComponents = [];
  let existingPrefix = resolve(directory);
  while (!existsSync(existingPrefix) && dirname(existingPrefix) !== existingPrefix) {
    missingComponents.unshift(basename(existingPrefix));
    existingPrefix = dirname(existingPrefix);
  }
  return join(realpathSync(existingPrefix), ...missingComponents).toLowerCase();
}
