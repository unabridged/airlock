# Airlock security

## Status

Experimental. The hardening review below (2026-08-24) found seven gaps. As of
2026-10-17, finding 1 is remediated for the packaged install, finding 2 is
remediated, finding 6 is remediated for command size, and the other four are
open. Until they are closed, Airlock is an approval gate with an audit trail,
not a security boundary. Do not rely on it
as the only thing standing between an agent and a production host.

## Threat model

Airlock exists so that a sandboxed model can reach configured remote hosts only
through an operation a human has seen and approved, with the approval overlay
faithfully showing what will be sent. That goal holds only while every one of
the following assumptions holds. Each one that fails makes the gate decorative.

1. **The agent cannot reach the hosts around the bridge.** An OS sandbox denies
   network egress to every configured host, denies reads of `~/.ssh` and
   `~/.aws`, and keeps the SSH agent socket and Airlock's tmux socket out of
   reach. Claude Code permission deny rules are policy on top of that, not the
   boundary. There is no self-check yet that proves this (finding 7).
2. **The agent cannot modify the bridge.** The packaged install in
   `/usr/local/libexec/airlock` (the server, its Node and tmux, the approval
   helper, and the configuration) is owned by root and closed to group and
   other writes, and the server refuses to start unless it still is (finding
   1, remediated for the packaged install). The rest still depends on the
   sandbox: the state directory `~/.local/state/airlock` with its tmux socket;
   the user-scope registration in `~/.claude.json`, unless the server is
   registered in `managed-mcp.json` instead; the `env` block of the user
   settings, which `managed-mcp.json` does not cover; and the SSH
   configuration and scripts of finding 5. A development instance (`--dev`)
   runs from a writable checkout and protects nothing.
3. **The approval text is what gets sent.** A human reading the overlay sees
   exactly the bytes the bridge will paste. The bridge rejects control, ANSI,
   bidirectional, and zero-width characters before the overlay pops, so they
   cannot make the display differ from the bytes (finding 2, remediated).
4. **Remote programs are not actively hostile to the bridge.** Remote output is
   treated as untrusted data, but completion is detected from the rendered
   prompt, and a cooperating foreground process can forge it and receive the
   next approved command (findings 3 and 4).
5. **SSH configuration and script targets are trusted code.** The overlay shows
   the alias or the argv, not what the SSH config or the script does
   (finding 5).

Out of scope, by design: what an approved command does on the remote host (a
human approved it); exfiltration through the returned output of approved
commands; compromise of the macOS user account running the bridge; the remote
host's own security; and denial of service beyond the bounds in finding 6.

## Hardening review

Date: 2026-08-24  
Status: Review complete; finding 1 remediated for the packaged install, finding 2 remediated, finding 6 remediated for command size  
Scope: Production bridge, native approval helper, terminal drivers, SSH configuration, and deployment assumptions

## Objective

Preserve Airlock's core guarantee: a sandboxed model can reach configured remote hosts only through a human-approved operation, and the approval surface faithfully represents the operation that will occur.

The current implementation has strong foundations—argv-only process spawning, fixed `/usr/bin/ssh`, a private tmux server, fail-closed approval parsing, bounded returned output, and careful session-lock cleanup—but it should not yet be treated as the sole remote-access security boundary.

## Findings summary

| Priority | Finding | Primary locations |
| --- | --- | --- |
| P1 | The approval helper and server installation can be modified from a writable workspace (remediated for the packaged install) | `src/install-check.mjs`, `src/launch-options.mjs`, `bin/airlock-server`, `packaging/scripts/preinstall` |
| P1 | Control and bidirectional characters can make the approval display differ from executed bytes (remediated) | `src/command-contract.mjs` |
| P1 | Remote output can forge the recognized prompt and trigger false completion | `src/output-stream.mjs:55-87`, `src/drivers/shell.mjs:91-96`, `src/drivers/rails-irb.mjs:85-90` |
| P2 | Startup readiness uses negative authentication filtering and can adopt the wrong input state | `src/drivers/shell.mjs:160-167`, `src/drivers/rails-irb.mjs:152-180` |
| P2 | An allowed SSH alias can still execute undisclosed local actions or open forwarding paths | `src/session-manager.mjs:39-50`, `src/ssh-config.mjs:19-59` |
| P2 | JSON-RPC input and the approval backlog are unbounded (command size is bounded) | `src/server.mjs:463-483`, `src/approval.mjs:40-63` |
| P1 operational | The required sandbox isolation self-check is specified but not implemented | `PLAN.md:697-716`, `PLAN.md:848-853` |

