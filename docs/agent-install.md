# Installing Airlock: instructions for Claude Code

These instructions are for the agent. The person pasted a request to install
Airlock and expects you to guide them through it. Everything you need is
here; the README has the background if they ask for it.

## Ground rules

- The person runs every command that needs `sudo`, because you cannot type
  their password. Print the command in its own `bash` block, say in one line
  what it does, and wait until they say it finished.
- Show every change before applying it: the config as steps 3 and 4
  describe, the settings as a diff. Apply it only after the person agrees.
- Ask one question at a time, in plain words: hosts, consoles, permissions.
  The config file's format is yours to handle; never ask the person about its
  fields.
- Never run `ssh`, `scp`, `sftp`, or `tmux`, and never print the contents of
  the SSH config. List its host names with the command in step 3.
- If a step fails in a way these instructions do not cover, stop, show the
  output, and point the person to the README's
  [Install](../README.md#install) section.

## 1. Check the machine

Airlock needs macOS 26 or later on Apple silicon:

```bash
sw_vers -productVersion
```

```bash
uname -m
```

Stop if the version is below 26 or the machine is not `arm64`.

If `pkgutil --pkg-info com.unabridgedsoftware.airlock` prints a version,
Airlock is installed already: say so and go to step 3.

## 2. Install the package

Check whether the repository is public:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://github.com/unabridged/airlock
```

**Public (`200`) with Homebrew installed:** tap the repository yourself:

```bash
brew tap unabridged/airlock https://github.com/unabridged/airlock
```

Then hand the person the install, which asks for their password:

```bash
brew install --cask unabridged/airlock/airlock
```

**Private (`404`), or no Homebrew:** download the latest package with the
GitHub CLI. If `gh` is missing or `gh auth status` fails, stop and ask the
person to install it and run `gh auth login`. Download into a new, empty
directory and print the package's path:

```bash
download_dir="$(mktemp -d)" && gh release download -R unabridged/airlock -p 'airlock-*.pkg' -D "$download_dir" && ls "$download_dir"/*.pkg
```

Then hand the person the install command with that path:

```bash
sudo installer -pkg /path/to/airlock-X.Y.Z.pkg -target /
```

Any other status code: stop and show it.

Afterwards, confirm `/usr/local/libexec/airlock/bin/airlock-server` exists.
If it does not, the installer refused an unsafe `/usr/local` (a symlink, or a
directory not owned by root): stop and point the person to the README's
[Direct package](../README.md#direct-package) section.

## 3. Choose the hosts

If `~/.config/airlock/config.json` exists, the person ran Airlock from a
checkout before. Ask whether to carry its targets over. If they agree, read
it and rebuild it in step 4's shape: keep its targets, copy `instructions`
from `config.example.json`, and keep its `ssh_config` only if it is
`~/.ssh/config` or the person confirms the other path after you show it. The
agent could have written that file, so in step 4 the person checks every
target, including each script's path and arguments.

Otherwise list the SSH host aliases the way Airlock reads them, following
`Include` lines and skipping wildcard patterns:

```bash
/usr/local/libexec/airlock/runtime/bin/node --input-type=module -e 'import { explicitHostAliases } from "/usr/local/libexec/airlock/src/ssh-config.mjs"; for (const alias of explicitHostAliases(process.argv[1])) console.log(alias)' ~/.ssh/config
```

Ask the person which to install. Check every host by default, except code
hosts such as `github.com`, `gitlab.com`, and `bitbucket.org`, which have no
shell: list those unchecked.

> I found these SSH hosts:
>
> ✅ myapp-staging
> ✅ myapp-production
> ✅ build-server
> ⬜ github.com
>
> Which ones do we want to install?

If an alias does not make clear which app and environment it is, ask in
plain words, for example "Which app is build-server, and is it staging or
production?" Never guess an environment.

Then ask once whether any of the chosen hosts runs a Rails app they want a
console on, and for each one, the app's directory on the server. The console
runs `bin/rails console` there unless they name another command.

If the SSH config does not exist or lists no hosts, ask whether they reach
their servers through a local connection script instead, such as an app's
`bin/shell staging`. If a person mentions such a script at any point, take its
absolute path and arguments, and read the script to learn what it runs
underneath (for example `aws ecs execute-command`), for step 6. With neither
hosts nor scripts, stop: Airlock has nothing to connect to.

## 4. Write the config

Each chosen host becomes a shell target, and each console host also gets a
console target. Build the file in this shape, copying `instructions`
verbatim from `/usr/local/libexec/airlock/config.example.json`:

```json
{
  "ssh_config": "~/.ssh/config",
  "instructions": "<copied from config.example.json>",
  "targets": {
    "myapp-staging-shell": {
      "description": "MyApp staging shell (SSH host myapp-staging)",
      "ssh_host": "myapp-staging",
      "display_command": "ssh myapp-staging",
      "driver": "shell"
    },
    "myapp-staging-console": {
      "description": "MyApp staging Rails console (SSH host myapp-staging)",
      "ssh_host": "myapp-staging",
      "startup": ["cd /srv/myapp/current", "bin/rails console"],
      "display_command": "ssh myapp-staging\ncd /srv/myapp/current\nbin/rails console",
      "driver": "rails_irb"
    },
    "myapi-staging-shell": {
      "description": "MyAPI staging shell (connection script)",
      "transport": "script",
      "script": "~/src/myapi/bin/shell",
      "args": ["staging"],
      "display_command": "~/src/myapi/bin/shell staging",
      "driver": "shell"
    }
  }
}
```

Rules for the file. The server validates all of them except the naming and
the description's wording:

- Name targets `<app>-<environment>-shell` and
  `<app>-<environment>-console`, in lowercase. A host with no environment,
  such as a build server, is `<host>-shell`. The approval overlay shows only
  the target name and `display_command`, so a production target's name must
  say production.
- `description` is how Claude chooses a target later: name the app, the
  environment, and whether it is a shell or a Rails console.
- `ssh_host` is the alias exactly as listed in step 3.
- `display_command` is exactly the `ssh <alias>` line (or the script with its
  arguments), then each `startup` line, joined with `\n`.
- `startup` lines belong only to `rails_irb` targets; a shell target has none.
- A script target's `script` is an absolute path (`~` allowed) to an
  executable, and each of its `args` is a single word without spaces.
- `ssh_config` is `~/.ssh/config` even with no SSH targets, and that file has
  to exist: if it does not, have the person create it empty with
  `mkdir -p ~/.ssh && touch ~/.ssh/config`.

Write the file to a new temporary path and validate it until the command
prints nothing:

```bash
/usr/local/libexec/airlock/runtime/bin/node --input-type=module -e 'import { loadConfig } from "/usr/local/libexec/airlock/src/config.mjs"; loadConfig(process.argv[1])' /path/to/draft.json
```

Show the person a short table of the targets, with each one's name,
description, and what it runs (its `display_command`), rather than the JSON,
unless they ask for it. If `/usr/local/libexec/airlock/config.json` already
exists, say what changes compared with it. Then hand them the install
command:

```bash
sudo install -m 644 -o root -g wheel /path/to/draft.json /usr/local/libexec/airlock/config.json
```

## 5. Register the server

Run `claude mcp get airlock`, using `"$CLAUDE_CODE_EXECPATH"` in place of
`claude` when `claude` is not on the `PATH`.

If an `airlock` registration exists, keep it only if it is user scope, runs
exactly `/usr/local/libexec/airlock/bin/airlock-server`, and has no arguments
and no environment variables; then skip the add below. Otherwise show it
and, once the person agrees, remove it with
`claude mcp remove --scope <its scope> airlock`.

Register the installed server:

```bash
claude mcp add --scope user airlock -- /usr/local/libexec/airlock/bin/airlock-server
```

Run `claude mcp get airlock` again and report its status. Its health check
starts the server, which reads `~/.ssh/config`; if it fails to connect inside
a sandbox, rerun it outside the sandbox with the person's approval, or have
them run it in their terminal.

## 6. Restrict direct SSH

Ask the person, as its own question:

> Should Claude be blocked from running SSH directly, so that remote access
> goes through Airlock's approvals?
>
> - Yes, use the SSH bridge.
> - No, keep existing permissions.

On "No", change nothing and go to step 7.

On "Yes", add these rules to `permissions.deny` in the person's Claude Code
user settings, `${CLAUDE_CONFIG_DIR:-~/.claude}/settings.json`, creating the
file or the list if needed. Keep every existing setting and rule, skip rules
already present, and show the diff before writing it:

```json
[
  "Bash(ssh:*)",
  "Bash(scp:*)",
  "Bash(sftp:*)",
  "Bash(tmux:*)",
  "Bash(/usr/bin/ssh:*)",
  "Bash(/usr/bin/scp:*)",
  "Bash(/usr/bin/sftp:*)",
  "Bash(/opt/homebrew/bin/tmux:*)",
  "Bash(/usr/local/bin/tmux:*)",
  "Bash(/usr/local/libexec/airlock/runtime/bin/tmux:*)",
  "Read(~/.ssh/**)",
  "Edit(~/.ssh/**)",
  "Read(~/.aws/**)",
  "Edit(~/.aws/**)",
  "Read(~/.local/state/airlock/**)",
  "Edit(~/.local/state/airlock/**)"
]
```

For each script target, also deny editing the script, the commands it runs
underneath, and running the script as it would be typed: with `~`, with its
absolute path, and relative to its project:

```json
[
  "Bash(~/src/myapi/bin/shell:*)",
  "Bash(/Users/me/src/myapi/bin/shell:*)",
  "Bash(bin/shell:*)",
  "Bash(./bin/shell:*)",
  "Edit(~/src/myapi/bin/shell)",
  "Bash(aws ecs execute-command:*)",
  "Bash(session-manager-plugin:*)"
]
```

Tell the person in one sentence that these rules are policy: only Claude
Code's sandbox actually cuts off the hosts, as the README's
[Block the direct path](../README.md#block-the-direct-path) section explains.

## 7. Finish

Tell the person, briefly:

- which targets are configured, and that the config lives in
  `/usr/local/libexec/airlock/config.json`;
- whether direct SSH is now blocked;
- that the Airlock tools appear in their next Claude Code session;
- that `/usr/local/libexec/airlock/bin/airlock-attach`, run in a terminal,
  shows the live session while Claude works in it.
