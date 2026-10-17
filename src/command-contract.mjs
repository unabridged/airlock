// Airlock — the command style contract: what every send_terminal command
// must satisfy before the human sees it in the approval overlay.
//
// The overlay renders the command verbatim at COMMAND_COLUMNS columns, so
// the contract keeps what the human reads both byte-faithful and legible.
// Characters the overlay cannot show faithfully (controls, bidi and
// zero-width formatting, spaces that merely look like spaces) are rejected
// outright; the style rules (width, one statement per line, no comments,
// full-word names, labeled sections) keep a reviewer from approving a dense
// one-liner they cannot actually read. The bridge never reformats: a command
// that breaks the contract is rejected with every violation listed, and the
// model resends. The only canonicalization is dropping one trailing LF,
// which the drivers would strip anyway.

export const COMMAND_COLUMNS = 80;
export const MAX_COMMAND_LINES = 60;
export const MAX_COMMAND_BYTES = 32 * 1024;

const MAX_LISTED_VIOLATIONS = 20;
const EXCERPT_LENGTH = 60;

// The Claude-facing statement of the contract. The send_terminal tool
// description and the initialize instructions are generated from it, so the
// guidance the model reads and the rules the bridge enforces cannot drift.
export const CONTRACT_SPEC_TEXT = [
  "Style contract for the command text (the overlay shows it verbatim at " +
    `${COMMAND_COLUMNS} columns; commands that break the contract are rejected ` +
    "before the human sees them):",
  `- at most ${COMMAND_COLUMNS} columns per line and ${MAX_COMMAND_LINES} lines ` +
    "per send; split a longer script into several sends (console state " +
    "persists between sends)",
  "- one statement per line: never join statements with `;`",
  "- no comment lines; the code reads on its own through its names",
  "- full-word variable names (`order`, not `o`, `tmp`, or `res`)",
  "- spaces around `=` and after every comma",
  "- one blank line between sections, and each section ends in a labeled " +
    'print such as `puts "label: #{value}"` (a multi-statement console paste ' +
    "prints only its final value)",
  "- arrays fill-wrapped: several elements per line, up to " +
    `${COMMAND_COLUMNS} columns, never one element per line`,
  "- one leading-dot chained call per line",
  "- shell: wrap a long line with a trailing backslash, but prefer one-line " +
    "control flow (`for f in *.log; do wc -l $f; done`) because each " +
    "continuation line costs about a second",
  "- plain ASCII outside string contents: no tabs, control characters, " +
    "zero-width or bidi characters, or non-ASCII spaces",
  "Example (12 lines):",
  "user = User.find(1234)",
  "orders = user.orders.includes(:line_items, :payments).to_a",
  'puts "orders: #{orders.size}"',
  "",
  "status_counts = orders",
  "  .map { |order| order.status }",
  "  .tally",
  'puts "status counts: #{status_counts.inspect}"',
  "",
  "late_order_ids = [10001, 10002, 10003, 10004, 10005, 10006, 10007]",
  'late_orders = Order.where(id: late_order_ids, status: "late").count',
  'puts "late orders: #{late_orders}"',
].join("\n");

// The worked example alone, for the tests that prove the spec's own example
// passes the contract it illustrates.
export const CONTRACT_EXAMPLE_COMMAND = CONTRACT_SPEC_TEXT.split("Example (12 lines):\n")[1];

const SHORT_NAME_ALLOWLIST = new Set(["id"]);
const GENERIC_NAMES = new Set([
  "tmp", "obj", "val", "vals", "res", "ret", "arr", "str", "num", "rec", "recs",
  "cnt", "idx", "elem", "item", "items", "data", "result", "results",
]);

// A printer anywhere on the line counts (a `puts` inside a block included),
// as long as it is not a method on some other receiver: `Rails.logger.info`
// and `report.print` do not print to the console.
const OUTPUT_CALL_PATTERN =
  /(?:^|[^\w.$@:])(?:(?:\$stdout|\$stderr|STDOUT|STDERR)\.(?:puts|print|write|printf)|Kernel\.(?:puts|pp|p|print|printf)|puts|pp|p|print|ap|printf|warn)\b/;

