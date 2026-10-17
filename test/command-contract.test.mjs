// Airlock — the command style contract (node --test): the character rule
// against every class SECURITY.md §2 names, the size and width limits, each
// style rule with the false positive it must not raise, and a dense
// one-liner session beside its contract-compliant rewrite.

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  checkCommandContract,
  COMMAND_COLUMNS,
  CONTRACT_EXAMPLE_COMMAND,
  CONTRACT_SPEC_TEXT,
  formatContractViolations,
  MAX_COMMAND_BYTES,
  MAX_COMMAND_LINES,
} from "../src/command-contract.mjs";

function checkRuby(command) {
  return checkCommandContract(command, { driver: "rails_irb" });
}

function checkShell(command) {
  return checkCommandContract(command, { driver: "shell" });
}

function rulesOf(result) {
  return (result.violations ?? []).map((violation) => violation.rule);
}

function assertPasses(result) {
  assert.deepEqual(result.violations ?? [], [], `expected a pass, got ${JSON.stringify(result.violations)}`);
  assert.equal(result.ok, true);
}

function assertRejects(result, rule) {
  assert.equal(result.ok, false);
  assert.ok(rulesOf(result).includes(rule), `expected a ${rule} violation, got ${JSON.stringify(result.violations)}`);
}

// A dense console session of the kind the contract exists to stop: five
// lines, nine problems a reviewer would have to untangle to approve it.
const DENSE_COMMAND = [
  "store = Store.find(1234); orders = store.orders.includes(:shipment, :line_items).to_a; orders.size",
  "orders.map { |o| [o.id, o.shipment&.status, o.line_items.map(&:status).tally, o.shipment&.packages&.map { |pk| [pk.id, pk.items.count] }] }",
  "ids=[10001,10002,10003,10004,10005,10006,10007,10008,10009,10010,10011,10012,10013,10014,10015,10016]",
  "# backordered line items per order",
  'LineItem.where(order_id: ids, picking_status: "backordered").group(:order_id, :warehouse_id).count',
].join("\n");

// The same investigation written to the contract: 33 lines in labeled
// sections, every line within 80 columns.
const EXEMPLAR_COMMAND = [
  "store = Store.find(1234)",
  "orders = store.orders",
  "  .includes(:shipment, :line_items)",
  "  .to_a",
  'puts "orders: #{orders.size}"',
  "",
  "shipment_statuses = orders",
  "  .map { |order| order.shipment&.status }",
  "  .tally",
  'puts "shipment statuses: #{shipment_statuses.inspect}"',
  "",
  "line_item_statuses = orders",
  "  .flat_map { |order| order.line_items.to_a }",
  "  .map(&:status)",
  "  .tally",
  'puts "line item statuses: #{line_item_statuses.inspect}"',
  "",
  "items_per_package = orders",
  "  .filter_map(&:shipment)",
  "  .flat_map(&:packages)",
  "  .to_h { |package| [package.id, package.items.count] }",
  'puts "items per package: #{items_per_package.inspect}"',
  "",
  "backorder_candidate_order_ids = [",
  "  10001, 10002, 10003, 10004, 10005, 10006, 10007, 10008,",
  "  10009, 10010, 10011, 10012, 10013, 10014, 10015, 10016,",
  "]",
  "backordered_line_items_per_order = LineItem",
  '  .where(order_id: backorder_candidate_order_ids, picking_status: "backordered")',
  "  .group(:order_id, :warehouse_id)",
  "  .count",
  'puts "backordered line items per order: " \\',
  '  "#{backordered_line_items_per_order.inspect}"',
].join("\n");