## Required security invariants

The fixes should be evaluated against these invariants:

1. A sandboxed model cannot modify the running bridge, its approval oracle, configuration, state, or tmux socket.
2. Every byte that affects terminal input is either shown unambiguously in the approval UI or is fixed, audited bridge protocol disclosed as part of the action.
3. Remote pane output cannot prove that the trusted shell or REPL is ready for the next command.
4. Authentication and startup commands cannot be confused with one another.
5. Opening an SSH target cannot silently create an additional local execution or network path outside the documented target policy.
6. A client cannot exhaust bridge memory or flood approval UI through unbounded input or concurrency.
7. Deployment fails closed when the sandbox requirements cannot be demonstrated.

## 1. Protect the approval root of trust

### Status

Remediated for the packaged install by `bin/build-pkg`,
`packaging/scripts/preinstall`, `bin/airlock-server`, `src/launch-options.mjs`,
and `src/install-check.mjs`. Against the proposed fix:

1. The package installs to `/usr/local/libexec/airlock`, owned by root:wheel
   with nothing group- or other-writable, instead of a directory under
   `~/.local/libexec`, which the user and so the agent can write. It bundles
   Node and tmux under `runtime/`, with tmux's Homebrew libraries copied into
   `runtime/lib` and relinked to load from there. The configuration moves into
   the install root as `config.json`, which the admin creates with `sudo` and
   upgrades keep. The preinstall script installs only on the startup volume
   and changes nothing when `/usr`, `/usr/local`, `/usr/local/libexec`, or the
   install root is a symlink, not a directory, not owned by root, group- or
   other-writable, or has an access control entry that allows changing it.
2. Root ownership replaces the deny-write rules for the install directory, the
   configuration, Node, tmux, and the helper. `~/.config/airlock/` is no
   longer read, and colorization runs in-process (Shiki, from the install's
   `node_modules`) instead of through Ruby. The state directory still needs
   sandbox rules, which the README lists.
3. The checkout cannot run as the production server: it fails the install
   check, and `bin/airlock-server` refuses to run without the bundled Node. The
   package is the separately installed immutable copy. A checkout runs only as
   a development instance (`--dev`), which must name its own configuration and
   state directory, is refused the production state directory, and marks
   every overlay with a DEV badge and an "Airlock DEV" title.
4. `AIRLOCK_CONFIG`, `AIRLOCK_STATE_DIR`, and `AIRLOCK_APPROVE_HELPER` are
   refused in every mode, before the server resolves any path. Paths come from
   argv alone, and `--config`, `--state-dir`, and `--approval-helper` require
   `--dev`. Tests pass paths through those flags or as arguments to
   `parseLaunchOptions`.
5. Replaced by root ownership verified at startup, before the server loads the
   configuration or reads any MCP message: the helper, the directories above
   it, and everything else the server trusts must be owned by root and closed
   to group and other writes. Once that holds, only root can replace the
   helper. No code signature or pinned hash is checked.