// Heredoc openers, per driver. Ruby allows no space after `<<`, so
// `ids << user.id` is an append, never a heredoc. Shell allows the space but
// `<<<` (a here-string) is not a heredoc.
const RUBY_HEREDOC_OPENER = /<<([~-]?)(["'`]?)([A-Z_][A-Z0-9_]*)\2/;
const SHELL_HEREDOC_OPENER = /(?<!<)<<(?!<)(-?)\s*(["']?)(\w+)\2/;

// A line holding exactly one scalar literal (or bare name) and its comma:
// the shape of a one-element-per-line array. Method calls and other
// expressions are not scalars, so an array of expressions may stay one per
// line.
const SCALAR_ELEMENT_LINE = /^\s*(?:\w+|:\w+|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'),\s*$/;
const ARRAY_OPENER_LINE = /\[\s*$/;
const SHELL_STATEMENT_EXEMPTIONS = /\\;|;\s*(?:do|then|done|fi|else|elif|esac)\b|;;/g;
const ASSIGNMENT_PATTERN =
  /^(\s*)([a-z_]\w*(?:\s*,\s*[a-z_]\w*)*)(\s*)(\|\||&&|[-+*/|&])?=(?![=~>])(\s*)(\S?)/;
const BLOCK_PARAMS_PATTERN = /(?:\bdo|\{)\s*\|([^|]*)\|/;

const KNOWN_CODE_POINT_NAMES = {
  0x00: "NUL", 0x08: "BS", 0x09: "TAB", 0x0d: "CR", 0x1b: "ESC", 0x7f: "DEL",
  0xa0: "NO-BREAK SPACE", 0x200b: "ZERO WIDTH SPACE", 0x200e: "LRM",
  0x200f: "RLM", 0x2003: "EM SPACE", 0x2028: "LINE SEPARATOR",
  0x2029: "PARAGRAPH SEPARATOR", 0x202d: "LRO", 0x202e: "RLO", 0x2066: "LRI",
  0x2067: "RLI", 0x2068: "FSI", 0x2069: "PDI", 0x3000: "IDEOGRAPHIC SPACE",
  0xfeff: "BOM",
};

function codePointName(codePoint) {
  const hex = `U+${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
  const known = KNOWN_CODE_POINT_NAMES[codePoint];
  return known ? `${known} (${hex})` : hex;
}

function stripStrings(text) {
  return text.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
}

function isWellFormed(text) {
  if (typeof text.isWellFormed === "function") return text.isWellFormed();
  return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(text);
}

function codePointWidth(text) {
  return [...text].length;
}

// The character rule: every C0/C1 control except LF, every formatting
// character (bidi controls, zero-width characters, the BOM), and every
// separator that renders like a space or a newline without being one
// (NBSP, U+2028/U+2029, the non-ASCII spaces). Each hit names the code
// point and its line:column.
export function characterViolations(text) {
  const violations = [];
  let line = 1;
  let column = 0;
  for (const character of text) {
    column += 1;
    const codePoint = character.codePointAt(0);
    if (codePoint === 0x0a) {
      line += 1;
      column = 0;
      continue;
    }
    const control = codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
    const formatting = /\p{Cf}/u.test(character);
    const confusableSpace = codePoint !== 0x20 && /[\p{Zs}\p{Zl}\p{Zp}]/u.test(character);
    if (!control && !formatting && !confusableSpace) continue;
    let hint = "";
    if (codePoint === 0x09) hint = " (use spaces; a shell heredoc needs <<EOF, not <<-EOF)";
    else if (codePoint === 0x0d) hint = " (use LF line endings)";
    else if (confusableSpace) hint = " (looks like a space or a newline but is not one — use ASCII)";
    violations.push({
      line,
      column,
      rule: "character",
      message: `${codePointName(codePoint)} cannot be shown faithfully in the overlay${hint}`,
    });
  }
  return violations;
}

// Which lines are heredoc payload (body or terminator). Style rules never
// apply inside a heredoc; the width, trailing-space and character rules
// still do, and a blank line inside one never opens a new section.
function heredocLineFlags(lines, rails) {
  const flags = new Array(lines.length).fill(false);
  const opener = rails ? RUBY_HEREDOC_OPENER : SHELL_HEREDOC_OPENER;
  const openerGlobal = new RegExp(opener.source, "g");
  const terminators = [];
  lines.forEach((text, index) => {
    if (terminators.length > 0) {
      flags[index] = true;
      if (text.trim() === terminators[0]) terminators.shift();
      return;
    }
    const quoteFree = !/["'`]/.test(text.replace(opener, ""));
    for (const match of text.matchAll(openerGlobal)) {
      // An unquoted opener on a line that holds quotes is more likely text
      // inside a string than a real heredoc.
      if (!quoteFree && match[2] === "") continue;
      terminators.push(match[3]);
    }
  });
  return flags;
}

function nameViolations(name, line, column) {
  if (name.startsWith("_") || SHORT_NAME_ALLOWLIST.has(name)) return [];
  if (name.length < 3) {
    return [{
      line,
      column,
      rule: "name",
      message: `variable \`${name}\` — use the full name of the object it holds (e.g. \`order\`, not \`o\`)`,
    }];
  }
  if (GENERIC_NAMES.has(name)) {
    return [{ line, column, rule: "name", message: `variable \`${name}\` is generic — name the object it holds` }];
  }
  return [];
}

function statementViolation(text, line, rails) {
  const semicolons = rails ? text : text.replace(SHELL_STATEMENT_EXEMPTIONS, "");
  const breaks = (semicolons.match(/;/g) || []).length;
  if (breaks === 0) return null;
  const nilHint = rails && /;\s*nil\s*$/.test(text)
    ? " (to silence a large echo, put `nil` on its own final line)"
    : "";
  return {
    line,
    column: text.indexOf(";") + 1,
    rule: "statements",
    message: `${breaks + 1} statements joined by \`;\` — one statement per line${nilHint}`,
  };
}

function railsSpacingAndNameViolations(text, line, quoteFree) {
  const violations = [];
  if (!/\//.test(text)) {
    const commaMatch = stripStrings(text).match(/,(?=\S)/);
    if (commaMatch) {
      violations.push({ line, column: commaMatch.index + 2, rule: "spacing", message: "missing space after `,`" });
    }
  }
  const assignment = text.match(ASSIGNMENT_PATTERN);
  if (assignment) {
    const [, indent, names, before, , after, next] = assignment;
    if (before === "" || (after === "" && next !== "")) {
      violations.push({ line, column: indent.length + names.length + 1, rule: "spacing", message: "spaces around `=`" });
    }
    for (const name of names.split(/\s*,\s*/)) {
      violations.push(...nameViolations(name, line, indent.length + 1 + names.indexOf(name)));
    }
  }
  // Block parameters are read only off quote-free lines: `|x|` inside a
  // string is text, not a parameter list.
  const blockParams = quoteFree ? text.match(BLOCK_PARAMS_PATTERN) : null;
  if (blockParams) {
    const paramsColumn = blockParams.index + blockParams[0].indexOf("|") + 2;
    for (const param of blockParams[1].split(",")) {
      const name = param.trim().replace(/^[*&]/, "");
      if (name !== "") violations.push(...nameViolations(name, line, paramsColumn));
    }
  }
  return violations;
}

function widthViolation(text, line, rails) {
  const width = codePointWidth(text);
  if (width <= COMMAND_COLUMNS) return null;
  const hint = rails
    ? ' (a long string: "…" \\ newline "…")'
    : " (shell: end the line with a backslash; split a long quoted word as 'abc'\\ newline 'def')";
  return {
    line,
    column: COMMAND_COLUMNS + 1,
    rule: "width",
    message: `${width} columns; the limit is ${COMMAND_COLUMNS}. Break at a comma, a leading-dot call, or after an operator${hint}`,
  };
}

function trailingSpaceViolation(text, line) {
  if (!/[ \t]+$/.test(text)) return null;
  return {
    line,
    column: codePointWidth(text.replace(/[ \t]+$/, "")) + 1,
    rule: "trailing-space",
    message: "trailing whitespace — invisible in the overlay",
  };
}

function sectionsViolation(lines, inHeredoc) {
  let sections = 0;
  let open = false;
  lines.forEach((text, index) => {
    const blank = text.trim() === "" && !inHeredoc[index];
    if (blank) open = false;
    else if (!open) {
      open = true;
      sections += 1;
    }
  });
  const printsSomething = lines.some(
    (text, index) => !inHeredoc[index] && OUTPUT_CALL_PATTERN.test(stripStrings(text)),
  );
  if (sections < 2 || printsSomething) return null;
  return {
    line: 0,
    column: 0,
    rule: "sections",
    message: `${sections} sections but nothing is printed — a multi-statement console paste prints only its final value; end each section with a labeled \`puts\`/\`pp\``,
  };
}

const BLANK_LINE_STRIPPED = "the drivers strip it, so the overlay would show a line that is not sent";

function lineViolations(lines, driver) {
  const rails = driver === "rails_irb";
  const violations = [];
  const inHeredoc = heredocLineFlags(lines, rails);
  const add = (violation) => violation && violations.push(violation);

  if (lines[0].trim() === "") {
    add({ line: 1, column: 1, rule: "blank", message: `leading blank line — ${BLANK_LINE_STRIPPED}` });
  }
  if (lines.length > 1 && lines.at(-1).trim() === "") {
    add({ line: lines.length, column: 1, rule: "blank", message: `trailing blank line — ${BLANK_LINE_STRIPPED}` });
  }

  let scalarRun = 0;
  let underArrayOpener = false;
  lines.forEach((text, index) => {
    const line = index + 1;
    add(widthViolation(text, line, rails));
    add(trailingSpaceViolation(text, line));
    if (inHeredoc[index]) {
      scalarRun = 0;
      return;
    }
    if (index > 0 && text.trim() === "" && lines[index - 1].trim() === "") {
      add({ line, column: 1, rule: "blank", message: "two blank lines in a row — exactly one blank line separates sections" });
    }
    if (rails && SCALAR_ELEMENT_LINE.test(text)) {
      scalarRun += 1;
      if (scalarRun === 1) underArrayOpener = index > 0 && ARRAY_OPENER_LINE.test(lines[index - 1]);
      if (scalarRun === 3 && underArrayOpener) {
        add({
          line: line - 2,
          column: text.search(/\S/) + 1,
          rule: "array-fill",
          message: `one array element per line — put several elements on each line, up to ${COMMAND_COLUMNS} columns`,
        });
      }
    } else {
      scalarRun = 0;
    }
    if (/^\s*#/.test(text)) {
      add({ line, column: text.indexOf("#") + 1, rule: "comment", message: "comment line — the script must read without comments; rename or restructure instead" });
    }
    const quoteFree = !/["'`]/.test(text);
    if (quoteFree) add(statementViolation(text, line, rails));
    if (rails) violations.push(...railsSpacingAndNameViolations(text, line, quoteFree));
  });

  if (rails) add(sectionsViolation(lines, inHeredoc));
  return violations;
}

function byPosition(first, second) {
  return first.line - second.line || first.column - second.column;
}

function sizeViolation(message) {
  return { line: 0, column: 0, rule: "size", message };
}

// Checks `text` against the contract for the named driver. On success the
// returned command is the input minus one trailing LF and nothing else; on
// failure every violation is listed, sorted by position (whole-command
// findings first).
export function checkCommandContract(text, { driver }) {
  const command = text.endsWith("\n") ? text.slice(0, -1) : text;
  const violations = [];
  const byteLength = Buffer.byteLength(command, "utf8");
  if (byteLength > MAX_COMMAND_BYTES) {
    violations.push(sizeViolation(`${byteLength} bytes; the limit is ${MAX_COMMAND_BYTES}`));
    return { ok: false, command, violations };
  }
  const lines = command.split("\n");
  if (lines.length > MAX_COMMAND_LINES) {
    violations.push(
      sizeViolation(
        `${lines.length} lines; the limit is ${MAX_COMMAND_LINES} — split the script into sends (console state persists between sends)`,
      ),
    );
  }
  if (!isWellFormed(command)) {
    violations.push({
      line: 0,
      column: 0,
      rule: "unicode",
      message: "malformed Unicode (an unpaired surrogate) — the bytes cannot be shown or sent faithfully",
    });
    return { ok: false, command, violations };
  }
  violations.push(...characterViolations(command), ...lineViolations(lines, driver));
  violations.sort(byPosition);
  return violations.length === 0 ? { ok: true, command } : { ok: false, command, violations };
}

function formatViolation({ line, column, rule, message }, lines) {
  if (line === 0) return `  - [${rule}] ${message}`;
  const where = column > 0 ? `line ${line}, col ${column}` : `line ${line}`;
  const text = lines[line - 1] ?? "";
  const excerpt = text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH)}…` : text;
  return `  - ${where}: [${rule}] ${message}\n      ${JSON.stringify(excerpt)}`;
}

// The tool result for a rejected command: every violation (capped), each
// with its line excerpt, ending in the instruction that keeps the model from
// retrying unchanged or looping on a rule it cannot satisfy.
export function formatContractViolations(violations, lines) {
  const count = violations.length;
  const listed = violations.slice(0, MAX_LISTED_VIOLATIONS).map((violation) => formatViolation(violation, lines));
  const more = count > MAX_LISTED_VIOLATIONS ? [`  … and ${count - MAX_LISTED_VIOLATIONS} more`] : [];
  return [
    `send_terminal rejected before approval: the command breaks the style contract ` +
      `(${count} problem${count === 1 ? "" : "s"}). The human has NOT seen it.`,
    ...listed,
    ...more,
    "Fix every item and resend the whole command. If an item cannot be satisfied " +
      "for this command, stop and relay this message to the human instead of retrying.",
  ].join("\n");
}
