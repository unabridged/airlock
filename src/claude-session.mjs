// Airlock — requesting-session identity.
//
// The MCP initialize handshake names no session: Claude Code sends only a
// constant product clientInfo ("claude-ai", no title — see
// github.com/anthropics/claude-code/issues/41836). The desktop app does,
// however, spawn stdio MCP servers with the requesting session's identity in
// the environment, and keeps each session's human-visible title on disk:
//
//   ~/Library/Application Support/Claude/claude-code-sessions/**/
//       <CLAUDE_CODE_HOST_SESSION_ID>.json
//     { "title": "Fix PROJ-123", ... }                    — the sidebar title
//     (also sought under $CLAUDE_CONFIG_DIR/claude-code-sessions, where
//     earlier app builds kept the store)
//   $CLAUDE_CONFIG_DIR/sessions/<pid>.json
//     { "sessionId": <CLAUDE_CODE_SESSION_ID>, "name": "airlock-86", ... }
//                                — the agent-messaging name; terminal fallback
//
// Both stores are undocumented internals, so every path here fails soft to
// null — the overlay header then falls back to the per-action question.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The metadata file's LOCATION is walked once per identity (the environment
// is constant for the process) and memoized; its CONTENT is re-read on every
// call — the app auto-titles a session a few exchanges in, and the human can
// rename it at any time.
let locatedTitleFile = { key: null, path: null };

export function currentClaudeSessionTitle() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  return (
    desktopSessionTitle(configDir, process.env.CLAUDE_CODE_HOST_SESSION_ID) ||
    agentMessagingSessionName(configDir, process.env.CLAUDE_CODE_SESSION_ID)
  );
}

function desktopSessionTitle(configDir, hostSessionId) {
  if (!hostSessionId) return null;
  const key = `${configDir}\0${hostSessionId}`;
  if (locatedTitleFile.key !== key) {
    locatedTitleFile = { key, path: findDesktopSessionFile(configDir, hostSessionId) };
  }
  if (!locatedTitleFile.path) return null;
  try {
    const metadata = JSON.parse(readFileSync(locatedTitleFile.path, "utf8"));
    return typeof metadata.title === "string" && metadata.title ? metadata.title : null;
  } catch {
    // The store was pruned or rewritten; re-walk on the next approval.
    locatedTitleFile = { key: null, path: null };
    return null;
  }
}

// The store nests session files under two levels of opaque UUID directories;
// the walk stays agnostic to that shape and matches on the file name alone.
// The desktop app keeps the store under its own Application Support
// directory; the CLI config dir is walked second for earlier app builds.
function findDesktopSessionFile(configDir, hostSessionId) {
  const storeRoots = [
    join(homedir(), "Library", "Application Support", "Claude", "claude-code-sessions"),
    join(configDir, "claude-code-sessions"),
  ];
  const wantedFileName = `${hostSessionId}.json`;
  for (const storeRoot of storeRoots) {
    try {
      const match = readdirSync(storeRoot, { recursive: true }).find(
        (entry) => entry === wantedFileName || entry.endsWith(`/${wantedFileName}`),
      );
      if (match) return join(storeRoot, match);
    } catch {
      // Missing store root — try the next one.
    }
  }
  return null;
}

// Terminal-CLI fallback: the per-pid registry maps the CLI session id to the
// session's agent-messaging name (e.g. "airlock-86") — less pretty than the
// desktop title, still far better than a constant. Registry files of dead
// pids can linger with the same session id, so the freshest match wins.
function agentMessagingSessionName(configDir, cliSessionId) {
  if (!cliSessionId) return null;
  const registryDir = join(configDir, "sessions");
  let registryFileNames;
  try {
    registryFileNames = readdirSync(registryDir);
  } catch {
    return null;
  }
  let freshest = null;
  for (const registryFileName of registryFileNames) {
    if (!registryFileName.endsWith(".json")) continue;
    const registryFilePath = join(registryDir, registryFileName);
    try {
      const metadata = JSON.parse(readFileSync(registryFilePath, "utf8"));
      if (metadata.sessionId !== cliSessionId) continue;
      if (typeof metadata.name !== "string" || !metadata.name) continue;
      const modifiedAt = statSync(registryFilePath).mtimeMs;
      if (!freshest || modifiedAt > freshest.modifiedAt) {
        freshest = { name: metadata.name, modifiedAt };
      }
    } catch {
      // Unreadable registry entries are skipped, never fatal.
    }
  }
  return freshest && freshest.name;
}
