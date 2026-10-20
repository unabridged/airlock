# Airlock

An approved, persistent remote terminal bridge for Claude Code on macOS.

> **Status: experimental. Airlock is an approval gate, not a security
> boundary.** It gates the path that goes through itself and nothing else. It
> does not stop a model that can reach the hosts another way (a local `ssh`, a
> `net-ssh` one-liner, the `tmux` CLI, the SSH agent socket), and it is only as
> strong as the sandbox and permission rules around it. Its own security review
> found gaps that are not yet fixed, including ways remote output can fake a
> command's completion and SSH configuration that runs more than the overlay
> shows. Read [SECURITY.md](SECURITY.md) before pointing it at anything you
> care about, and treat it as an approval UX with an audit trail, not as what
> keeps an agent off production.

![The approval overlay for a production Rails console command](docs/approval-overlay.png)


Airlock MCP gives your agent a human-gated channel into a persistent SSH shell or
a Rails console. Every crossing of the airlock requires explicit
approval in a native overlay rendered by the bridge — syntax-highlighted,
human-readable command text. What the overlay shows is what the bridge sends;
the known cases where that can be made to differ from what the remote shell
executes are tracked in [SECURITY.md](SECURITY.md).

## Quick install

You need macOS 26 or later on Apple silicon, an admin account, and Claude
Code.

**With Claude Code:** paste this into a session, and it asks which hosts to
add and whether to block direct SSH. While the repository is private, log in
with `gh auth login` first.

```text
Read https://github.com/unabridged/airlock/blob/main/docs/agent-install.md (if the page is not found, read it with gh) and guide me through installing this tool. Ask me about configuration choices, show changes before applying them, and have me execute privileged commands myself.
```

**By hand:**