describe("the character rule", () => {
  const rejectedCharacters = [
    ["NUL", "\u0000", "NUL (U+0000)"],
    ["a generic C0 control", "\u0001", "U+0001"],
    ["BS", "\b", "BS (U+0008)"],
    ["TAB", "\t", "TAB (U+0009)"],
    ["CR", "\r", "CR (U+000D)"],
    ["ESC (an ANSI sequence)", "\u001b[31m", "ESC (U+001B)"],
    ["DEL", "\u007f", "DEL (U+007F)"],
    ["a C1 control (NEL)", "\u0085", "U+0085"],
    ["a C1 control (CSI)", "\u009b", "U+009B"],
    ["RLO", "‮", "RLO (U+202E)"],
    ["LRI", "⁦", "LRI (U+2066)"],
    ["PDI", "⁩", "PDI (U+2069)"],
    ["LRM", "‎", "LRM (U+200E)"],
    ["a zero-width space", "​", "ZERO WIDTH SPACE (U+200B)"],
    ["a zero-width joiner", "‍", "U+200D"],
    ["the BOM", "﻿", "BOM (U+FEFF)"],
    ["a no-break space", " ", "NO-BREAK SPACE (U+00A0)"],
    ["an em space", " ", "EM SPACE (U+2003)"],
    ["an ideographic space", "　", "IDEOGRAPHIC SPACE (U+3000)"],
    ["U+2028", " ", "LINE SEPARATOR (U+2028)"],
    ["U+2029", " ", "PARAGRAPH SEPARATOR (U+2029)"],
  ];

  for (const [description, character, name] of rejectedCharacters) {
    it(`rejects ${description}, naming the code point and its position`, () => {
      const result = checkRuby(`total = 1\nputs "a${character}b"`);
      assert.equal(result.ok, false);
      const violation = result.violations.find((candidate) => candidate.rule === "character");
      assert.ok(violation, JSON.stringify(result.violations));
      assert.equal(violation.line, 2);
      assert.equal(violation.column, 8);
      assert.match(violation.message, new RegExp(name.replace(/[()+]/g, "\\$&")));
    });
  }

  it("rejects an unpaired surrogate as malformed Unicode", () => {
    for (const surrogate of ["\ud800", "\udc00"]) {
      const result = checkRuby(`puts "a${surrogate}b"`);
      assert.deepEqual(rulesOf(result), ["unicode"]);
    }
  });

  it("explains how to replace a TAB in a shell heredoc", () => {
    const result = checkShell("cat <<-EOF\n\tindented\nEOF");
    assertRejects(result, "character");
    assert.match(result.violations.find((violation) => violation.rule === "character").message, /<<EOF, not <<-EOF/);
  });

  it("accepts LF as the only line break", () => {
    assertPasses(checkRuby("total = 1\ncount = 2"));
  });

  it("accepts ordinary Unicode inside strings, emoji included", () => {
    assertPasses(checkRuby('puts "ünïcödé café 日本語 👀 ✔️ — done"'));
  });
});

describe("the one canonicalization", () => {
  it("returns the input itself when it has no trailing LF", () => {
    const input = 'total = 1\nputs "total: #{total}"';
    assert.equal(checkRuby(input).command, input);
  });

  it("drops exactly one trailing LF and nothing else", () => {
    assert.equal(checkRuby("total = 1\n").command, "total = 1");
    const twoNewlines = checkRuby("total = 1\n\n");
    assert.equal(twoNewlines.command, "total = 1\n");
    assertRejects(twoNewlines, "blank");
  });

  it("returns the input on rejection too, so the excerpts quote what was sent", () => {
    const input = "a=1";
    assert.equal(checkRuby(input).command, input);
  });
});

describe("the size limits", () => {
  it(`accepts a ${COMMAND_COLUMNS}-column line and rejects ${COMMAND_COLUMNS + 1} at column ${COMMAND_COLUMNS + 1}`, () => {
    assertPasses(checkRuby("a".repeat(COMMAND_COLUMNS)));
    const result = checkRuby("a".repeat(COMMAND_COLUMNS + 1));
    assert.deepEqual(rulesOf(result), ["width"]);
    assert.equal(result.violations[0].column, COMMAND_COLUMNS + 1);
    assert.match(result.violations[0].message, /81 columns; the limit is 80/);
  });

  it("counts columns in code points, so an emoji is one column", () => {
    assertPasses(checkRuby(`puts "${"👀".repeat(COMMAND_COLUMNS - 7)}"`));
  });

  it(`accepts ${MAX_COMMAND_LINES} lines and rejects ${MAX_COMMAND_LINES + 1}`, () => {
    const lines = (count) => Array.from({ length: count }, (_, index) => `total_${index} = ${index}`).join("\n");
    assertPasses(checkRuby(lines(MAX_COMMAND_LINES)));
    const result = checkRuby(lines(MAX_COMMAND_LINES + 1));
    assertRejects(result, "size");
    assert.match(result.violations[0].message, /61 lines; the limit is 60/);
  });

  it("rejects a command over the byte limit without running the line rules", () => {
    const result = checkRuby("a".repeat(MAX_COMMAND_BYTES + 1));
    assert.deepEqual(rulesOf(result), ["size"]);
  });
});