6. The startup check covers the server and launcher as well as the helper:
   every entry of the install tree (by `lstat`, so any symlink inside the tree
   is a problem), the install root's ancestors up to `/`, `process.execPath`,
   the configuration, helper, and tmux by name (so a missing one is reported),
   and `/usr/bin/ssh`. Symlinks on those paths are followed one hop at a time,
   checking each directory a hop passes through, up to 40 hops. Every entry
   checked must also carry no access control entry that allows anyone to
   write, append, delete, change attributes, security, or owner, or add or
   delete children, since such a grant bypasses the owner and mode bits. Any
   problem refuses startup with a message that lists up to 20 of them. The
   launcher runs under `/bin/sh -p`, resolves its own path through symlinks
   so a link elsewhere still runs the install it points into, unsets every
   `NODE_*`, `DYLD_*`, and `OPENSSL_*` variable so the environment cannot
   load code into Node, and execs the bundled Node. System Integrity
   Protection already strips `DYLD_*` when it starts `/bin/sh`, so the tests
   check the launcher's `DYLD_*` filter on its own rather than through a
   launch. The bundled tmux's ncurses searches `$TERMINFO` before
   `~/.terminfo`, `$TERMINFO_DIRS`, and its Homebrew prefix, all writable by
   the user. The bridge's own tmux calls read no terminal description, and the
   attach scripts set `TERMINFO=/usr/share/terminfo` and switch `TERM` to
   `xterm-256color` when that directory has no entry for it, so their lookup
   ends in the system database.

Against the acceptance criteria:

- Every entry of the installed directory is owned by root with no group or
  other write bit, so a process running as the user cannot replace, rename,
  chmod, truncate, or create files in it. The package tests check this for the
  BOM and the expanded payload (`test/package.test.mjs`).
- Replacing the helper takes root. A helper, or any other entry, that is not
  owned by root, is group- or other-writable, or has an access control entry
  that allows changing it makes startup fail closed
  (`test/install-check.test.mjs`). A root-owned replacement is not detected.
- Production and development startup reject the retired override variables
  (`test/launch-options.test.mjs`, and smoke tests that start the server with
  each one set).
- The checkout cannot serve as production: the install check refuses it (the
  smoke test "refuses to run as production from a checkout the user owns"),
  and so does the launcher (`test/package.test.mjs`). With `--dev` it runs,
  labeled DEV and on its own state directory.

Residual risks:

- The state directory `~/.local/state/airlock` is writable by the user. It
  holds the tmux socket, `airlock.lock`, `session.json`, `final-screen`, and
  the `watch.command` script the overlay's watch button opens in a terminal,
  outside the sandbox. Every tmux the bridge and its attach clients run names
  an empty configuration file, so the bridge's tmux server reads none, whichever
  of them starts it. The bridge replaces its files instead of writing through
  whatever sits at their paths and opens the lock with `O_NOFOLLOW`, so a
  symlink planted at one of its file paths redirects none of its writes. The
  directory itself is followed: a symlink or another directory put in its
  place in `~/.local/state` receives the socket and every file. An agent that
  can write or replace the directory can also rewrite `watch.command` before
  the button runs it or reach the session through the socket, so only the
  sandbox keeps the agent out of it.
- The user-scope registration in `~/.claude.json` can name any command,
  including the installed launcher with `--dev` and a configuration and helper
  of the agent's choosing. Such a helper can approve every command without
  showing an overlay, and nothing tells the user: the DEV badge is drawn by the
  helper, and the development notice in the server's instructions reaches only
  the agent. Denying the agent writes to `~/.claude.json`, or registering the
  server in `/Library/Application Support/ClaudeCode/managed-mcp.json`, closes
  this; the latter costs that file's exclusive control over MCP servers.
