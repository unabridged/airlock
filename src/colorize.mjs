// Airlock — command colorization and approval-page HTML.
//
// Shiki highlights the command with VS Code's own TextMate grammar and the
// Houston theme; the page CSS mirrors that theme's editor chrome. The
// highlighter loads lazily (warmed at import, ahead of the first gated
// call); if it cannot load, the page falls back to escaped plain text — an
// approval panel must always render.

const THEME = "houston";
const LANGUAGE = "ruby";

let highlighterPromise = null;
function highlighter() {
  highlighterPromise ??= import("shiki")
    .then(({ createHighlighter }) => createHighlighter({ themes: [THEME], langs: [LANGUAGE] }))
    .catch(() => null);
  return highlighterPromise;
}
void highlighter();

export function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

// Returns highlighted HTML with the original newlines preserved so the
// approval page can split it into per-line rows; escaped plain text when
// the highlighter is unavailable.
export async function highlightRuby(code) {
  const loadedHighlighter = await highlighter();
  if (!loadedHighlighter) return escapeHtml(code);
  try {
    // Tokens whose color is the theme's default foreground stay unwrapped:
    // the page body is already that color, and most tokens are plain.
    const themeForeground = loadedHighlighter.getTheme(THEME).fg?.toLowerCase();
    return loadedHighlighter
      .codeToTokensBase(code, { lang: LANGUAGE, theme: THEME })
      .map((lineTokens) => lineTokens.map((token) => tokenHtml(token, themeForeground)).join(""))
      .join("\n");
  } catch {
    return escapeHtml(code);
  }
}

// Shiki's fontStyle is a bitmask (1 italic, 2 bold, 4 underline) with -1
// meaning "not set" — the > 0 guard keeps -1 from matching every bit.
function tokenHtml(token, themeForeground) {
  const escaped = escapeHtml(token.content);
  const fontStyle = token.fontStyle > 0 ? token.fontStyle : 0;
  const styles = [
    token.color && token.color.toLowerCase() !== themeForeground ? `color:${token.color}` : "",
    fontStyle & 1 ? "font-style:italic" : "",
    fontStyle & 2 ? "font-weight:600" : "",
    fontStyle & 4 ? "text-decoration:underline" : "",
  ].filter(Boolean);
  if (styles.length === 0) return escaped;
  return `<span style="${styles.join(";")}">${escaped}</span>`;
}

// Chip tint by environment: production targets flag red, staging yellow,
// anything else the default blue.
function badgeClass(badge) {
  if (/prod/i.test(badge)) return "badge prod";
  if (/staging/i.test(badge)) return "badge staging";
  return "badge";
}