describe("one statement per line", () => {
  it("rejects statements joined by `;`", () => {
    const result = checkRuby("total = 1; count = 2");
    assertRejects(result, "statements");
    assert.match(result.violations[0].message, /2 statements/);
  });

  it("suggests a bare final `nil` when the `;` only silences an echo", () => {
    const result = checkRuby("records = Order.all.to_a; nil");
    assert.match(result.violations.find((violation) => violation.rule === "statements").message, /`nil` on its own/);
  });

  it("accepts a `;` inside a string", () => {
    assertPasses(checkRuby('puts "first; second"'));
    assertPasses(checkShell("echo 'first; second'"));
  });

  it("accepts the shell's own uses of `;`", () => {
    assertPasses(checkShell("for log_file in *.log; do wc -l $log_file; done"));
    assertPasses(checkShell("if test -f Gemfile; then echo yes; fi"));
    assertPasses(checkShell("find . -name Gemfile -exec wc -l {} \\;"));
    assertPasses(checkShell("case $1 in start) echo go;; esac"));
  });

  it("rejects joined shell statements outside control flow", () => {
    assertRejects(checkShell("cd app; ls"), "statements");
  });
});

describe("no comment lines", () => {
  it("rejects a comment line", () => {
    assertRejects(checkRuby("# count the orders\nOrder.count"), "comment");
    assertRejects(checkShell("# list the logs\nls log"), "comment");
  });

  it("accepts `#` inside strings and interpolation", () => {
    assertPasses(checkRuby('puts "orders: #{Order.count}"'));
  });

  it("accepts a Ruby heredoc body holding `;`, `#`, and blank lines", () => {
    assertPasses(
      checkRuby(
        [
          "report = <<~TEXT",
          "  # Weekly report; draft",
          "",
          "  totals; pending",
          "TEXT",
          "puts report",
        ].join("\n"),
      ),
    );
  });

  it("accepts a shell heredoc body holding `;`, `#`, and blank lines", () => {
    assertPasses(
      checkShell(
        [
          "cat <<EOF > notes.txt",
          "# heading; not a comment here",
          "",
          "",
          "first; second",
          "EOF",
          "wc -l notes.txt",
        ].join("\n"),
      ),
    );
  });

  it("still enforces width inside a heredoc", () => {
    assertRejects(checkShell(`cat <<EOF\n${"a".repeat(COMMAND_COLUMNS + 1)}\nEOF`), "width");
  });
});

describe("spacing", () => {
  it("rejects a missing space around `=`", () => {
    assertRejects(checkRuby("total=1"), "spacing");
    assertRejects(checkRuby("total =1"), "spacing");
    assertRejects(checkRuby("total= 1"), "spacing");
  });

  it("accepts comparison and compound operators", () => {
    assertPasses(checkRuby("total = 1\ntotal += 2\ntotal ||= 3\nputs(total == 3)"));
  });

  it("rejects a missing space after a comma", () => {
    assertRejects(checkRuby("totals = [1,2]"), "spacing");
  });

  it("accepts a comma without a space inside a string or a regexp", () => {
    assertPasses(checkRuby('puts "a,b"'));
    assertPasses(checkRuby("names.grep(/a,b/)"));
  });

  it("never applies Ruby spacing to shell arguments", () => {
    assertPasses(checkShell("cut -d: -f1,3 /etc/passwd"));
    assertPasses(checkShell("ls {log,tmp}"));
  });
});

describe("full-word names", () => {
  it("rejects a short or generic variable name", () => {
    assertRejects(checkRuby("o = Order.first"), "name");
    assertRejects(checkRuby("tmp = Order.first"), "name");
  });

  it("rejects a short block parameter", () => {
    const result = checkRuby("Order.all.map { |o| o.id }");
    assertRejects(result, "name");
    assert.match(result.violations[0].message, /variable `o`/);
  });

  it("accepts `id`, an underscore name, and full words", () => {
    assertPasses(checkRuby("id = 1234\n_ = Order.find(id)\norder = Order.find(id)"));
  });

  it("ignores block-parameter syntax inside a string", () => {
    assertPasses(checkRuby('puts "usage: each do |x|"'));
  });
});

describe("arrays fill-wrapped", () => {
  it("rejects literals one per line under an opening bracket", () => {
    assertRejects(checkRuby("order_ids = [\n  10001,\n  10002,\n  10003,\n]"), "array-fill");
  });

  it("accepts several literals per line", () => {
    assertPasses(checkRuby("order_ids = [\n  10001, 10002, 10003,\n  10004, 10005,\n]"));
  });

  it("accepts one argument per line in a multi-line call", () => {
    assertPasses(
      checkRuby("report = build_report(\n  first_order,\n  second_order,\n  third_order,\n)"),
    );
  });

  it("accepts an array of expressions one per line", () => {
    assertPasses(checkRuby("totals = [\n  orders.count,\n  payments.sum(:amount),\n  refunds.count,\n]"));
  });
});

