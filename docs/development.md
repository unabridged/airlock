# Development

## Install from source

Build the package from a release tag (see
[Building the package](#building-the-package) for what the build needs), then
install it the same way as a release:

```bash
git clone --branch v1.0.0 https://github.com/unabridged/airlock.git && cd airlock
```

```bash
bin/build-pkg
```

```bash
sudo installer -pkg dist/airlock-*.pkg -target /
```

The package bundles your Homebrew tmux. When its files differ from the ones
[`packaging/runtime.lock`](../packaging/runtime.lock) pins for the release, the
build says so and goes on; only a release build (`--tag`) insists on them.

Then configure, register, and block the direct path as the
[manual install](install.md#configure-the-targets) describes.

## Tests

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

## Development instance

A checkout fails the [install check](install.md#why-root-owned), so it runs
only as a development instance, alongside the installed one. From the checkout
root, copy the example config, whose two targets are a local bash shell and a
local IRB console:

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

## Building the package

```bash
bin/build-pkg
```

It builds from a commit, never from the working tree: it refuses to start
while `git status` shows a change or an untracked file, or while the running
script differs from HEAD's, and it writes the repository's files into the
stage straight from HEAD's objects, past any local git attribute or filter. It
writes `dist/airlock-X.Y.Z-dev-<commit>.pkg`, versioned from `package.json`
and named after the commit, and prints its path, the commit, its SHA-256, and
the minimum macOS it declares. Only a release build (`--tag vX.Y.Z`, under
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
[`packaging/runtime.lock`](../packaging/runtime.lock) pins by formula, version,
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

## Releasing

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
   `depends_on macos:` line, and moves the release links and tags in the
   [manual install](install.md), the [agent install](agent-install.md), and
   [Install from source](#install-from-source) to the new version. It refuses
   to change anything unless every release link and tag in those docs names
   the cask's current version.

6. Commit and push `Casks/airlock.rb` and the docs. The tap reads the cask,
   and the agent install its instructions, from the default branch.

## Layout

| Path | What |
| --- | --- |
| `src/` | The bridge: MCP stdio server, launch options and install check, config + ssh-config validation, private-socket tmux layer, session manager, output extraction, shell + rails_irb drivers, overlay approval gate, colorizer. |
| `test/` | The test suite (`node --test`); `npm run test:package` adds the package build tests. |
| `bin/` | `airlock-server`, the installed launcher; `airlock-attach`, the attach client; `build-pkg` and `bump-cask`, the release tools; and the gitignored helper build `airlock-approve`. |
| [`airlock-approve.swift`](../airlock-approve.swift) | The overlay helper source; builds to the gitignored `bin/airlock-approve`. |
| [`packaging/`](../packaging) | The package's preinstall script and `runtime.lock`, the Homebrew files its tmux runtime is built from. |
| [`Casks/`](../Casks) | The Homebrew cask; the repository doubles as its tap. |
| [`config.example.json`](../config.example.json) | The target inventory template; the live copy is `/usr/local/libexec/airlock/config.json`. |
| [`config.dev.example.json`](../config.dev.example.json) | The development instance's local targets; the live copy is the gitignored `config.dev.json`. |
| [`docs/`](.) | The [manual install](install.md), the [agent install](agent-install.md) instructions, this guide, and the README's screenshot. |
| [`PLAN.md`](../PLAN.md) | The build plan, kept as a design reference. |
| [`SECURITY.md`](../SECURITY.md) | The threat model, the assumptions the gate depends on, and the open findings from the hardening review. |
