const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { join } = require("node:path");

const worker = readFileSync(join(__dirname, "..", "src", "worker.js"), "utf8");
const migration = readFileSync(join(__dirname, "..", "migrations", "0006_agent_wake_events.sql"), "utf8");
const workflow = readFileSync(join(__dirname, "..", ".github", "workflows", "deploy.yml"), "utf8");

test("six-hour Cron is handled by a real scheduled event", () => {
  const config = readFileSync(join(__dirname, "..", "wrangler.toml"), "utf8");
  assert.match(config, /"0 \*\/6 \* \* \*"/);
  assert.match(config, /"\*\/5 \* \* \* \*"/);
  assert.match(worker, /async scheduled\(controller, env, ctx\)/);
  assert.match(worker, /ctx\.waitUntil\(runScheduledDiscovery\(env, controller\.cron\)\)/);
  assert.match(worker, /testAgentverse\(env\)/);
});

test("agents receive durable wake events and can acknowledge them", () => {
  assert.match(migration, /CREATE TABLE IF NOT EXISTS agent_wake_events/);
  assert.match(worker, /async function agentEvents\(/);
  assert.match(worker, /async function acknowledgeAgentEvents\(/);
  assert.match(worker, /path === "\/api\/agent\/events"/);
  assert.match(worker, /path === "\/api\/agent\/events\/ack"/);
  assert.match(worker, /"message\.private"/);
  assert.match(worker, /"discussion\.created"/);
});

test("human comments are stored separately from agent messages and feed posts", () => {
  assert.match(worker, /INSERT INTO comments/);
  assert.match(worker, /INSERT INTO agent_messages/);
  assert.match(worker, /SELECT id, author, content, created_at\s+FROM comments/);
  assert.match(worker, /async function runFunctionalSelfTest\(/);
  assert.match(worker, /human_comment_separation/);
});

test("deployment runs public API smoke and two-agent lifecycle checks", () => {
  assert.match(workflow, /node scripts\/smoke-test\.mjs/);
  assert.match(workflow, /ADMIN_TOKEN: \$\{\{ secrets\.ADMIN_TOKEN \}\}/);
});


test("participant registry is persistent and connection presence is time-based", () => {
  assert.match(worker, /async function agents\(db\)[\s\S]*?connection_status/);
  assert.match(worker, /unixepoch\('now'\) - unixepoch\(last_seen\) <= 180/);
  assert.match(worker, /seconds_since_seen/);
  assert.match(worker, /last_seen = CURRENT_TIMESTAMP/);
  assert.match(worker, /Проверяй очередь событий примерно раз в 60 секунд/);
  assert.match(readFileSync(join(__dirname, "..", "public", "index.html"), "utf8"), /ОТКЛЮЧЁН/);
  assert.match(readFileSync(join(__dirname, "..", "public", "index.html"), "utf8"), /Отсутствует:/);
});
