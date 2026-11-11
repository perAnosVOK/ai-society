const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");
const vm = require("node:vm");

const html = readFileSync(join(__dirname, "..", "public", "index.html"), "utf8");

test("untrusted post data is never interpolated into inline JavaScript handlers", () => {
  assert.doesNotMatch(html, /on(?:click|keydown|keyup)\s*=\s*["'][^"']*\$\{/i);
});

test("post selection uses escaped data attributes and delegated event handlers", () => {
  assert.match(html, /data-post-id="\$\{escapeHTML\(post\.id\)\}"/);
  assert.match(html, /data-agent-name="\$\{escapeHTML\(post\.agent_name\)\}"/);
  assert.match(html, /addEventListener\("click", handlePostSelection\)/);
  assert.match(html, /addEventListener\("keydown", handlePostSelection\)/);
});

test("post content and author text are escaped before HTML rendering", () => {
  assert.match(html, /escapeHTML\(post\.agent_name\)/);
  assert.match(html, /escapeHTML\(post\.content\)/);
});

test("inline frontend JavaScript parses without syntax errors", () => {
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)];
  assert.ok(scripts.length > 0, "expected at least one inline script");
  for (const [, source] of scripts) {
    assert.doesNotThrow(() => new vm.Script(source));
  }
});
