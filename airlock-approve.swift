// Airlock — production approval overlay helper (built to bin/airlock-approve).
//
// This is the Spike C helper, validated as-is, plus one addition: the helper
// watches its parent (the bridge) and exits when orphaned, so a bridge death
// mid-approval — SIGKILL included, where the bridge cannot clean up — never
// strands a panel whose Approve button is wired to nothing.
//
// Reads ONE JSON request on stdin (the parent writes it, then closes the pipe):
//
//   { "html": "<!doctype html>…",
//     "timeoutSeconds": 300,
//     "title": "Airlock — approval required",
//     "silent": false,
//     "watchCommandPath": "~/.local/state/airlock/watch.command" }
//
// Shows a floating, NON-ACTIVATING panel — visible over full-screen apps,
// never steals focus — containing a WKWebView with the parent-rendered HTML.
// The page carries all of the visuals, footer included; its Approve / Deny
// buttons post the decision back over a script message handler. Only the
// free-text note field is native — a chromeless NSTextField floated over the
// page's note slot, because WKWebView inputs cannot take dictation or paste
// reliably inside a non-activating panel. Writes exactly one JSON line to
// stdout:
//
//   {"decision":"approve"} | {"decision":"deny"} | {"decision":"timeout"}
//
// plus a "message" key carrying the note when the human typed one. Closing
// the panel counts as deny. Exit code 0 accompanies any decision; exit code 2
// means the stdin request was unreadable.
//
// Build: /usr/bin/swiftc -O -o bin/airlock-approve airlock-approve.swift

import AppKit
import WebKit

struct ApprovalRequest: Decodable {
  let html: String
  let timeoutSeconds: Double?
  let title: String?
  let silent: Bool?
  // The one-shot attach script behind the page's 👀 button (the right half
  // of the split Approve): opened in Terminal, then the decision proceeds as
  // an approval.
  let watchCommandPath: String?
}

struct Decision: Encodable {
  let decision: String
  // Synthesized Encodable uses encodeIfPresent, so a nil message is omitted
  // from the payload entirely.
  let message: String?
}

// Nonisolated on purpose: callable from button actions, the window delegate,
// and the timeout timer alike. JSONEncoder (not string interpolation) because
// the message is arbitrary human text that needs escaping.
func decide(_ decision: String, message: String? = nil) -> Never {
  let payload = Decision(decision: decision, message: message)
  let encoded = (try? JSONEncoder().encode(payload)) ?? Data("{\"decision\":\"deny\"}".utf8)
  FileHandle.standardOutput.write(encoded)
  FileHandle.standardOutput.write(Data("\n".utf8))
  exit(0)
}

// The page metrics {didFinish} reads out of the rendered approval page: the
// body height sizes the panel, the note-slot rect positions the native note
// field over the page's slot, and the header height bounds the window's
// drag strip.
struct PageMetrics: Decodable {
  struct Slot: Decodable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double
  }

  let height: Double
  let headerHeight: Double
  let slot: Slot
}

@MainActor
final class ApprovalPanelController: NSObject, NSWindowDelegate, WKNavigationDelegate, WKScriptMessageHandler {
  var messageField: NSTextField?
  var watchCommandPath: String?
  // Wired by {presentOverlay}: receives the rendered page's metrics (nil when
  // measurement fails) so the panel can open content-sized with the note
  // field aligned to the page's slot.
  var pageMeasured: ((PageMetrics?) -> Void)?

  @objc func approve(_ sender: Any?) { decide("approve", message: feedbackMessage()) }
  @objc func deny(_ sender: Any?) { decide("deny", message: feedbackMessage()) }
  func windowWillClose(_ notification: Notification) { decide("deny", message: feedbackMessage()) }

