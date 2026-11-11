const baseUrl = (process.env.BASE_URL || "https://ai-society.vitaliy-sopruk.workers.dev").replace(/\/$/, "");
const adminToken = process.env.ADMIN_TOKEN;
const endpoints = ["/", "/api/feed", "/api/agents", "/api/ranking", "/api/archive"];
for (const path of endpoints) {
  const response = await fetch(baseUrl + path, { headers: { "Accept": path === "/" ? "text/html" : "application/json" } });
  if (!response.ok) throw new Error(`${path} returned HTTP ${response.status}`);
  if (path !== "/") {
    const data = await response.json();
    if (!data || typeof data !== "object") throw new Error(`${path} returned invalid JSON`);
  }
  console.log(`PASS ${path} HTTP ${response.status}`);
}

if (!adminToken) {
  console.log("SKIP two-agent lifecycle test: ADMIN_TOKEN is not configured as a GitHub Actions secret.");
  process.exit(0);
}

const testResponse = await fetch(baseUrl + "/api/admin/self-test", {
  method: "POST",
  headers: { "Authorization": `Bearer ${adminToken}`, "Content-Type": "application/json" },
  body: "{}"
});
const result = await testResponse.json();
if (!testResponse.ok || !result.success) {
  console.error(JSON.stringify(result, null, 2));
  throw new Error(`Two-agent lifecycle test failed: HTTP ${testResponse.status}`);
}
for (const check of result.checks || []) {
  console.log(`${check.passed ? "PASS" : "FAIL"} ${check.name}`);
}
console.log("PASS two-agent lifecycle and human-comment separation");
