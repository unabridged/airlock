cask "airlock" do
  version "1.0.0"
  sha256 "88df7c5a6908f38741a402927767270e9f9b42cc6b9ad9ec7d8f639df441e64a"

  url "https://github.com/unabridged/airlock/releases/download/v#{version}/airlock-#{version}.pkg"
  name "Airlock"
  desc "Human-gated remote terminal bridge for Claude Code"
  homepage "https://github.com/unabridged/airlock"

  depends_on arch: :arm64
  depends_on macos: :tahoe

  pkg "airlock-#{version}.pkg"

  uninstall pkgutil: "com.unabridgedsoftware.airlock"

  zap delete: "/usr/local/libexec/airlock/config.json",
      trash:  "~/.local/state/airlock",
      rmdir:  "/usr/local/libexec/airlock"

  caveats <<~EOS
    Airlock installs to /usr/local/libexec/airlock, owned by root, and
    refuses to start if any part of it is writable by a non-root user.

    Its targets live in a root-owned config file, so edit it with sudo.
    Start from the shipped example:
      sudo cp /usr/local/libexec/airlock/config.example.json /usr/local/libexec/airlock/config.json

    Register the server with Claude Code:
      claude mcp add --scope user airlock -- /usr/local/libexec/airlock/bin/airlock-server

    Uninstalling keeps config.json; zap removes it.
  EOS
end