- The launcher strips only `NODE_*`, `DYLD_*`, and `OPENSSL_*`. Everything else,
  including `PATH`, `BASH_ENV`, and `HOME` (which also moves the state
  directory and the `~` in the configuration's paths), reaches Node, the tmux
  server, and the programs in the session. The `env` block of the user
  settings and of a user-scope registration is therefore trusted input, and
  `managed-mcp.json` does not protect the user settings.
- SSH configuration and script targets remain user-owned trusted code
  (finding 5).
- Root ownership holds only against an agent that cannot run commands as root,
  for example through passwordless `sudo`.
- The check runs once, at startup. A non-root user cannot change root-owned
  files afterwards, but nothing re-verifies a running server.
- The package trusts its build machine: the Homebrew tmux and libraries it
  bundles, the working tree it copies the server from (uncommitted changes
  included), and the npm registry. Only Node is pinned, to the version in
  `.tool-versions` and the OpenJS Foundation's Developer ID signature. The
  package is unsigned unless built with `--sign`. The cask's SHA-256 pins the
  release asset for Homebrew; a direct download has nothing to check against.
- A development instance runs from the writable checkout and protects nothing.

### Risk

`DEFAULT_HELPER_PATH` points into the project at `bin/airlock-approve`. The current file is owner-writable and only checked with `X_OK`. A model with write access to this workspace can replace it with any executable that reads stdin and prints `{"decision":"approve"}`. The server spawns the helper for each approval, so replacement takes effect without restarting the server.

The production process also honors `AIRLOCK_APPROVE_HELPER`, `AIRLOCK_CONFIG`, and `AIRLOCK_STATE_DIR` even though comments describe them as test-only.

Protecting only `~/.local/state/airlock` is insufficient. The bridge source, launcher, helper, configuration, and any runtime or shim selected by the bridge are all part of the trusted computing base.

### Proposed fix

1. Install the production server and helper into a dedicated path outside every model-writable workspace, for example a versioned directory under `~/.local/libexec/airlock/`.
2. Add explicit sandbox deny-write rules for:
   - the complete installed Airlock directory;
   - `~/.config/airlock/`;
   - `~/.local/state/airlock/`;
   - the executable/runtime paths used to launch Node, Ruby colorization, tmux, and the helper.
3. Disable Airlock, or use a separately installed immutable copy, while an agent is working on the Airlock source repository itself.
4. Remove environment-based test overrides from the production entry point. Prefer constructor/function injection in tests or a separate test entry point that cannot be selected by production registration.
5. Verify the helper before every spawn, or once at startup while holding an immutable file descriptor:
   - preferred: a real code signature with an expected signing identity and designated requirement;
   - acceptable for a local-only installation: a pinned SHA-256 stored in an independently protected launcher/configuration.
6. Protect the JavaScript server and launcher as well as the helper; helper verification alone does not protect the next server restart.

### Acceptance criteria

- A sandboxed process cannot replace, rename, chmod, truncate, or create files anywhere in the installed Airlock directory.
- Replacing the helper with an executable that returns `approve` causes startup or the request to fail closed.
- Production startup rejects all test-only override variables.
- An Airlock development session cannot use the mutable checkout as its production MCP server.

## 2. Make approval text byte-faithful

### Status

Implemented by `src/command-contract.mjs`. `send_terminal` runs every command
through the contract before the overlay pops, and the checked string is the one
both the overlay and the driver receive. The contract rejects, naming the code
point and its line and column:

- malformed Unicode (unpaired surrogates);
- every C0 and C1 control except LF, which covers ESC, CR, NUL, BS, DEL, and
  TAB;
- every formatting character: bidirectional embeddings, overrides, isolates,
  and marks, zero-width characters, and the BOM;
- separators that render like a space or a newline without being one: NBSP,
  the other non-ASCII spaces, and U+2028/U+2029.

The one canonicalization is dropping a single trailing LF, which both drivers
strip anyway. Trailing spaces and leading, trailing, or doubled blank lines are
rejected too, so the overlay never hides whitespace that affects execution. The
overlay shows every approved byte at 80 columns without a fade. Lines wrap
rather than clip, and a badge counts the rows still below the fold.

The same character rule runs at config load over `instructions`,
`display_command`, and every `startup` line. Target keys and the client
identity shown in the overlay header are not yet checked.

### Risk

`send_terminal` accepts any nonempty JavaScript string. This includes ANSI escape sequences, carriage returns, backspaces, C0/C1 controls, zero-width characters, and Unicode bidirectional overrides/isolates.

The display path interprets ANSI SGR sequences as styling and WKWebView applies Unicode bidirectional rendering. Those characters can therefore disappear or reorder visible syntax. The original string is still passed to tmux. This violates the statement that what the overlay shows is what runs.

Trailing newlines are also displayed but stripped by both drivers before execution. That difference is lower risk but should be represented honestly in the invariant and tests.

### Proposed fix

Add one central validation and canonicalization step before opening an approval panel. The exact validated value returned by that step must be the value passed to the driver.

Recommended policy:

- reject malformed Unicode strings;
- reject ESC, CR, NUL, backspace, DEL, and all other C0/C1 controls except LF;
- either reject TAB or render every TAB as a visible, fixed-width token while preserving its execution semantics;
- reject Unicode bidirectional controls and other default-ignorable formatting characters, including embeddings, overrides, isolates, directional marks, zero-width characters, and BOM;
- set a command byte and line limit before colorization;
- validate `display_command`, startup lines, target labels, and client-provided header text under equivalent display-safe rules;
- keep HTML escaping after validation as defense in depth.

Do not sanitize dangerous characters into a different string silently. Reject with an error that names the character and offset so the model can generate an unambiguous replacement.

### Acceptance criteria

- Tests cover every rejected control-character class, bidi controls, zero-width text, unpaired surrogates, tabs, LF, and ordinary Unicode.
- User-supplied ANSI sequences are never consumed as styling.
- The value approved and the value passed to `tmux.pasteText` are byte-for-byte identical, apart from fixed Enter framing explicitly represented by the UI.
- The UI visibly distinguishes spaces, tabs, blank lines, and trailing whitespace when those distinctions affect execution.

## 3. Replace prompt-based completion as a trust signal

### Risk

Completion currently requires history growth followed by a ready-looking last line with the cursor at its end. That rejects prompt-looking text earlier in the output, but it does not reject a foreground process that deliberately prints the learned prompt as its final partial line.

A process can print the exact prompt, pause, and read more stdin. Airlock can then return early and deliver the next separately approved command to that process instead of the intended shell or IRB. Output can also bleed across command boundaries.

The prompt is not a secret: it is displayed in the successful open result. IRB counters improve accidental matching but are predictable and custom prompts may have no counter.

### Proposed fix

First decide and document the threat model:

- If remote output and foreground programs may be actively malicious, rendered PTY text cannot be an authoritative completion channel. Use a structured remote-side agent/control protocol, or change the design to isolated noninteractive SSH executions.
- If active remote-process spoofing is out of scope, state that explicitly and describe prompt matching as a heuristic. Still add a per-session unpredictable machine marker to prevent accidental prompt collisions and basic output injection.

A random visible prompt suffix alone is not sufficient against a malicious shell command if the command can discover the value. Any marker must be emitted through a channel or trusted integration the foreground command cannot read or forge.

### Acceptance criteria

- An integration fixture that prints the learned shell prompt without returning must not complete the call.
- A fixture that prints the next expected IRB prompt/counter without returning must not complete the call.
- A foreground fixture that reads stdin must not receive the next tool command after forging visible prompt output.
- Command output cannot be attributed to a later invocation after a false-ready condition.

## 4. Positively verify post-authentication startup state

### Risk

The shell driver adopts any stable, nonempty, cursor-ended line that does not match a best-effort English authentication regex. The Rails startup path uses the same quiescence concept before sending configured startup commands.

A localized/custom MFA prompt, unusual host-key prompt, captive application, or paused banner can be mistaken for readiness. Airlock may then paste a command or startup line into a credential field or another program.

Negative recognition of known authentication prompts is useful UX, but it is not proof that authentication completed.

### Proposed fix

Require a positive, target-specific readiness signal before any automatic startup line or user command is sent. Options include:

1. A fixed, audited remote bootstrap command or script that starts the intended interactive shell and emits a machine-readable readiness marker.
2. A shell integration installed on each target that emits the protected control marker described in finding 3.
3. A separate explicit human confirmation after authentication, if no reliable machine protocol is available.

Keep the authentication regex only for diagnostic messages. It must never be the only guard preventing input from entering a password/MFA prompt.

### Acceptance criteria

- Localized and unknown prompts such as `Token:`, `Security key:`, and non-English password prompts never receive startup or command text.
- A banner that remains stable longer than the quiescence interval is not adopted as a prompt.
- Rails startup sends no line until positive shell readiness is established.
- The open timeout preserves the session for human recovery without claiming readiness.

## 5. Constrain SSH configuration side effects

### Risk

The configuration validator proves only that `ssh_host` appears in an explicit `Host` stanza. OpenSSH configuration can also run local commands or create additional access paths through directives such as `ProxyCommand`, `Match exec`, `LocalCommand`, local/dynamic/remote forwarding, and agent forwarding.

These effects are not represented by a display string containing only `ssh <alias>`. A local or dynamic forward can also undermine the claim that the MCP bridge is the only route to the remote network.

### Proposed fix

Choose one of these policies:

1. Preferred: maintain a dedicated Airlock SSH configuration containing only audited directives. Reject `Include`, `Match exec`, `LocalCommand`, arbitrary `ProxyCommand`, and forwarding directives. Allow an explicit `ProxyJump` only when required and reviewed.
2. Generate a minimal configuration from an allowlisted target schema instead of consuming the user's general SSH configuration.
3. If general SSH configuration remains trusted code, document that trust boundary and display all permitted side effects during open approval.

Regardless of policy, force safe options where compatible:

- `ClearAllForwardings=yes`;
- `ForwardAgent=no`;
- `PermitLocalCommand=no`;
- no dynamic, local, or remote forwarding;
- no arbitrary local proxy command unless it is a reviewed requirement.

Do not use `ssh -G` as the sole validator for an untrusted configuration: configuration evaluation itself may process active conditions such as `Match exec`.

### Acceptance criteria

- Fixtures containing local commands, active match commands, agent forwarding, or port forwarding are rejected or explicitly disclosed and approved under policy.
- Opening a target cannot create a listening local proxy/forward.
- Remote hosts cannot access the user's SSH agent through Airlock.
- The approved display matches the allowed connection behavior, not merely the alias.

### The `script` transport extends this trust boundary to the script

A script target runs a local executable named in the config, with fixed arguments, instead of `ssh`. The validator pins the path (absolute after tilde expansion, a regular executable file) and the arguments (single whitespace-free tokens), so the overlay line is the exact argv — but what that executable does is not represented by the line. In the intended use it is a project's connection helper wrapping `aws ecs execute-command`, which reads `~/.aws` for the profile (`credential_process`, SSO, and role chaining are side effects), finds `session-manager-plugin` on the bridge's PATH, and chooses the task at open time. The script's contents are trusted code, exactly like the SSH configuration: audited, and denied to the agent's local Bash/Edit — together with `~/.aws`, and with the script's own name as a Bash command.

## 6. Bound input and approval concurrency

### Status

Command size is bounded. The contract in `src/command-contract.mjs` rejects a
command over 32 KiB or 60 lines before colorization or the approval helper
runs. JSON-RPC request bytes, helper stdout, and pending approvals remain
unbounded.

### Risk

The readline-based protocol loop buffers an entire line before parsing it. There is no maximum JSON-RPC line size or command size. The approval queue also accepts unlimited concurrent gated requests and retains their command strings.

A prompt-injected or malfunctioning client can consume memory, repeatedly block the event loop in synchronous Ruby colorization, or create a long sequence of stale approval panels. This is both a denial-of-service issue and an approval-fatigue risk.

### Proposed fix

1. Replace or wrap the line reader with incremental buffering that aborts once a configured byte ceiling is crossed. Checking size only after the `line` event is too late to bound memory.
2. Set explicit limits for:
   - JSON-RPC request bytes;
   - command bytes and lines;
   - helper stdout bytes;
   - pending request count;
   - pending approval count.
3. Allow at most one gated mutation awaiting approval per bridge. Reject later calls with a typed retryable error instead of queueing panels.
4. Consider rejecting all new mutating calls while another command executes, except the deliberately out-of-band interrupt operation.
5. Keep discovery and `list_targets` available while a mutation is pending.

Suggested starting limits should be selected for human reviewability, not only memory safety—for example, a command limit in the low tens of KiB and a single pending approval.

### Acceptance criteria

- Oversized input is rejected before the full request is retained in memory.
- Oversized commands never launch Ruby or the approval helper.
- A burst of concurrent tool calls creates at most one approval panel.
- Discovery remains responsive during rejected mutation bursts.
- Helper output beyond its cap fails closed.

## 7. Implement the sandbox self-check

### Status

Open. The startup install check (finding 1) detects a writable installation,
one of the acceptance criteria below, and refuses to start on it. Nothing yet
checks the sandbox itself.

### Risk

The plan correctly identifies the OS sandbox as the primary boundary and requires an observed connectivity failure, but the repository contains no implementation or setup verifier. A schema change, misspelled setting, overly broad workspace permission, localhost forward, or Unix-socket allowance can therefore make the deployment fail open while the README still claims Airlock is the only path.

### Proposed fix

Add a setup/runtime diagnostic that executes in the same sandbox context as the model's ordinary local commands and verifies all of the following:

- TCP connections to every configured remote destination fail;
- direct `ssh`, `scp`, `sftp`, `mosh`, and tmux control attempts fail;
- `~/.ssh` and private keys cannot be read;
- `SSH_AUTH_SOCK` cannot be connected to;
- the Airlock tmux socket cannot be connected to;
- the Airlock install, config, helper, and state paths cannot be modified;
- no local forward created by an Airlock session becomes reachable from the sandbox.

The diagnostic should report evidence for each check and fail closed when a check cannot be performed. Run it during installation, after sandbox/configuration upgrades, and periodically or before the first production target opens.

### Acceptance criteria

- A deliberately weakened sandbox setting causes the diagnostic to fail.
- A misspelled or unsupported sandbox setting cannot produce a passing result.
- A writable Airlock installation is detected.
- The diagnostic is documented in the README and is part of the production setup checklist.

## Recommended implementation order

1. Immediately protect or relocate the installed bridge/helper and disable the mutable checkout as a production MCP server. Done for the packaged install (finding 1).
2. Add command/display validation and size limits.
3. Reject concurrent approval requests.
4. Constrain or replace the general SSH configuration.
5. Add the sandbox setup/runtime diagnostic.
6. Redesign readiness/completion around a structured signal and then tighten startup authentication handling around the same mechanism.
7. Re-run the complete local tmux/IRB suite outside a sandbox that kills detached tmux servers, followed by a non-production SSH integration test.

## Test plan additions

- Approval rendering: C0/C1, ANSI, bidi overrides/isolates, zero-width characters, malformed Unicode, tabs, trailing whitespace, and maximum-size input.
- Approval integrity: replaced helper, invalid signature/hash, test-only override in production, helper stdout overflow.
- Concurrency: parallel sends, sends queued behind close, approval bursts, stdin request floods.
- Prompt spoofing: forged shell prompt, forged IRB prompt/counter, partial-line prompt, process reading subsequent stdin.
- Authentication: localized password/MFA prompts, unknown prompts, delayed banners, captive shells.
- SSH policy: `ProxyCommand`, `Match exec`, `LocalCommand`, `ForwardAgent`, and every forwarding type.
- Deployment: deny-write coverage for install/config/state, network denial, SSH-agent denial, tmux-socket denial.

## Existing verification result

The review run completed 137 tests: 109 passed and 28 failed. The failures cascaded from detached tmux servers being unavailable in the review sandbox (`tmux.sock` disappeared before setup completed), rather than from assertion failures in the non-tmux logic. The live PTY, prompt-spoof, and native-helper paths therefore still require verification in the intended macOS environment.