1. Install the package. While the repository is private, use the
   [direct package](#direct-package) instead.

   ```bash
   brew tap unabridged/airlock https://github.com/unabridged/airlock
   ```

   ```bash
   brew install --cask unabridged/airlock/airlock
   ```

2. Create the config from the example and set your targets
   ([Configure](#configure)):

   ```bash
   sudo cp /usr/local/libexec/airlock/config.example.json /usr/local/libexec/airlock/config.json
   ```

   ```bash
   sudo -e /usr/local/libexec/airlock/config.json
   ```

3. Register the server:

   ```bash
   claude mcp add --scope user airlock -- /usr/local/libexec/airlock/bin/airlock-server
   ```

4. [Block the direct path](#block-the-direct-path): add the
   [deny rules](#example-claude-settingsjson-entry) and deny the hosts in
   Claude Code's sandbox.

## Using it

Agent sees five tools:

| Tool | Approval | What it does |
| --- | --- | --- |
| `list_targets` | none | Lists the configured targets (name, description, the exact command an open would run). |
| `open_terminal` | overlay | Starts the session for one target: `ssh <alias>`, then the target's startup lines (e.g. `bin/rails console`). |
| `send_terminal` | overlay | Types one command into the session and returns the captured output. |
| `interrupt_terminal` | overlay | Sends a real Ctrl-C to the running command. |
| `close_terminal` | none | Exits the remote program and tears the session down. |

Deny can carry a feedback note, which rides back to the agent so it can adjust 
and resend.

**Style contract:** `send_terminal` checks every command against a style
contract before the overlay pops, so the human only reviews text they can read
at a glance. The overlay shows every approved byte at 80 columns without a
fade. The bridge enforces these rules, and the tool description teaches them to
the agent:

- At most 80 columns per line, and at most 60 lines and 32 KiB per send.
- One statement per line. Shell control flow such as `for f in *.log; do wc -l
  $f; done` is the one allowed use of `;`.
- No comment lines.
- Full-word variable names, such as `order` rather than `o` or `tmp`.
- Spaces around `=` and after every comma.
- Exactly one blank line between sections, and a multi-section command prints
  labeled values such as `puts "count: #{count}"`.
- Arrays fill-wrapped, never one element per line.
- No trailing spaces.
- No tabs, control characters, zero-width or bidirectional characters, or
  non-ASCII spaces.

The bridge never reformats a command. Its only change is dropping one trailing
newline. A rejected command never reaches the human, and the rejection lists
every problem so the agent fixes them in one resend:

```text
send_terminal rejected before approval: the command breaks the style contract (2 problems). The human has NOT seen it.
  - line 1, col 1: [name] variable `u` — use the full name of the object it holds (e.g. `order`, not `o`)
      "u = User.find(1234); puts u.email"
  - line 1, col 20: [statements] 2 statements joined by `;` — one statement per line
      "u = User.find(1234); puts u.email"
Fix every item and resend the whole command. If an item cannot be satisfied for this command, stop and relay this message to the human instead of retrying.
```

The character rule also runs over the configuration at load: `instructions`,
each target's `display_command`, and its `startup` lines.

Sessions are persistent and exclusive: one active session across all
windows, and console state (variables, loaded records) survives between
approved commands. If `open_terminal` refuses because a previous session is
still alive, attach to it and exit the remote program yourself — leftover
sessions are never killed automatically.

**Watch the session:** run `/usr/local/libexec/airlock/bin/airlock-attach`
once in Claude Desktop's integrated terminal and leave it running. It idles
until a session opens, attaches to the same PTY the agent drives (you can type
into it — e.g. to answer SSH host-key or 2FA prompts), and goes back to idling
when the session closes. Every successful `open_terminal` result carries this
command as a one-click Run block, so there is no path to remember. The
installed client and the overlay's watch button read only the system terminal
database, so a terminal whose `TERM` has no entry in `/usr/share/terminfo`
(such as `xterm-ghostty` or `xterm-kitty`) is attached as `xterm-256color`.

## Install

Requirements: macOS 26 (Tahoe) or later on Apple silicon, an admin account
(installing and editing the config need `sudo`), and Claude Code. The package
declares the newest minimum among the binaries it bundles, and the tmux
libraries it copies from the build machine's Homebrew (ncurses in particular)
are built for macOS 26. The installer enforces that minimum, and the cask
declares the same one, so Homebrew refuses an older macOS before it downloads
anything.

Airlock installs as a macOS package into `/usr/local/libexec/airlock`, owned by
root, with its own Node and tmux. Replace `X.Y.Z` below with the release
version.

### Homebrew

The repository doubles as a Homebrew tap:

```bash
brew tap unabridged/airlock https://github.com/unabridged/airlock
```

```bash
brew install --cask unabridged/airlock/airlock
```

While the repository is private, the tap has to be cloned over SSH:

```bash
brew tap unabridged/airlock git@github.com:unabridged/airlock.git
```

Homebrew still cannot download a private release asset, so install the
[direct package](#direct-package) instead.

### Direct package

Download a release's package with the GitHub CLI, then install it:

```bash
gh release download vX.Y.Z -R unabridged/airlock -p 'airlock-*.pkg'
```

```bash
sudo installer -pkg airlock-X.Y.Z.pkg -target /
```

The installer installs only on the startup volume. It changes nothing when
`/usr`, `/usr/local`, `/usr/local/libexec`, or the install directory is a
symlink, is not a root-owned directory closed to group and other writes (such
as a `/usr/local` an older Homebrew handed to your user), or has an access
control list entry that allows changing it.

### From source

Build the package from a checkout of a release tag (see
[Building the package](#building-the-package)), then install it the same way:

```bash
git checkout vX.Y.Z
```

```bash
bin/build-pkg
```

```bash
sudo installer -pkg dist/airlock-X.Y.Z-dev-<commit>.pkg -target /
```

The package bundles your Homebrew tmux. When its files differ from the ones
[`packaging/runtime.lock`](packaging/runtime.lock) pins for the release, the
build says so and goes on; only a release build (`--tag`) insists on them.

### Configure

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

A target is reached either over SSH (`ssh_host` names an explicit `Host` alias
from the SSH config that `ssh_config` names) or, with `"transport": "script"`,
by running a local executable you name (`script`, tilde allowed, plus
whitespace-free `args`) — typically a project's own connection helper, such as
a `bin/shell staging` that wraps `aws ecs execute-command` into a Fargate task.
Either kind takes optional startup lines, and `display_command` must spell out
exactly what the bridge runs (the `ssh` line or the script line, then each
startup line); the bridge refuses to start on a config it cannot fully
validate.

Root ownership covers this file only. The SSH config and the scripts it points
at stay yours, writable by you and so by the agent, and remain trusted code:
the overlay shows the alias or the script line, not what they do. Keep them out
of the agent's reach ([SECURITY.md](SECURITY.md), finding 5).

### Register

Register the installed server user-scope as MCP server `airlock`:

```bash
claude mcp add --scope user airlock -- /usr/local/libexec/airlock/bin/airlock-server
```

Then block the direct path ([below](#block-the-direct-path)). Without it the
gate is decorative.

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
yours ([SECURITY.md](SECURITY.md), threat model assumption 2).

### Why root-owned

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
development instance ([Development](#development)).

### Upgrade, rollback, and uninstall

Close any open Airlock session before installing over it, and restart Claude
Code afterwards so the server relaunches from the new files. Every install
first removes the previous version's files and keeps `config.json`.

To upgrade, run `brew upgrade --cask airlock`, or install the newer release's
package with `sudo installer` as above:

```bash
brew upgrade --cask airlock
```

To roll back, install the older release's package with `sudo installer`. The
cask always points at the latest release, so a Homebrew install rolls back
through the direct package too.

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

### Moving from a checkout install

A checkout registered as `node <checkout>/src/server.mjs` now refuses to start.
Close any open session, install the package (above), then:

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

The permission rules below are policy, not enforcement; the OS sandbox is the
boundary, and a misspelled sandbox setting fails open. Airlock has no
self-check yet that proves the sandbox actually cuts off the remote path
([SECURITY.md](SECURITY.md), finding 7).

## Example Claude settings.json entry
```
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
      "Bash(~/src/myapi/bin/shell:*)",
      "Edit(~/src/myapi/bin/shell)",
      "Read(~/.ssh/**)",
      "Edit(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Edit(~/.aws/**)",
      "Read(~/.local/state/airlock/**)",
      "Edit(~/.local/state/airlock/**)"
    ]
  }
```

## Example CLAUDE.md entry
```
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


Leave `MCP_TOOL_TIMEOUT` unset: Claude Code's default is far larger than the
overlay window plus command runtime, and a well-meaning short value would cut
approvals off.

## Development

### Tests

Development needs the Node version in `.tool-versions`, Homebrew tmux, and the
Xcode command-line tools (for `swiftc`). Install the dependencies, build the
approval overlay helper, and run the suite:

```bash
npm install
```

```bash
/usr/bin/swiftc -O -o bin/airlock-approve airlock-approve.swift
```

```bash
node --test
```

The suite includes live local tmux + IRB integration tests; no approval
panels pop and no remote connections are made. Nothing rebuilds the helper
for you, so rerun the `swiftc` step whenever `airlock-approve.swift` changes,
a pull included. Until you do, a development instance warns at startup and
whenever `open_terminal` asks for approval.

### Development instance

A checkout fails the install check, so it runs only as a development instance,
alongside the installed one. From the checkout root, copy the example config,
whose two targets are a local bash shell and a local IRB console:

```bash
cp config.dev.example.json config.dev.json
```

Then register the checkout for this project only:

```bash
claude mcp add --scope local airlock-dev -- "$(node -p process.execPath)" "$(pwd)/src/server.mjs" --dev --config "$(pwd)/config.dev.json" --state-dir "$(pwd)/.airlock-state"
```

What `--dev` changes:

- There is no install check, so a development instance protects nothing: the
  agent can edit the server it talks to. Give it local targets only.
- `--config` and `--state-dir` are required, and relative paths resolve against
  the checkout, not the working directory. `--approval-helper` is optional and
  defaults to the checkout's `bin/airlock-approve`.
- The production state directory is refused however it is spelled, so the
  instance has its own lock, tmux socket, and session file and runs while the
  installed server holds its own. Keep the checkout path short: macOS caps a
  Unix socket path at 104 bytes.
- It drives Homebrew's tmux (`/opt/homebrew/bin/tmux`, then
  `/usr/local/bin/tmux`, then `tmux` on `PATH`) instead of a bundled one.
- Every overlay carries a DEV badge and an "Airlock DEV" title, and the
  server's instructions tell the agent it is a development instance and which
  config its targets come from.
- Its attach command names the state directory. Every `open_terminal` result
  carries the absolute form; from the checkout root it is:

  ```bash
  bin/airlock-attach --state-dir .airlock-state
  ```

- `AIRLOCK_CONFIG`, `AIRLOCK_STATE_DIR`, and `AIRLOCK_APPROVE_HELPER` are
  refused here as in production; pass the flags instead.

Never register a checkout as `airlock`, even with `--dev`. That name belongs
to the installed server your CLAUDE.md and permission rules trust, and a
checkout behind it is a server the agent can rewrite.

### Building the package

```bash
bin/build-pkg
```

It builds from a commit, never from the working tree: it refuses to start
while `git status` shows a change or an untracked file, or while the running
script differs from HEAD's, and it writes the repository's files into the
stage straight from HEAD's objects, past any local git attribute or filter. It
writes
`dist/airlock-X.Y.Z-dev-<commit>.pkg`, versioned from `package.json` and named
after the commit, and prints its path, the commit, its SHA-256, and the
minimum macOS it declares. Only a release build (`--tag vX.Y.Z`, under
[Releasing](#releasing)) gets the name `airlock-X.Y.Z.pkg`, which
`bin/bump-cask` requires. `--output DIR` writes elsewhere, and
`--sign "Developer ID Installer: ..."` signs it. It writes nothing inside the
repository except the output directory.

It needs the Xcode command-line tools, the nodejs.org build of the Node
version in `.tool-versions` (it refuses any other version, and any node
without the OpenJS Foundation's Developer ID signature, such as Homebrew's),
network access for `npm ci`, which checks every dependency against
`package-lock.json`, and Homebrew tmux (`brew install tmux`). It bundles tmux
with its libraries relinked into the package and their license files, and
compares them with the exact files
[`packaging/runtime.lock`](packaging/runtime.lock) pins by formula, version,
path, and SHA-256. A release build (`--tag`) fails on another version, a
changed file, or a file the lock does not list; any other build reports the
difference and goes on. Either way the report prints the entries that would
pin what the machine has. After a Homebrew upgrade, check the new versions
(`brew info tmux`), replace the entries in the lock with those lines, and
commit the change on its own so it is reviewed as a dependency upgrade.

The package tests commit a copy of the working tree to a temporary git
repository, build a release there, expand the result with `pkgutil`, and check
its layout, ownership, permissions, bundled libraries, and launcher. They also
check that the build refuses uncommitted changes, a build script that differs
from the commit, a tag that HEAD is not on or that differs from
`package.json`, and a release with Homebrew files the lock does not pin, and
that a development build of those files only warns. They never install the
package:

```bash
npm run test:package
```

### Releasing

1. Bump the version in `package.json` and `package-lock.json`, and commit it:

   ```bash
   npm version X.Y.Z --no-git-tag-version
   ```

2. Tag the commit, without pushing the tag yet:

   ```bash
   git tag vX.Y.Z
   ```

3. Build the package from the tag:

   ```bash
   bin/build-pkg --tag vX.Y.Z
   ```

   It refuses unless the checkout is clean and on that tag, and `package.json`
   carries its version. If it fails on `runtime.lock`, delete the tag
   (`git tag -d vX.Y.Z`), commit the new lock entries, and go back to step 2.

4. Push the tag and publish the release with the package attached:

   ```bash
   git push origin vX.Y.Z
   ```

   ```bash
   gh release create vX.Y.Z dist/airlock-X.Y.Z.pkg
   ```

5. Point the cask at that exact file, since its SHA-256 must match what
   Homebrew downloads:

   ```bash
   bin/bump-cask dist/airlock-X.Y.Z.pkg
   ```

   It also copies the package's minimum macOS into the cask's
   `depends_on macos:` line.

6. Commit and push `Casks/airlock.rb`. The tap reads the cask from the
   default branch.

## Layout

| Path | What |
| --- | --- |
| `src/` | The bridge: MCP stdio server, launch options and install check, config + ssh-config validation, private-socket tmux layer, session manager, output extraction, shell + rails_irb drivers, overlay approval gate, colorizer. |
| `test/` | The test suite (`node --test`); `npm run test:package` adds the package build tests. |
| `bin/` | `airlock-server`, the installed launcher; `airlock-attach`, the attach client; `build-pkg` and `bump-cask`, the release tools; and the gitignored helper build `airlock-approve`. |
| [`airlock-approve.swift`](airlock-approve.swift) | The overlay helper source; builds to the gitignored `bin/airlock-approve`. |
| [`packaging/`](packaging) | The package's preinstall script and `runtime.lock`, the Homebrew files its tmux runtime is built from. |
| [`Casks/`](Casks) | The Homebrew cask; the repository doubles as its tap. |
| [`config.example.json`](config.example.json) | The target inventory template; the live copy is `/usr/local/libexec/airlock/config.json`. |
| [`config.dev.example.json`](config.dev.example.json) | The development instance's local targets; the live copy is the gitignored `config.dev.json`. |
| [`PLAN.md`](PLAN.md) | The build plan, kept as a design reference. |
| [`SECURITY.md`](SECURITY.md) | The threat model, the assumptions the gate depends on, and the open findings from the hardening review. |
| `spikes/` | Historical validation spikes for the approval dialog and overlay. |
