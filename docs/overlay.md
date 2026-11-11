# The approval overlay

The panel a person answers before anything runs. This is the visual language as
it stands, written down once so it does not have to be reconstructed from CSS
comments — those comments explain the *why* at each rule; this says what the
whole is.

## What it is

A borderless, non-activating `NSPanel` hosting a `WKWebView`, drawn on macOS
liquid glass. The bridge builds an HTML page (`src/colorize.mjs`), the Swift
helper (`airlock-approve.swift`) hosts it, floats native controls over it, and
answers with one JSON line on stdout. The page is generated per approval; the
helper is generic over the HTML it is handed.

It is the gate: the only place a person sees what will run, and the only place a
command can be stopped.

## The surface

Liquid glass carries the whole panel — page and footer on one surface. The page
itself is transparent; the helper paints a scrim behind it (`#353845` at 40%)
and pins dark appearance so the glass and the note field do not follow the
system theme.

The consequence is a rule: **no opaque fills.** Anything that reads as a filled
block becomes a second panel, and the code block is the panel. Separation is
done with rules, tints, weight, and space — not with background colour.

## Layout, top to bottom

1. **Header** — the instance pill (`DEV`, only for a non-production instance),
   the target badge, and then the pane's working directory. With no pane open
   yet there is nothing honest to say about where, so the action question
   stands in (`Open local-shell?`). The header is also the window's drag strip.
2. **Purpose** — only on `send_terminal`: a quiet `FOR` and the model's one-line
   claim, italic, set off by a rule in the gutter.
3. **Command** — the bytes, colorized, with a line-number gutter, at 80 columns
   plus room for the scrollbar. It scrolls inside the panel; a persistent pill
   counts the rows still below the fold.
4. **Footer** — the note slot (a native text field floated over a painted
   bezel), `Deny` carrying the auto-deny countdown, and a split `Approve` whose
   👀 segment also approves and opens the terminal.

## Type

- **The command** is `Menlo` at 400/19px on a 1.5 line height — the person's
  own VS Code effective size, so the bytes read like their code. Line numbers
  are pseudo-content from `data-n`, so a selection sweeping the command can
  never copy them.
- **Chrome** (badges, the where, the purpose) is the system font. The split is
  deliberate: prose about the command is not the command.
- **The where** is the exception on the chrome side — a path in the command's
  own mono face, muted (`#9aa3bb`), because a path is not prose.
- The body is `calc(2.5em + 80ch + 66px)` wide, capped at the viewport. Lines
  wrap rather than clip; the only text the contract does not bound (a target's
  `display_command`) wraps too.

## Colour

Syntax colouring comes from shiki's `houston`, the same family as the console
colorizer, so the overlay and the terminal agree about what a token is.

| element | colours | meaning |
| --- | --- | --- |
| badge, default | `#454a59` / `#54b9ff` | a target with nothing special about it |
| badge, prod | `#5d3a42` / `#ff96a0` | flags itself red before a word is read |
| badge, staging | `#5b5138` / `#ffd57a` | the rehearsal boundary |
| badge, DEV | `#4b3b6b` / `#cfa8ff` | a non-production *instance*, not a target |
| deny | `#8c3133` | the only exit that stops anything |
| approve | `#27814f` | the act |

One hue per meaning. A new tint has to mean something new; the palette is
already spent on the target badges.

## Three kinds of text, three treatments

The overlay's job is to keep these distinguishable at a glance:

- **the bytes** — mono, syntax-coloured, verbatim. Never reformatted: the only
  canonicalization in the whole path is dropping one trailing newline.
- **a fact** — the pane's directory, observed from tmux, mono and muted.
- **a claim** — the purpose, the model's own words, italic with a gutter rule.

A fact and a claim must never look the same, because one is evidence and the
other is a promise. The rule under the header is what says *this belongs to the
command below it* without making the claim louder than the bytes.

## Constraints that come from the native side

- **The header is the drag strip.** It is `user-select: none` and renders
  nothing interactive; mouse-downs pass through to AppKit. Nothing may be added
  to it that wants a click or a selection.
- **Glyphs must be inline SVG or emoji.** Web fonts cannot resolve the SF
  Symbols' private-use characters in WKWebView, and text glyphs render as tofu
  — which is why the checkmark is an SVG path and the eyes are the emoji.
- **The note field is native.** WKWebView inputs cannot take dictation or paste
  in a non-activating panel, so the field is an `NSTextField` floated over
  `#note-slot`; the page paints only the bezel.
- **Approve has no Return key-equivalent**, so Return while typing can never
  approve. The timeout drops a half-typed note rather than sending it.
- **The helper measures to size itself.** It reads the body's width and the
  `.head` height back from the page, then sets the panel's frame (max 720px, or
  70% of the visible frame) and aligns the drag view to the header it measured.

## Where it lives

| file | what |
| --- | --- |
| `src/colorize.mjs` | the page, its CSS, and the syntax highlighting |
| `src/approval.mjs` | the payload, the helper spawn, the decision parsing |
| `airlock-approve.swift` | the panel, the glass, the native controls |
| `src/purpose.mjs` | what a purpose line may be |
| `src/command-contract.mjs` | what the bytes must satisfy |

## Open

The purpose's mark is a first pass — a 3px rule in the gutter at 28% of the body
colour, with the text colour unchanged. Whether a rule is the right kind of mark
for a claim sitting above the bytes, and whether the claim should sit dimmer or
brighter relative to the command, is a question about taste rather than code:
it is one CSS line either way, and it is open on #21.