  // The page's buttons post their decision here. "watch" is the 👀 half of
  // the split Approve: open the terminal on the session, then approve.
  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    switch message.body as? String {
    case "approve": approve(nil)
    case "deny": deny(nil)
    case "watch": openTerminalThenApprove()
    default: break
    }
  }

  // /usr/bin/open routes the .command file to iTerm2 when installed (it
  // registers for shell scripts and runs them in a window), falling back to
  // the system default (Terminal). The wait is for `open`'s LaunchServices
  // handoff only (fast), so the approval is never written before the launch
  // request exists; a missing or failing script still approves — the human
  // pressed an Approve segment.
  private func openTerminalThenApprove() {
    if let watchCommandPath {
      let openProcess = Process()
      openProcess.executableURL = URL(fileURLWithPath: "/usr/bin/open")
      let iTermURL = NSWorkspace.shared.urlForApplication(
        withBundleIdentifier: "com.googlecode.iterm2")
      openProcess.arguments =
        iTermURL.map { ["-a", $0.path, watchCommandPath] } ?? [watchCommandPath]
      try? openProcess.run()
      openProcess.waitUntilExit()
    }
    approve(nil)
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    // The body's laid-out box, NOT scrollHeight: scrollHeight is clamped to
    // at least the viewport, and the view is still full-height while loading.
    // Missing #note-slot makes the script throw, which lands in the fallback.
    let measurementScript = """
      JSON.stringify({
        height: document.body.getBoundingClientRect().height,
        headerHeight: document.querySelector(".head").getBoundingClientRect().height,
        slot: (({x, y, width, height}) => ({x, y, width, height}))(
          document.getElementById("note-slot").getBoundingClientRect())
      })
      """
    webView.evaluateJavaScript(measurementScript) { [weak self] result, _ in
      let pageMetrics = (result as? String)
        .flatMap { try? JSONDecoder().decode(PageMetrics.self, from: Data($0.utf8)) }
      self?.pageMeasured?(pageMetrics)
    }
  }

  private func feedbackMessage() -> String? {
    let text = messageField?.stringValue.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    return text.isEmpty ? nil : text
  }
}

// NSTextFieldCell top-aligns its text when the field is taller than one
// line; this cell centers the text, the placeholder, and the field editor
// in the oversized footer note field, with extra horizontal breathing room
// inside the page's note slot.
final class VerticallyCenteredTextFieldCell: NSTextFieldCell {
  private let horizontalPadding: CGFloat = 8
  // Set while the field editor is being framed: {drawingRect} must not
  // center twice — the edit/select overrides below already pass it the
  // adjusted rect.
  private var framingFieldEditor = false

  // The plain text line height, NOT cellSize: cellSize folds in the bezel's
  // own top-heavy padding, so centering that box leaves the glyphs sitting
  // visibly above true center.
  private func textLineHeight() -> CGFloat {
    guard let font else { return 17 }
    return NSLayoutManager().defaultLineHeight(for: font)
  }

  override func drawingRect(forBounds bounds: NSRect) -> NSRect {
    var rect = super.drawingRect(forBounds: bounds)
    if framingFieldEditor { return rect }
    rect.origin.x += horizontalPadding
    rect.size.width -= horizontalPadding * 2
    let lineHeight = textLineHeight()
    if bounds.height > lineHeight {
      rect.origin.y = (bounds.origin.y + (bounds.height - lineHeight) / 2).rounded()
      rect.size.height = lineHeight
    }
    return rect
  }

  // Clicking into the field hands drawing over to the window's field editor,
  // which is framed from the raw cell bounds — top-left, no padding. Frame
  // it from the same centered rect the idle cell draws in.
  override func edit(withFrame rect: NSRect, in controlView: NSView, editor textObj: NSText, delegate: Any?, event: NSEvent?) {
    let centeredRect = drawingRect(forBounds: rect)
    framingFieldEditor = true
    super.edit(withFrame: centeredRect, in: controlView, editor: textObj, delegate: delegate, event: event)
    framingFieldEditor = false
  }

  override func select(withFrame rect: NSRect, in controlView: NSView, editor textObj: NSText, delegate: Any?, start selStart: Int, length selLength: Int) {
    let centeredRect = drawingRect(forBounds: rect)
    framingFieldEditor = true
    super.select(withFrame: centeredRect, in: controlView, editor: textObj, delegate: delegate, start: selStart, length: selLength)
    framingFieldEditor = false
  }
}

// The helper is an .accessory app with no menu bar, so ⌘V/⌘C/⌘X/⌘A have no
// Edit menu to route through and would be dead in the note field. Handle the
// standard editing key equivalents on the panel itself, targeting the first
// responder (the field editor).
final class ApprovalPanel: NSPanel {
  // Escape denies. The panel handles the key itself now that the deny button
  // lives in the page's HTML, where key equivalents cannot reach.
  var escapePressed: (() -> Void)?

