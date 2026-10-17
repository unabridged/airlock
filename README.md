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

**Watch the session:** run `bin/airlock-attach` once in Claude Desktop's
integrated terminal and leave it running. It idles until a session opens,
attaches to the same PTY The agent drives (you can type into it — e.g. to answer
SSH host-key or 2FA prompts), and goes back to idling when the session closes.
Every successful `open_terminal` result carries this command as a one-click
Run block, so there is no path to remember.

## Setup

Requirements: macOS, `tmux`, Node, and the Xcode command-line tools (for
`swiftc`).

1. Install dependencies and build the approval overlay helper:

   ```bash
   npm install && mkdir -p bin && /usr/bin/swiftc -O -o bin/airlock-approve airlock-approve.swift
   ```

2. Create `~/.config/airlock/config.json` from
   [`config.example.json`](config.example.json). A target is reached either
   over SSH (`ssh_host` names an explicit `Host` alias from your
   `~/.ssh/config`) or, with `"transport": "script"`, by running a local
   executable you name (`script`, tilde allowed, plus whitespace-free
   `args`) — typically a project's own connection helper, such as a
   `bin/shell staging` that wraps `aws ecs execute-command` into a Fargate
   task. Either kind takes optional startup lines, and `display_command`
   must spell out exactly what the bridge runs (the `ssh` line or the script
   line, then each startup line); the bridge refuses to start on a config it
   cannot fully validate. A script's contents are trusted exactly like your
   SSH config: the overlay shows the script line, not what the script does.

3. Register the bridge user-scope as MCP server `airlock`:

   ```bash
   claude mcp add --scope user airlock -- node "$(pwd)/src/server.mjs"
   ```

4. Block the direct path (next section). Without it the gate is decorative.

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
      "Bash(aws ecs execute-command:*)",
      "Bash(session-manager-plugin:*)",
      "Bash(bin/shell:*)",
      "Bash(~/src/myapi/bin/shell:*)",
      "Edit(~/src/myapi/bin/shell)",
      "Read(~/.ssh/**)",
      "Edit(~/.ssh/**)",
      "Read(~/.aws/**)",
      "Edit(~/.aws/**)"
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

```bash
node --test "test/*.test.mjs"
```

The suite includes live local tmux + IRB integration tests; no approval
panels pop and no remote connections are made. Rebuild the helper (step 1
above) after editing `airlock-approve.swift`.

## Layout

| Path | What |
| --- | --- |
| `src/` | The bridge: MCP stdio server, config + ssh-config validation, private-socket tmux layer, session manager, output extraction, shell + rails_irb drivers, overlay approval gate, colorizer. |
| `test/` | The test suite (`node --test`). |
| [`airlock-approve.swift`](airlock-approve.swift) | The overlay helper source; builds to the gitignored `bin/airlock-approve`. |
| [`config.example.json`](config.example.json) | The target inventory template; the live copy is `~/.config/airlock/config.json`. |
| [`PLAN.md`](PLAN.md) | The build plan, kept as a design reference. |
| [`SECURITY.md`](SECURITY.md) | The threat model, the assumptions the gate depends on, and the open findings from the hardening review. |
| `spikes/` | Historical validation spikes for the approval dialog and overlay. |