describe("blank lines", () => {
  it("rejects a leading or trailing blank line, which the drivers would strip", () => {
    assertRejects(checkRuby("\ntotal = 1"), "blank");
    assertRejects(checkRuby("total = 1\n\n"), "blank");
  });

  it("rejects two blank lines in a row", () => {
    assertRejects(checkRuby('total = 1\nputs "total: #{total}"\n\n\ncount = 2\nputs "count: #{count}"'), "blank");
  });

  it("rejects trailing whitespace, which the overlay cannot show", () => {
    assertRejects(checkRuby("total = 1 "), "trailing-space");
  });
});

describe("labeled sections", () => {
  it("rejects several sections that print nothing", () => {
    const result = checkRuby("total = Order.count\n\ncount = Payment.count");
    assertRejects(result, "sections");
    assert.match(result.violations[0].message, /prints only its final value/);
  });

  it("accepts a single section without a printer", () => {
    assertPasses(checkRuby("total = Order.count\ncount = Payment.count"));
  });

  for (const printer of ['$stdout.puts "count: #{count}"', 'warn "count: #{count}"', "pp count"]) {
    it(`counts \`${printer.split(" ")[0]}\` as a printer`, () => {
      assertPasses(checkRuby(`total = Order.count\n\ncount = Payment.count\n${printer}`));
    });
  }

  it("counts a `puts` inside a block as a printer", () => {
    assertPasses(checkRuby('total = Order.count\n\nPayment.all.each { |payment| puts "id: #{payment.id}" }'));
  });

  it("does not count a printer method on another receiver", () => {
    assertRejects(checkRuby('total = Order.count\n\nRails.logger.info("count")'), "sections");
  });
});

describe("the dense command and its rewrite", () => {
  it("rejects the dense command with all nine problems, in position order", () => {
    const result = checkRuby(DENSE_COMMAND);
    assert.equal(result.ok, false);
    assert.deepEqual(
      result.violations.map(({ line, column, rule }) => [line, column, rule]),
      [
        [1, 25, "statements"],
        [1, 81, "width"],
        [2, 15, "name"],
        [2, 81, "width"],
        [3, 4, "spacing"],
        [3, 12, "spacing"],
        [3, 81, "width"],
        [4, 1, "comment"],
        [5, 81, "width"],
      ],
    );
  });

  it("accepts the 33-line rewrite", () => {
    assert.equal(EXEMPLAR_COMMAND.split("\n").length, 33);
    assertPasses(checkRuby(EXEMPLAR_COMMAND));
  });

  it("accepts the example the spec text itself shows the model", () => {
    assert.match(CONTRACT_SPEC_TEXT, /Example \(12 lines\):/);
    assert.equal(CONTRACT_EXAMPLE_COMMAND.split("\n").length, 12);
    assertPasses(checkRuby(CONTRACT_EXAMPLE_COMMAND));
  });
});

describe("formatContractViolations", () => {
  it("lists every problem with its position, rule, and line excerpt", () => {
    const result = checkRuby(DENSE_COMMAND);
    const message = formatContractViolations(result.violations, result.command.split("\n"));
    assert.match(message, /^send_terminal rejected before approval: the command breaks the style contract \(9 problems\)\. The human has NOT seen it\./);
    assert.match(message, /  - line 4, col 1: \[comment\] comment line/);
    assert.match(message, /      "# backordered line items per order"/);
    assert.match(message, /      "store = Store\.find\(1234\); orders = store\.orders\.includes\(:sh…"/);
    assert.match(message, /relay this message to the human instead of retrying\.$/);
  });

  it("caps the list and says how many more there are", () => {
    const command = Array.from({ length: 25 }, (_, index) => `total_${index}=${index}`).join("\n");
    const result = checkRuby(command);
    const message = formatContractViolations(result.violations, result.command.split("\n"));
    assert.match(message, /\(25 problems\)/);
    assert.equal(message.split("\n").filter((line) => line.startsWith("  - ")).length, 20);
    assert.match(message, /  … and 5 more/);
  });

  it("states whole-command problems without a position", () => {
    const result = checkRuby("total = Order.count\n\ncount = Payment.count");
    const message = formatContractViolations(result.violations, result.command.split("\n"));
    assert.match(message, /\(1 problem\)/);
    assert.match(message, /\n  - \[sections\] /);
  });
});