  // Borderless windows refuse key status by default, which would make the
  // note field untypeable.
  override var canBecomeKey: Bool { true }

  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    // 53 is the hardware key code for Escape.
    if event.keyCode == 53 {
      escapePressed?()
      return true
    }
    if event.modifierFlags.intersection(.deviceIndependentFlagsMask) == .command,
       let characters = event.charactersIgnoringModifiers {
      let action: Selector?
      switch characters {
      case "v": action = #selector(NSText.paste(_:))
      case "c": action = #selector(NSText.copy(_:))
      case "x": action = #selector(NSText.cut(_:))
      case "a": action = #selector(NSText.selectAll(_:))
      case "z": action = Selector(("undo:"))
      default: action = nil
      }
      if let action, NSApp.sendAction(action, to: nil, from: self) { return true }
    }
    return super.performKeyEquivalent(with: event)
  }
}

// With the footer living inside the page there is no native strip left to
// grab, so this transparent view floats over the page's header and drags
// the window. Only the header: a page-wide drag region would swallow the
// mouse-downs that start a text selection in the command block. A
// {mouseDownCanMoveWindow} override on the web view cannot express that —
// AppKit caches the answer when it builds the window's draggable region
// instead of re-asking per mouse-down — so the strip drags directly.
final class DragStripView: NSView {
  // First click drags even while the panel is unfocused.
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }

  override func mouseDown(with event: NSEvent) {
    window?.performDrag(with: event)
  }
}

// The panel floats over whatever app the human is working in, so the first
// click must press the page's buttons directly — NSView's default swallows
// it to focus the window, costing an extra click.
final class FirstMouseWebView: WKWebView {
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
}

