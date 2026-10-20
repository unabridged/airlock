# Manual install

These steps install Airlock by hand. To have Claude Code walk you through them
instead, paste the prompt from the [README](../README.md#install).

You need macOS 26 (Tahoe) or later on Apple silicon, an admin account
(installing and editing the config need `sudo`), and Claude Code.

1. [Install the package](#install-the-package).
2. [Configure the targets](#configure-the-targets).
3. [Register the server](#register-the-server).
4. [Block the direct path](#block-the-direct-path).
5. [Tell Claude when to use it](#tell-claude-when-to-use-it).

## Install the package

Airlock installs as a macOS package into `/usr/local/libexec/airlock`, owned by
root, with its own Node and tmux ([why](#why-root-owned)). The package declares
the newest minimum macOS among the binaries it bundles, and the tmux libraries
it copies from the build machine's Homebrew (ncurses in particular) are built
for macOS 26. The installer enforces that minimum, and the cask declares the
same one, so Homebrew refuses an older macOS before it downloads anything.

### Homebrew

The repository doubles as a Homebrew tap:

```bash
brew tap unabridged/airlock https://github.com/unabridged/airlock
```

```bash
brew install --cask unabridged/airlock/airlock
```

### Direct package

Download the package from the
[latest release](https://github.com/unabridged/airlock/releases/latest) and
install it, replacing `X.Y.Z` with the release version:

```bash
curl -fLO https://github.com/unabridged/airlock/releases/download/vX.Y.Z/airlock-X.Y.Z.pkg
```

```bash
sudo installer -pkg airlock-X.Y.Z.pkg -target /
```

The installer installs only on the startup volume. It changes nothing when
`/usr`, `/usr/local`, `/usr/local/libexec`, or the install directory is a
symlink, is not a root-owned directory closed to group and other writes (such
as a `/usr/local` an older Homebrew handed to your user), or has an access
control list entry that allows changing it.

To build the package yourself, see
[Install from source](development.md#install-from-source).

## Configure the targets

The targets live in `/usr/local/libexec/airlock/config.json`, which the package
never ships or overwrites. Until it exists the server refuses to start, reports
it missing, and prints the command below. Start from the shipped example:

```bash
sudo cp /usr/local/libexec/airlock/config.example.json /usr/local/libexec/airlock/config.json
```

Edit it with `sudo -e`, which runs your editor as you on a temporary copy and
writes the result back as root:

```bash
sudo -e /usr/local/libexec/airlock/config.json
```

The file is root-owned on purpose: it names the hosts and programs every
approval reaches, so whatever can rewrite it can redirect an approved command.

A target is reached either over SSH, through an explicit `Host` alias from your
SSH config, or by running a local connection script, such as a project's
`bin/shell staging` that wraps `aws ecs execute-command` into a Fargate task.
The example has both kinds. The top level of the file holds:

- `ssh_config`: the SSH config whose aliases the SSH targets name, usually
  `~/.ssh/config`. The file has to exist, even when no target uses SSH.
- `instructions`: what the server tells Claude about Airlock at the start of
  every session. Keep the example's text unless you mean to change that.
- `targets`: the targets, keyed by name. The approval overlay shows only the
  name and `display_command`, so name each target after its app and
  environment, such as `myapp-production-console`.
- Optionally, `overlay_timeout_seconds` (300) limits how long the overlay
  waits for an answer. `open_timeout_seconds` (300) limits how long the bridge
  waits for each step of opening a session, and `command_timeout_seconds`
  (300) how long it waits for each line of a command to finish. A timed-out
  command keeps running, and the session stays open for `interrupt_terminal`.
  `output_max_lines` (400) and `output_max_bytes` (65536) cap the output a
  command returns to Claude.

Each target holds:

- `description`: how Claude chooses a target from `list_targets`. Name the app,
  the environment, and whether it is a shell or a Rails console.
- `driver`: `shell` for a shell, or `rails_irb` for a Rails console.
- `ssh_host`, for an SSH target: an explicit `Host` alias in `ssh_config`.
  Wildcard patterns do not count.
- `"transport": "script"`, for a script target, with `script`, an absolute path
  (`~` allowed) to an executable, and `args`, each a single word without
  whitespace.
- `startup`, for a `rails_irb` target only: the lines typed once the connection
  opens, such as `cd /srv/myapp/current` and then `bin/rails console`.
- `display_command`: exactly what the bridge runs, one line each: the
  `ssh <alias>` line or the script with its arguments, then each startup line.

The server refuses to start on a config it cannot fully validate. To check the
file after editing it, run the validator. It checks in stages and lists the
problems of the first stage that fails, so fix them and rerun it until it
prints nothing:

```bash
/usr/local/libexec/airlock/runtime/bin/node --input-type=module -e 'import { loadConfig } from "/usr/local/libexec/airlock/src/config.mjs"; loadConfig(process.argv[1])' /usr/local/libexec/airlock/config.json
```

Root ownership covers this file only. The SSH config and the scripts it points
at stay yours, writable by you and so by the agent, and remain trusted code:
the overlay shows the alias or the script line, not what they do. Keep them out
of the agent's reach ([SECURITY.md](../SECURITY.md), finding 5).

## Register the server

Register the installed server user-scope as MCP server `airlock`:

```bash
claude mcp add --scope user airlock -- /usr/local/libexec/airlock/bin/airlock-server
```

Its tools appear in your next Claude Code session. Leave `MCP_TOOL_TIMEOUT`
unset: Claude Code's default is far larger than the overlay window plus
command runtime, and a well-meaning short value would cut approvals off.

### Managed registration (optional)

The user-scope registration lives in `~/.claude.json`, which the agent can
rewrite as easily as you can. An admin can register the server in Claude Code's
managed MCP file instead, which only an administrator can write:

```bash
sudo mkdir -p "/Library/Application Support/ClaudeCode"
```

```bash
sudo -e "/Library/Application Support/ClaudeCode/managed-mcp.json"
```

```json
{
  "mcpServers": {
    "airlock": {
      "type": "stdio",
      "command": "/usr/local/libexec/airlock/bin/airlock-server"
    }
  }
}
```

**This file takes exclusive control of MCP.** While it exists, Claude Code
loads only the servers it lists: user, project, local, plugin, and
`--mcp-config` servers stop loading, `claude mcp add` refuses to add any, and
claude.ai connectors and Claude in Chrome stay off unless managed settings
allow them. Use it only when every MCP server you need can live in that file.
It protects the registration only; the `env` block in your user settings stays
yours ([SECURITY.md](../SECURITY.md), threat model assumption 2).

## Block the direct path

Airlock only gates commands that go through Airlock. The agent's sandbox and
permission rules must make every other route to the hosts fail, or the
approvals are decorative:

- deny `ssh`/`scp`/`sftp` and `tmux` from local Bash, including absolute-path
  forms;
- for script targets, deny the scripts themselves, whatever they wrap (such as
  `aws ecs execute-command` and `session-manager-plugin`), and edits to the
  scripts;
- deny reads of `~/.ssh` and `~/.aws`, and keep the SSH agent socket and
  Airlock's tmux socket out of any Unix-socket allowlist;
- deny reads and writes of the state directory `~/.local/state/airlock`, and
  writes that rename or replace it in `~/.local/state`: the bridge follows a
  symlink or a substitute directory at that path. It holds the tmux socket, the
  lock, the session file, the closed session's final screen, and the
  `watch.command` script the overlay's watch button opens in a terminal. The
  bridge runs as you, so the directory is necessarily writable by you, and only
  the sandbox keeps the agent out;
- deny network egress to the target hosts at the sandbox level, and test it: a
  sandboxed connection attempt to a configured host must fail.

For the example config's targets, the permission rules in your Claude Code user
settings (`~/.claude/settings.json`, or `settings.json` in
`$CLAUDE_CONFIG_DIR` when that is set) look like this:

```json
{
  "permissions": {
    "deny": [
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
      "Bash(aws ecs execute-command:*)",
      "Bash(session-manager-plugin:*)",
      "Bash(bin/shell:*)",
      "Bash(./bin/shell:*)",
      "Bash(~/src/myapi/bin/shell:*)",
      "Bash(/Users/me/src/myapi/bin/shell:*)",
      "Edit(~/src/myapi/bin/shell)",
      "Read(~/.ssh/**)",
      "Edit(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Edit(~/.aws/**)",
      "Read(~/.local/state/airlock/**)",
      "Edit(~/.local/state/airlock/**)"
    ]
  }
}
```

These rules are policy, not enforcement; the OS sandbox is the boundary, and a
misspelled sandbox setting fails open. Airlock has no self-check yet that
proves the sandbox actually cuts off the remote path
([SECURITY.md](../SECURITY.md), finding 7).

## Tell Claude when to use it

The config's `instructions` already tell Claude that Airlock is the only path
to remote hosts. To have it reach for Airlock while debugging, add an entry
like this to your `CLAUDE.md`:

```markdown
## Remote access — staging & production (Airlock)

- Use the `airlock` MCP tools **proactively** whenever debugging needs live
  staging/production state a local dump can't provide (record state, counts,
  feature flags, logs, recent events): `list_targets` shows the inventory,
  `open_terminal` + `send_terminal` run human-approved commands in a shared
  session. Every command is gated by a native approval overlay — don't hesitate
  to reach for it.
- **Never run `ssh`/`scp`/`sftp` directly from Bash**, and never reconstruct
  connection details from Capistrano configs, deploy scripts, or `~/.ssh/config`.
  The Airlock target list is the only sanctioned path to remote hosts.
- If the `airlock` server shows as unavailable (its single-instance lock is
  likely held by another open Claude session), say so and ask the user — do not
  fall back to direct SSH.
```

## Upgrade, rollback, and uninstall

Close any open Airlock session before installing over it, and restart Claude
Code afterwards so the server relaunches from the new files. Every install
first removes the previous version's files and keeps `config.json`.

To upgrade, run `brew upgrade --cask airlock`, or install the newer release's
[direct package](#direct-package):

```bash
brew upgrade --cask airlock
```

To roll back, install the older release's direct package. The cask always
points at the latest release, so a Homebrew install rolls back through the
direct package too.

To uninstall with Homebrew, which keeps `config.json`:

```bash
brew uninstall --cask airlock
```

To also remove `config.json` and the install directory and move
`~/.local/state/airlock` to the Trash:

```bash
brew uninstall --zap --cask airlock
```

To uninstall a direct package, forget its receipt and remove the install
directory. This deletes `config.json` too, so copy it out first to keep it:

```bash
sudo pkgutil --forget com.unabridgedsoftware.airlock
```

```bash
sudo rm -rf /usr/local/libexec/airlock
```

Either way, remove the registration afterwards:

```bash
claude mcp remove --scope user airlock
```

## Moving from a checkout install

A checkout registered as `node <checkout>/src/server.mjs` now refuses to start.
Close any open session, [install the package](#install-the-package), then:

1. Review `~/.config/airlock/config.json` before carrying it over. The bridge
   no longer reads it, and while it was writable by you it was writable by the
   agent, so check every target, its `script`, and `ssh_config`.

2. Install it as the root-owned config:

   ```bash
   sudo install -m 644 -o root -g wheel ~/.config/airlock/config.json /usr/local/libexec/airlock/config.json
   ```

3. Replace the registration:

   ```bash
   claude mcp remove --scope user airlock
   ```

   ```bash
   claude mcp add --scope user airlock -- /usr/local/libexec/airlock/bin/airlock-server
   ```

## Why root-owned

The agent runs as you, so anything you can write, the agent can rewrite: the
server, the overlay helper whose answer is the approval, the config that names
the targets, and the Node and tmux that run them. A checkout or an install
under your home directory leaves the gate one file edit away. Owned by root and
closed to group and other writes, the install is out of the agent's reach
without relying on a sandbox rule.

The server verifies this at every start, before it reads the config or answers
Claude Code. It checks the whole install tree, the directories above it, its
own Node, the config, helper, and tmux, and `/usr/bin/ssh`, and refuses to
start if any entry is not owned by root, is group- or other-writable, has an
access control list entry that allows changing it, or is a symlink inside the
install tree. The launcher also clears every `NODE_*`, `DYLD_*`, and
`OPENSSL_*` variable, so the launch environment cannot load code into the
bundled Node. A checkout fails the check, so it runs only as a
[development instance](development.md#development-instance).