// Renders a target id as chip text: "acme-production-console" becomes
// "Acme Production Console".
function humanizeBadge(badge) {
  return badge
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

// The approval page: a header row (badge, requesting Claude Code session name
// or the action question) above the colorized command, above a footer the
// page owns — a note slot that the helper's native text field overlays
// (WKWebView inputs cannot take dictation or paste in a non-activating
// panel), a Deny button carrying the auto-deny countdown, and a split
// Approve button whose 👀 segment also opens the terminal on the session.
// All decisions post through {window.webkit.messageHandlers.decision}.
export async function buildApprovalHtml({ command, badge, headerText, timeoutSeconds }) {
  const lines = (await highlightRuby(command)).split("\n");
  const rows = lines
    .map(
      (lineHtml, index) =>
        `<div class="ln"><span class="n" data-n="${index + 1}"></span><span class="c">${lineHtml || "&nbsp;"}</span></div>`,
    )
    .join(""); // the rows sit inside a <pre>: a literal newline here would double-space

  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  /* Chrome colors mirror Shiki's houston theme: editor bg/fg, group
     border, and line-number gutter — keep them in sync with {THEME}. */
  /* Transparent: the native liquid-glass chrome in airlock-approve.swift is
     the surface behind both this page and the footer controls. */
  html, body { margin: 0; padding: 0; background: transparent; color: #eef0f9;
               -webkit-font-smoothing: antialiased;
               /* Menlo at 400, matching the user's VS Code effective size
                  (12px setting x 1.2^2.5 window zoom ~ 19px). Line height
                  1.5 is VS Code's own computed default on macOS (its golden
                  ratio when editor.lineHeight is unset) — keep them in sync. */
               font: 400 19px/1.5 Menlo, monospace; }
  /* Column layout capped at the viewport so a long command scrolls inside
     the <pre> while the footer stays pinned to the panel bottom. */
  body { display: flex; flex-direction: column; max-height: 100vh; }
  .head, .foot { flex: none; }
  /* The header doubles as the window's drag strip — unselectable, so WebKit
     passes its mouse-downs through to AppKit instead of starting a text
     selection. */
  .head { display: flex; align-items: center; gap: 12px; padding: 18px;
          font-family: -apple-system, system-ui, sans-serif;
          -webkit-user-select: none; user-select: none; }
  /* ui-rounded resolves to SF Pro Rounded inside WKWebView. */
  .badge { background: #454a59; color: #54b9ff; border-radius: 999px;
           padding: 4px 14px; font: 600 17px/1.5 ui-rounded, -apple-system,
           system-ui, sans-serif; letter-spacing: 0.43px; }
  /* Production targets flag themselves red, staging yellow, before the
     human reads a word. */
  .badge.prod { background: #5d3a42; color: #ff96a0; }
  .badge.staging { background: #5b5138; color: #ffd57a; }
  .title { color: #d6d9e9; font-size: 18px; font-weight: 510; }
  /* Overflowing code fades out at the right edge instead of hard-clipping;
     the mask is a fixed window over the scroll box, so the fade holds its
     place while the command scrolls beneath it. */
  pre { margin: 0; padding: 0 0 5px; overflow: auto; flex: 1 1 auto; min-height: 0;
        -webkit-mask-image: linear-gradient(90deg, #000 618px, transparent 670px);
        mask-image: linear-gradient(90deg, #000 618px, transparent 670px); }
  .ln { display: flex; }
  /* Line numbers render as pseudo-content from data-n: generated content is
     not part of the document, so a selection sweeping the command can never
     highlight or copy the gutter. */
  .ln .n { flex: none; width: 1.75em; text-align: right; padding-right: 0.75em;
           color: #545864; -webkit-user-select: none; user-select: none; }
  .ln .n::before { content: attr(data-n); }
  .ln .c { white-space: pre; padding-right: 14px; }
  .foot { display: flex; align-items: center; gap: 12px; padding: 18px;
          font-family: -apple-system, system-ui, sans-serif;
          -webkit-user-select: none; }
  /* Visual-only: the helper floats its chromeless NSTextField over this box,
     so the box paints the bezel and the field brings the text editing. */
  #note-slot { flex: 1 1 auto; height: 43px; border-radius: 10px;
               box-sizing: border-box;
               background: rgba(255, 255, 255, 0.08);
               box-shadow: 0 3px 9px rgba(0, 0, 0, 0.1); }
  .foot button { flex: none; display: flex; align-items: center; border: none;
                 color: rgba(255, 255, 255, 0.8);
                 text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
                 font: 600 16px -apple-system, system-ui, sans-serif;
                 letter-spacing: -0.31px; padding: 12px 16px;
                 box-shadow: 0 3px 9px rgba(0, 0, 0, 0.1); }
  .foot button:hover, .foot button:active { filter: brightness(1.2); }
  /* Every control outline is a 1px vertical-gradient stroke drawn OUTSIDE
     the box. CSS borders cannot hold gradients, so each ring is a masked
     pseudo-element hugging the box from outside. */
  #note-slot, button.deny, .approve-group { position: relative; }
  #note-slot::before, button.deny::before, .approve-group::before {
    content: ""; position: absolute; inset: -1px; padding: 1px;
    border-radius: 11px; pointer-events: none;
    -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    -webkit-mask-composite: xor;
    mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
    mask-composite: exclude; }
  #note-slot::before { background: linear-gradient(#595b63, #4a4c52); }
  button.deny::before {
    background: linear-gradient(rgba(163, 90, 92, 0.8), rgba(61, 34, 34, 0.8)); }
  .approve-group::before { background: linear-gradient(#529a72, #1c3427); }
  button.deny { gap: 10px; background: #8c3133; border-radius: 10px; }
  /* The countdown lives inside Deny — pressing it is the same outcome the
     timer walks toward. Fixed width, right-aligned: ticking digits change
     glyph widths, and without a reserved box the whole button dances. */
  button.deny .countdown { font-weight: 400; color: rgba(255, 255, 255, 0.6);
                           width: 3ch; text-align: right; }
  /* Split button: the left segment approves; the right "eyes" segment also
     approves, and opens the terminal attached to the session. */
  .approve-group { flex: none; display: flex; align-items: stretch;
                   border-radius: 10px;
                   box-shadow: 0 3px 9px rgba(0, 0, 0, 0.1); }
  .approve-group button { background: #27814f; box-shadow: none; }
  button.approve { gap: 6px; border-radius: 10px 0 0 10px; position: relative; }
  /* Divider: each segment paints its own 1px inside edge — a barely-there
     dark-to-green gradient on the left half, rim green on the right. */
  button.approve::after { content: ""; position: absolute; inset: 0 0 0 auto;
    width: 1px;
    background: linear-gradient(rgba(28, 52, 38, 0.15), rgba(83, 154, 113, 0.15)); }
  button.eyes { border-left: 1px solid #529a72; border-radius: 0 10px 10px 0; }
  /* The approve checkmark is an inline SVG tracing of the mockup's SF
     Symbol: no web font stack resolves the symbols' private-use characters
     — WKWebView included — so text glyphs render as tofu boxes. The eyes
     are the plain emoji, which Apple Color Emoji renders everywhere. */
  .glyph { flex: none; }
  button.eyes .glyph { font-size: 17px; line-height: 1; text-shadow: none; }
</style></head><body>
  <div class="head">
    <span class="${badgeClass(badge)}">${escapeHtml(humanizeBadge(badge))}</span>
    <span class="title">${escapeHtml(headerText)}</span>
  </div>
  <pre>${rows}</pre>
  <div class="foot">
    <div id="note-slot"></div>
    <button class="deny">Deny <span class="countdown" id="countdown">${Number(timeoutSeconds)}</span></button>
    <div class="approve-group">
      <button class="approve"><svg class="glyph" width="14" height="12" viewBox="0 0 14 12"><path d="M1 6.5 5 10.5 13 1.5" fill="none" stroke="rgba(255,255,255,0.8)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg> Approve</button>
      <button class="eyes" title="Approve and open the terminal"><span class="glyph">👀</span></button>
    </div>
  </div>
  <script>
    (() => {
      const countdown = document.getElementById("countdown");
      let remainingSeconds = Number(countdown.textContent);
      setInterval(() => {
        if (remainingSeconds > 0) countdown.textContent = --remainingSeconds;
      }, 1000);
      // Optional chaining: outside the helper (e.g. the Figma design
      // scaffold) there is no webkit bridge, and the buttons are inert.
      const decide = (decision) =>
        window.webkit?.messageHandlers?.decision?.postMessage(decision);
      document.querySelector(".deny").addEventListener("click", () => decide("deny"));
      document.querySelector(".approve").addEventListener("click", () => decide("approve"));
      // The 👀 half of the split Approve: the helper opens the terminal on
      // the session, then records the decision as an approval.
      document.querySelector(".eyes").addEventListener("click", () => decide("watch"));
    })();
  </script>
</body></html>`;
}