@MainActor
func presentOverlay(for approvalRequest: ApprovalRequest) {
  let application = NSApplication.shared
  // .accessory: no Dock icon, no menu bar, and the app never becomes active —
  // the frontmost app (e.g. a full-screen video player) keeps focus.
  application.setActivationPolicy(.accessory)

  let controller = ApprovalPanelController()

  let panelWidth: CGFloat = 680
  // The panel opens at the height its content actually needs — measured from
  // the rendered page — capped at maxPanelHeight (longer commands scroll
  // inside the page's <pre> while the page's footer stays pinned).
  let maxPanelHeight: CGFloat = 440
  let minPanelHeight: CGFloat = 140
  // Clear margin reserved around the glass for the design's drop shadow
  // (0 10px 30px at 17% black): wide enough for the offset plus the blur.
  let shadowMargin: CGFloat = 40

  let panel = ApprovalPanel(
    contentRect: NSRect(
      x: 0, y: 0, width: panelWidth + shadowMargin * 2, height: maxPanelHeight + shadowMargin * 2),
    styleMask: [.borderless, .nonactivatingPanel],
    backing: .buffered,
    defer: false
  )
  // No title bar at all (user preference) — the HTML header carries the
  // context, Deny/Escape replace the close button. The title still serves
  // accessibility.
  panel.title = approvalRequest.title ?? "Airlock — approval required"
  panel.isOpaque = false
  panel.backgroundColor = .clear
  // No window-server shadow: it derives a borderless window's shadow shape
  // from its opaque pixels and traces it with a hairline dark outline, which
  // lands as a visibly squarer black border poking past the glass corners.
  // The design's soft drop shadow is drawn instead by the container layer
  // below, from an explicit rounded-rect path.
  panel.hasShadow = false
  // With no title bar to grab, allow dragging by the window background —
  // which {DraggableWebView} extends to the page itself.
  panel.isMovableByWindowBackground = true
  // .statusBar floats above normal windows and full-screen video; the
  // collection behavior makes it appear on every Space (full-screen Spaces
  // included) without switching Spaces or stealing focus.
  panel.level = .statusBar
  panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
  panel.isFloatingPanel = true
  panel.hidesOnDeactivate = false
  // Clicking into the note field makes the panel key (so typing works) while
  // the app itself stays inactive — nothing loses full-screen or focus.
  panel.becomesKeyOnlyIfNeeded = true
  panel.isReleasedWhenClosed = false
  panel.delegate = controller

  // The controls live in a plain view hosted on liquid glass (below). The
  // view itself carries only a 40% wash of the sampled #353845 slate over
  // the glass, rounded to the panel radius so the corners stay glass-clean.
  let contentView = NSView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: maxPanelHeight))
  contentView.autoresizingMask = [.width, .height]
  contentView.wantsLayer = true
  contentView.layer?.backgroundColor = NSColor(srgbRed: 0x35 / 255.0, green: 0x38 / 255.0, blue: 0x45 / 255.0, alpha: 0.4).cgColor
  contentView.layer?.cornerRadius = 14
  contentView.layer?.masksToBounds = true

  // The page's Deny/Approve buttons post "deny"/"approve" to this handler.
  // No Return key routing anywhere: Return while typing in the note field
  // must never approve the command; Escape denies via {ApprovalPanel}.
  let webViewConfiguration = WKWebViewConfiguration()
  webViewConfiguration.userContentController.add(controller, name: "decision")

  let webView = FirstMouseWebView(
    frame: NSRect(x: 0, y: 0, width: panelWidth, height: maxPanelHeight),
    configuration: webViewConfiguration
  )
  webView.autoresizingMask = [.width, .height]
  webView.navigationDelegate = controller
  // WKWebView paints an opaque page background unless told otherwise —
  // "drawsBackground" is the long-standing exposed toggle. Transparent, the
  // page rides on the liquid glass.
  webView.setValue(false, forKey: "drawsBackground")
  webView.loadHTMLString(approvalRequest.html, baseURL: nil)
  contentView.addSubview(webView)

  // Above the web view, so header mouse-downs drag the window instead of
  // reaching the page — the header renders nothing interactive, so nothing
  // is lost. The height is the pre-measurement fallback; {revealPanel}
  // matches it to the header the page reports.
  let dragStripView = DragStripView(frame: NSRect(x: 0, y: maxPanelHeight - 60, width: panelWidth, height: 60))
  dragStripView.autoresizingMask = [.width, .minYMargin]
  contentView.addSubview(dragStripView)

  // Chromeless: the page's #note-slot paints the bezel, this field brings
  // the native text editing (dictation, paste) that WKWebView inputs cannot
  // offer in a non-activating panel. The frame is the pre-measurement
  // fallback; {revealPanel} aligns it to the slot the page reports.
  let messageField = NSTextField(frame: NSRect(x: 18, y: 18, width: panelWidth - 260, height: 43))
  // Replacing the cell resets the field's editability — restore it
  // explicitly after the swap.
  messageField.cell = VerticallyCenteredTextFieldCell(textCell: "")
  messageField.isEditable = true
  messageField.isSelectable = true
  // Both flags: {isBezeled} false alone leaves {isBordered} drawing a plain
  // square 1px line over the page's rounded slot.
  messageField.isBezeled = false
  messageField.isBordered = false
  messageField.drawsBackground = false
  messageField.focusRingType = .none
  messageField.textColor = .white
  messageField.usesSingleLineMode = true
  messageField.placeholderString = "Message"
  messageField.font = NSFont.systemFont(ofSize: 17)
  contentView.addSubview(messageField)
  controller.messageField = messageField
  controller.watchCommandPath = approvalRequest.watchCommandPath

  panel.escapePressed = { controller.deny(nil) }

  // Liquid glass carries the whole panel: page and footer sit on one glass
  // surface. Dark appearance is pinned so the glass (and the note field)
  // stay dark over any desktop, in light mode too. Older systems fall back
  // to the HUD blur material.
  let glassHostView: NSView
  if #available(macOS 26.0, *) {
    let glassView = NSGlassEffectView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: maxPanelHeight))
    glassView.cornerRadius = 14
    glassView.contentView = contentView
    glassHostView = glassView
  } else {
    let effectView = NSVisualEffectView(frame: NSRect(x: 0, y: 0, width: panelWidth, height: maxPanelHeight))
    effectView.material = .hudWindow
    effectView.state = .active
    effectView.wantsLayer = true
    effectView.layer?.cornerRadius = 14
    effectView.layer?.masksToBounds = true
    effectView.addSubview(contentView)
    glassHostView = effectView
  }
  // The glass floats inside a clear container whose layer casts the drop
  // shadow from an explicit rounded-rect path — no opaque pixels needed.
  // shadowOffset is negative because AppKit's Y axis points up, and the
  // radius is the Gaussian sigma (about half of CSS's 30px blur length).
  let containerView = NSView(
    frame: NSRect(x: 0, y: 0, width: panelWidth + shadowMargin * 2, height: maxPanelHeight + shadowMargin * 2))
  containerView.wantsLayer = true
  containerView.layer?.shadowColor = NSColor.black.cgColor
  containerView.layer?.shadowOpacity = 0.17
  containerView.layer?.shadowRadius = 15
  containerView.layer?.shadowOffset = CGSize(width: 0, height: -10)
  glassHostView.frame = NSRect(x: shadowMargin, y: shadowMargin, width: panelWidth, height: maxPanelHeight)
  containerView.layer?.shadowPath = CGPath(
    roundedRect: glassHostView.frame, cornerWidth: 14, cornerHeight: 14, transform: nil)
  containerView.addSubview(glassHostView)
  panel.contentView = containerView
  panel.appearance = NSAppearance(named: .darkAqua)

  // The panel stays offscreen until the page reports its rendered height, so
  // it opens exactly content-sized instead of flashing full-height and
  // shrinking. The fallback timer covers a page that never finishes loading
  // or a failed measurement: an approval panel must always appear,
  // full-height if need be.
  var panelRevealed = false
  let revealPanel: (PageMetrics?) -> Void = { pageMetrics in
    if panelRevealed { return }
    panelRevealed = true
    var glassHeight = maxPanelHeight
    if let pageMetrics {
      glassHeight = min(maxPanelHeight, max(minPanelHeight, CGFloat(pageMetrics.height).rounded(.up)))
      panel.setContentSize(NSSize(width: panelWidth + shadowMargin * 2, height: glassHeight + shadowMargin * 2))
      glassHostView.frame = NSRect(x: shadowMargin, y: shadowMargin, width: panelWidth, height: glassHeight)
      containerView.layer?.shadowPath = CGPath(
        roundedRect: glassHostView.frame, cornerWidth: 14, cornerHeight: 14, transform: nil)
      let headerHeight = CGFloat(pageMetrics.headerHeight)
      // Frame against the content view's current height, not {glassHeight}:
      // NSGlassEffectView resizes its content view lazily, so it may still be
      // {maxPanelHeight} tall here, and the top-pinned strip follows it down.
      dragStripView.frame = NSRect(
        x: 0, y: contentView.bounds.height - headerHeight, width: panelWidth, height: headerHeight)
      // The page and the glass share an origin and a scale, differing only
      // in the Y axis: web rects grow downward from the top-left, AppKit
      // frames upward from the bottom-left — hence the height flip. GLASS
      // coordinates, not panel coordinates: the shadow margin sits between.
      messageField.frame = NSRect(
        x: pageMetrics.slot.x,
        y: glassHeight - (pageMetrics.slot.y + pageMetrics.slot.height),
        width: pageMetrics.slot.width,
        height: pageMetrics.slot.height
      )
    }
    // The 24pt screen-corner margins apply to the visible GLASS edges; the
    // clear shadow margin around it must not push the panel further in.
    if let screen = NSScreen.main {
      let visible = screen.visibleFrame
      panel.setFrameOrigin(NSPoint(
        x: visible.maxX - 24 - panelWidth - shadowMargin,
        y: visible.maxY - 24 - glassHeight - shadowMargin
      ))
    }
    if approvalRequest.silent != true {
      NSSound(named: "Hero")?.play()
    }
    // orderFrontRegardless shows the panel without activating the app — the
    // whole point of the non-activating design.
    panel.orderFrontRegardless()
  }
  controller.pageMeasured = revealPanel
  DispatchQueue.main.asyncAfter(deadline: .now() + 1) { revealPanel(nil) }

  let timeoutSeconds = approvalRequest.timeoutSeconds ?? 300
  // Timeout deliberately drops any half-typed note: nobody was there to send it.
  DispatchQueue.main.asyncAfter(deadline: .now() + timeoutSeconds) { decide("timeout") }

  // Orphan watch: macOS reparents this helper (to pid 1) the moment the
  // bridge dies, covering even SIGKILL, where the bridge's own cleanup never
  // runs. Exit silently — there is nobody left to read a decision.
  Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { _ in
    if getppid() != bridgeProcessIdentifier { exit(0) }
  }

  // run() never returns, which also keeps `controller` (the weak
  // delegate/target) alive on this frame.
  application.run()
}

// The bridge's pid, captured before anything else. Already-reparented (the
// bridge died between spawning this helper and this line) means there is no
// approval to collect — exit before any panel exists.
let bridgeProcessIdentifier = getppid()
if bridgeProcessIdentifier == 1 { exit(0) }

let requestData = FileHandle.standardInput.readDataToEndOfFile()
guard let approvalRequest = try? JSONDecoder().decode(ApprovalRequest.self, from: requestData) else {
  FileHandle.standardError.write(Data("airlock-approve: expected a JSON request object on stdin\n".utf8))
  exit(2)
}

// Top-level code runs on the main thread, but Swift's default language mode
// does not treat it as MainActor-isolated — assert the isolation explicitly.
MainActor.assumeIsolated { presentOverlay(for: approvalRequest) }
