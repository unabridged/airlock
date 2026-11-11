// Airlock — the purpose line: what the model says a command is for.
//
// `send_terminal` carries one required line, and the approval overlay shows it
// above the command. It is the model's own claim, not something Airlock
// observes: the directory beside it is a fact (tmux reports where the pane is),
// the purpose is asserted. That difference is why it is validated like the
// command rather than trusted — a claim the human cannot read in one glance is
// worse than no claim, and one that cannot be checked against the command is
// only decoration.
//
// Required, not optional, and deliberately not mechanical. The command rules
// in command-contract.mjs are *constraints*: the tool refuses a line that is
// too wide, and needs no trust to do it. A purpose has no parser -- "what is
// this for" cannot be rejected mechanically -- so it is the other kind of rule:
// a *promise the model makes to the person*, enforced by the person's eye
// rather than by a rejection. That is still a commitment; what it lacks is
// enforcement, and that is what the gate is for.
//
// The order matters and cannot be checked. Deciding what a call is for before
// composing the command is the discipline; a purpose composed afterwards
// describes what was typed rather than what was wanted, and the tool cannot
// tell the two apart -- only the person reading the claim beside the bytes can.
// So the overlay's job is not to verify the promise, it is to put the promise
// where it can be held to. The practical tell, from a session that used it:
// a purpose that needs an "and" is a call doing two things.

import { characterViolations, formatViolations } from "./command-contract.mjs";

// One line, short enough to read beside the command without becoming prose.
// Wider than the command's 80 columns because a sentence wraps where a path
// breaks, and narrower than the launcher label's 120 so it stays a claim and
// not a summary.
export const MAX_PURPOSE_CHARS = 100;

const MISSING_PURPOSE_VIOLATION = {
  line: 0,
  column: 0,
  rule: "missing",
  message:
    "`purpose` is required: one line saying what this command is for, shown to " +
    "the human above the command",
};

// Returns { ok, purpose, violations }. `purpose` is the text the overlay shows:
// the one canonicalization is trimming the ends, because leading or trailing
// whitespace is invisible in the header and would only pad it.
export function checkPurpose(value) {
  if (typeof value !== "string" || value.trim() === "") {
    return { ok: false, purpose: "", violations: [MISSING_PURPOSE_VIOLATION] };
  }
  const purpose = value.trim();
  const violations = [];
  if (purpose.includes("\n")) {
    violations.push({
      line: 0,
      column: 0,
      rule: "one line",
      message: "`purpose` is one line: a sentence above the command, not a paragraph",
    });
  }
  // The same character rule as the command: what the overlay cannot render
  // faithfully (controls, bidi, zero-width, spaces that are not spaces) is
  // rejected rather than shown as a lie.
  violations.push(...characterViolations(purpose));
  const length = [...purpose].length;
  if (length > MAX_PURPOSE_CHARS) {
    violations.push({
      line: 0,
      column: 0,
      rule: "size",
      message: `${length} characters; the limit is ${MAX_PURPOSE_CHARS}`,
    });
  }
  return { ok: violations.length === 0, purpose, violations };
}

// The tool result for an unusable purpose, in the same shape as a rejected
// command: every violation, then the instruction not to retry unchanged.
export function formatPurposeViolations(violations, purpose) {
  return formatViolations(
    violations,
    [purpose],
    (count) =>
      `send_terminal rejected before approval: the purpose line is not usable ` +
      `(${count} problem${count === 1 ? "" : "s"}). The human has NOT seen it.`,
  );
}
