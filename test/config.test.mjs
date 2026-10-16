// Airlock — config and SSH-config validation tests (node --test).
// Zero-dependency: node:test + node:assert only.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

import { loadConfig } from "../src/config.mjs";
import { explicitHostAliases } from "../src/ssh-config.mjs";

const scratch = mkdtempSync(join(tmpdir(), "airlock-config-test-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

function writeFile(name, content) {
  const filePath = join(scratch, name);
  writeFileSync(filePath, content);
  return filePath;
}

// A stand-in for a connection script: validation only checks for an
// executable file.
function writeExecutable(name) {
  const filePath = join(scratch, name);
  writeFileSync(filePath, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  return filePath;
}

let fixtureCounter = 0;
function writeConfig(configObject) {
  fixtureCounter += 1;
  return writeFile(`config-${fixtureCounter}.json`, JSON.stringify(configObject));
}

function baseConfig(overrides = {}) {
  const sshConfigPath = writeFile(
    `ssh-config-${(fixtureCounter += 1)}`,
    "Host alpha beta\nHost *\nHost *.example.com\n",
  );
  return {
    ssh_config: sshConfigPath,
    instructions: "Test instructions.",
    targets: {
      "alpha-shell": {
        description: "Alpha shell",
        display_command: "ssh alpha",
        ssh_host: "alpha",
        driver: "shell",
      },
    },
    ...overrides,
  };
}

describe("loadConfig — the real example inventory", () => {
  it("passes validation for all 6 example targets against a matching ssh config and script", () => {
    // The example references myapp aliases and a myapi connection script;
    // validate the real file's shape against an ssh config that declares the
    // aliases and a stand-in executable in place of the script.
    const exampleConfig = JSON.parse(
      readFileSync(new URL("../config.example.json", import.meta.url), "utf8"),
    );
    exampleConfig.ssh_config = writeFile(
      "ssh-config-example",
      "Host myapp\nHost myapp-s\n",
    );
    const scriptPath = writeExecutable("myapi-shell-example");
    for (const target of Object.values(exampleConfig.targets)) {
      if (target.transport !== "script") continue;
      target.display_command = target.display_command.replace(target.script, scriptPath);
      target.script = scriptPath;
    }
    const config = loadConfig(writeConfig(exampleConfig));
    assert.equal(Object.keys(config.targets).length, 6);
    assert.ok(config.instructions.length > 0);
    assert.deepEqual(
      Object.values(config.targets).map((target) => target.transport),
      ["ssh", "ssh", "ssh", "ssh", "script", "script"],
    );
  });
});

describe("loadConfig — errors name the config path and the problem", () => {
  it("errors on a missing file, naming the path and never falling back", () => {
    const missingPath = join(scratch, "missing", "config.json");
    assert.throws(
      () => loadConfig(missingPath),
      (err) =>
        err.message.includes(missingPath) && err.message.includes("never falls back to the example"),
    );
  });

  it("errors on invalid JSON, naming the path", () => {
    const brokenPath = writeFile("broken.json", "{ nope");
    assert.throws(
      () => loadConfig(brokenPath),
      (err) => err.message.includes(brokenPath) && /not valid JSON/.test(err.message),
    );
  });

  it("errors on a non-object top level", () => {
    assert.throws(() => loadConfig(writeFile("array.json", "[1,2]")), /must be a JSON object/);
  });

  it("errors on missing instructions and empty targets", () => {
    const config = baseConfig({ instructions: "", targets: {} });
    assert.throws(
      () => loadConfig(writeConfig(config)),
      (err) =>
        /"instructions" must be a non-empty string/.test(err.message) &&
        /"targets" must be a non-empty object/.test(err.message),
    );
  });

  it("errors on a missing target description", () => {
    const config = baseConfig();
    delete config.targets["alpha-shell"].description;
    assert.throws(
      () => loadConfig(writeConfig(config)),
      /targets\.alpha-shell\.description must be a non-empty string/,
    );
  });

  it("errors on an unknown driver", () => {
    const config = baseConfig();
    config.targets["alpha-shell"].driver = "expect";
    assert.throws(() => loadConfig(writeConfig(config)), /driver must be one of: shell, rails_irb/);
  });

  it("errors on an ssh_host with no Host stanza at all", () => {
    const config = baseConfig();
    config.targets["alpha-shell"].ssh_host = "gamma";
    config.targets["alpha-shell"].display_command = "ssh gamma";
    assert.throws(() => loadConfig(writeConfig(config)), /not an explicit Host alias/);
  });

  it("rejects an ssh_host matched only by a wildcard stanza", () => {
    // `Host *` and `Host *.example.com` exist, but wildcards never count as
    // selectable destinations.
    const config = baseConfig();
    config.targets["alpha-shell"].ssh_host = "prod.example.com";
    config.targets["alpha-shell"].display_command = "ssh prod.example.com";
    assert.throws(
      () => loadConfig(writeConfig(config)),
      /wildcard patterns do not count/,
    );
  });

  it("rejects a literal wildcard ssh_host", () => {
    const config = baseConfig();
    config.targets["alpha-shell"].ssh_host = "*";
    config.targets["alpha-shell"].display_command = "ssh *";
    assert.throws(() => loadConfig(writeConfig(config)), /not an explicit Host alias/);
  });

  it("rejects startup lines containing newlines", () => {
    const config = baseConfig();
    config.targets["alpha-console"] = {
      description: "Alpha console",
      display_command: "ssh alpha\ncd app\nbin/rails console",
      ssh_host: "alpha",
      startup: ["cd app\nrm -rf /", "bin/rails console"],
      driver: "rails_irb",
    };
    assert.throws(
      () => loadConfig(writeConfig(config)),
      /startup must be a non-empty array of single-line strings/,
    );
  });

  it("rejects non-positive tuning values", () => {
    const config = baseConfig({ overlay_timeout_seconds: 0 });
    assert.throws(
      () => loadConfig(writeConfig(config)),
      /"overlay_timeout_seconds" must be a positive number/,
    );
  });
});

describe("loadConfig — the script transport", () => {
  function scriptTarget(scriptPath, overrides = {}) {
    return {
      description: "Hub staging shell",
      transport: "script",
      script: scriptPath,
      args: ["staging"],
      display_command: `${scriptPath} staging`,
      driver: "shell",
      ...overrides,
    };
  }

  // Returns [config, scriptPath]: a base config plus one script target
  // backed by a fresh stand-in executable.
  function scriptConfig(overrides = {}) {
    const scriptPath = writeExecutable(`shell-${(fixtureCounter += 1)}`);
    const config = baseConfig();
    config.targets["api-staging-shell"] = scriptTarget(scriptPath, overrides);
    return [config, scriptPath];
  }

  it("defaults the transport of every target to ssh and resolves the script", () => {
    const [config, scriptPath] = scriptConfig();
    const loaded = loadConfig(writeConfig(config));
    assert.equal(loaded.targets["alpha-shell"].transport, "ssh");
    const target = loaded.targets["api-staging-shell"];
    assert.equal(target.transport, "script");
    assert.equal(target.script, scriptPath);
    assert.equal(target.scriptPath, scriptPath);
    assert.deepEqual(target.args, ["staging"]);
  });

  it("defaults args to none, with display_command then just the script", () => {
    const [config, scriptPath] = scriptConfig();
    delete config.targets["api-staging-shell"].args;
    config.targets["api-staging-shell"].display_command = scriptPath;
    assert.deepEqual(loadConfig(writeConfig(config)).targets["api-staging-shell"].args, []);
  });

  it("expands a leading tilde in script and reports the expanded path", () => {
    const [config] = scriptConfig({ script: "~/no-such-airlock-script" });
    assert.throws(
      () => loadConfig(writeConfig(config)),
      new RegExp(`script ${join(homedir(), "no-such-airlock-script")} is not an executable file`),
    );
  });

  it("accepts a rails_irb script target whose display shows the startup line after the script", () => {
    const [config, scriptPath] = scriptConfig({ startup: ["bin/rails console"], driver: "rails_irb" });
    config.targets["api-staging-shell"].display_command = `${scriptPath} staging\nbin/rails console`;
    assert.deepEqual(loadConfig(writeConfig(config)).targets["api-staging-shell"].startup, ["bin/rails console"]);
  });

  it("rejects a script that is relative, missing, or not executable", () => {
    assert.throws(
      () => loadConfig(writeConfig(scriptConfig({ script: "bin/shell" })[0])),
      /script must be an absolute path/,
    );
    assert.throws(
      () => loadConfig(writeConfig(scriptConfig({ script: join(scratch, "no-such-shell") })[0])),
      /script .* is not an executable file/,
    );
    assert.throws(
      () => loadConfig(writeConfig(scriptConfig({ script: writeFile("shell-plain", "not executable") })[0])),
      /script .* is not an executable file/,
    );
    assert.throws(() => loadConfig(writeConfig(scriptConfig({ script: "" })[0])), /script must be a non-empty string/);
  });

  it("rejects an unknown transport", () => {
    assert.throws(
      () => loadConfig(writeConfig(scriptConfig({ transport: "kubectl" })[0])),
      /transport must be one of: ssh, script/,
    );
  });

  it("requires every arg to be a single whitespace-free token", () => {
    assert.throws(
      () => loadConfig(writeConfig(scriptConfig({ args: ["staging", ""] })[0])),
      /args must be an array of non-empty strings without whitespace/,
    );
    assert.throws(
      () => loadConfig(writeConfig(scriptConfig({ args: ["staging worker"] })[0])),
      /args must be an array of non-empty strings without whitespace/,
    );
    assert.throws(
      () => loadConfig(writeConfig(scriptConfig({ args: "staging" })[0])),
      /args must be an array of non-empty strings without whitespace/,
    );
  });

  it("rejects transport-foreign fields on either kind of target", () => {
    assert.throws(
      () => loadConfig(writeConfig(scriptConfig({ ssh_host: "alpha" })[0])),
      /ssh_host is only supported by the ssh transport/,
    );
    const [config] = scriptConfig();
    config.targets["alpha-shell"].script = "/bin/sh";
    config.targets["alpha-shell"].args = [];
    assert.throws(() => loadConfig(writeConfig(config)), /script is only supported by the script transport/);
    assert.throws(() => loadConfig(writeConfig(config)), /args is only supported by the script transport/);
  });

  it("requires display_command to show the script and its arguments exactly", () => {
    const [withoutArgs, scriptPath] = scriptConfig();
    withoutArgs.targets["api-staging-shell"].display_command = scriptPath;
    assert.throws(
      () => loadConfig(writeConfig(withoutArgs)),
      /display_command must show exactly what the bridge runs/,
    );
    const [wrongEnvironment] = scriptConfig({ args: ["production"] });
    assert.throws(
      () => loadConfig(writeConfig(wrongEnvironment)),
      /display_command must show exactly what the bridge runs: "[^"]*shell-\d+ production"/,
    );
  });
});

describe("loadConfig — duplicate handling (PLAN v2: keys are the selectors)", () => {
  it("accepts duplicate display_command values across targets", () => {
    // v2 superseded duplicate-display rejection: selection is by target key,
    // unique by JSON construction, and the overlay renders the resolved
    // display_command regardless of what selected it.
    const config = baseConfig();
    config.targets["alpha-shell-again"] = { ...config.targets["alpha-shell"] };
    const loaded = loadConfig(writeConfig(config));
    assert.deepEqual(Object.keys(loaded.targets), ["alpha-shell", "alpha-shell-again"]);
  });
});

describe("explicitHostAliases", () => {
  it("collects multi-name Host lines and the Host=name form", () => {
    const sshConfigPath = writeFile(
      "ssh-multi",
      "Host one two three\nHost=four\nhost five\n# Host commented\n",
    );
    assert.deepEqual(
      [...explicitHostAliases(sshConfigPath)].sort(),
      ["five", "four", "one", "three", "two"],
    );
  });

  it("excludes wildcard, ?-pattern, and negated names", () => {
    const sshConfigPath = writeFile(
      "ssh-wild",
      "Host *\nHost *.example.com\nHost web?\nHost !prod real\n",
    );
    assert.deepEqual([...explicitHostAliases(sshConfigPath)], ["real"]);
  });

  it("follows Include directives", () => {
    const includeDirectory = join(scratch, "ssh-includes");
    mkdirSync(includeDirectory, { recursive: true });
    writeFileSync(join(includeDirectory, "extra"), "Host included-host\n");
    const sshConfigPath = writeFile(
      "ssh-with-include",
      `Include ${join(includeDirectory, "extra")}\nHost direct-host\n`,
    );
    assert.deepEqual(
      [...explicitHostAliases(sshConfigPath)].sort(),
      ["direct-host", "included-host"],
    );
  });

  it("errors clearly when the ssh config itself is missing", () => {
    assert.throws(
      () => explicitHostAliases(join(scratch, "no-such-ssh-config")),
      /Cannot read SSH config/,
    );
  });
});
