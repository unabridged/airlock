// Airlock — prompt-pattern derivation: the pure shape logic both drivers
// build their anchored matchers from, exercised against the real-world
// prompt corpus (stock IRB, pry, and the acme staging .irbrc and PS1
// shapes that caused the 2026-08-23 open_terminal hang).

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildIrbPromptPatterns } from "../src/drivers/rails-irb.mjs";
import { buildShellPromptPatterns } from "../src/drivers/shell.mjs";

describe("buildIrbPromptPatterns", () => {
  it("frees the stock counter so every input's new prompt still matches", () => {
    const patterns = buildIrbPromptPatterns("irb(main):001>");
    assert.match("irb(main):002>", patterns.ready);
    assert.match("irb(main):999> ", patterns.ready);
    assert.doesNotMatch("irb(main):002*", patterns.ready);
    assert.doesNotMatch("xirb(main):002>", patterns.ready);
    assert.match("irb(main):003>   .sum", patterns.echo);
    assert.match("irb(main):003* second_line,", patterns.echo);
    assert.match("irb(main):004*", patterns.continuation);
    assert.equal(Number("irb(main):007>".match(patterns.counter)[1]), 7);
  });

  it("handles the acme-staging custom prompt, which has no counter at all", () => {
    const patterns = buildIrbPromptPatterns("acme(staging):main>");
    assert.match("acme(staging):main>", patterns.ready);
    assert.match("acme(staging):main> ", patterns.ready);
    assert.doesNotMatch("acme(staging):main* ", patterns.ready);
    assert.doesNotMatch("=> acme(staging):main>", patterns.ready);
    assert.match("acme(staging):main* 2,", patterns.echo);
    assert.match('acme(staging):main" still a string', patterns.echo);
    assert.match("acme(staging):main*", patterns.continuation);
    assert.equal(patterns.counter, null);
  });

  it("never binds the counter to a static interior digit run (branch names, hosts)", () => {
    // The .irbrc renders the git branch; feature branches carry story digits
    // (feature/proj-123/...). Treating those as the counter would demand they
    // CHANGE per command — a permanent deadlock.
    const patterns = buildIrbPromptPatterns("acme(staging):feature/proj-123/refactor>");
    assert.match("acme(staging):feature/proj-123/refactor>", patterns.ready);
    assert.match("acme(staging):feature/proj-123/refactor> ", patterns.ready);
    assert.equal(patterns.counter, null);
  });

  it("binds the counter only when a digit run sits against the sigil (stock %03n)", () => {
    const rvmStyle = buildIrbPromptPatterns("2.5.1 :001 > ");
    assert.equal(Number("2.5.1 :007 > ".match(rvmStyle.counter)[1]), 7);
    const pry = buildIrbPromptPatterns("[1] pry(main)>");
    assert.match("[2] pry(main)>", pry.ready);
    assert.doesNotMatch("[2] pry(main)* ", pry.ready);
    // Pry's bracketed counter is interior — safer to forgo the counter proof
    // than to risk binding a static digit; the boundary proof carries.
    assert.equal(pry.counter, null);
  });

  it("frees every digit run, so timestamped prompts keep matching", () => {
    const patterns = buildIrbPromptPatterns("[12:30:45] app(prod)>");
    assert.match("[09:15:00] app(prod)>", patterns.ready);
    assert.doesNotMatch("[09:15:00] app(staging)>", patterns.ready);
    assert.equal(patterns.counter, null);
  });

  it("recognizes every IRB %l continuation sigil, not just quotes and star", () => {
    const patterns = buildIrbPromptPatterns("irb(main):001>");
    // %w[...] arrays render `]`, regexps `/`, xstrings a backtick, symbols
    // `:` — all real IRB 1.18 PROMPT_S output that must strip as echo.
    assert.match("irb(main):002]   staging production", patterns.echo);
    assert.match("irb(main):003/", patterns.continuation);
    assert.match("irb(main):004` ls", patterns.echo);
    assert.match("irb(main):005:", patterns.continuation);
  });
});

describe("buildShellPromptPatterns", () => {
  it("frees the cwd in user@host:cwd$ prompts", () => {
    const { ready } = buildShellPromptPatterns("deploy@web1:~$");
    assert.match("deploy@web1:/var/www/acme$", ready);
    assert.doesNotMatch("intruder@web1:~$", ready);
  });

  it("frees the cwd in host:cwd$ prompts", () => {
    const { ready } = buildShellPromptPatterns("web1:~$");
    assert.match("web1:/var/log$", ready);
    assert.doesNotMatch("web2:~$", ready);
  });

  it("frees the cwd in the acme-staging PS1 shape (prefix, role, cwd, sigil)", () => {
    const { ready, echo } = buildShellPromptPatterns("ACME-STAGING (web) ~$");
    assert.match("ACME-STAGING (web) ~$", ready);
    assert.match("ACME-STAGING (web) ~/acme$", ready);
    assert.match("ACME-STAGING (web) /var/log$ ", ready);
    assert.doesNotMatch("ACME-STAGING (db) ~$", ready);
    assert.doesNotMatch("some output mentioning ACME-STAGING (web) paths", ready);
    assert.match("ACME-STAGING (web) ~/acme$ bin/rails console", echo);
  });

  it("does not strip genuine output that starts with the space-separated prefix", () => {
    const { echo } = buildShellPromptPatterns("ACME-STAGING (web) ~$");
    // A prompt row is prefix + space-free cwd + sigil; output lines that
    // merely contain the sigil later are payload, not echo.
    assert.doesNotMatch("ACME-STAGING (web) budget $12 remaining", echo);
    assert.doesNotMatch("ACME-STAGING (web) says: run `make $TARGET` now", echo);
    assert.match("ACME-STAGING (web) /var/log$ tail -f production.log", echo);
  });

  it("falls back to a literal end-anchored match when no shape fits", () => {
    const { ready } = buildShellPromptPatterns("bash-3.2$");
    assert.match("bash-3.2$", ready);
    assert.doesNotMatch("bash-3.2$ extra", ready);
    assert.doesNotMatch("not-bash-3.2$", ready);
  });
});
