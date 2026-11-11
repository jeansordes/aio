const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { attachNotifications, validateNotifications } = require("../lib/notifications");
const { loadHarnesses, saveDefault } = require("../lib/harnesses");

async function server(t, handler) {
  const instance = http.createServer(handler);
  await new Promise((resolve) => instance.listen(0, "127.0.0.1", resolve));
  t.after(() => { instance.closeAllConnections(); return new Promise((resolve) => instance.close(resolve)); });
  return `http://127.0.0.1:${instance.address().port}`;
}
const state = () => ({ workflow: { name: "Build" }, current: "goal", history: [],
  reason: "Need your input", guidance: ["private prompt"] });

test("global webhook adapters deliver selected events without transcripts or configuration secrets", async (t) => {
  const received = [];
  const url = await server(t, async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    received.push({ path: req.url, headers: req.headers, body });
    res.setHeader("Content-Type", "application/json");
    res.end('{"status":1}');
  });
  const config = { targets: [
    { name: "generic", type: "webhook", url: url + "/json", headers: { Authorization: "Bearer ${AUTH}" } },
    { name: "phone", type: "ntfy", url: url + "/topic" },
    { name: "chat", type: "discord", url: url + "/discord" },
    { name: "push", type: "pushover", url: url + "/pushover", token: "${TOKEN}", user: "${USER_KEY}" },
  ] };
  const bus = new EventEmitter();
  const events = [];
  bus.on("notification", (e) => events.push(e));
  const snapshot = state();
  const notifications = attachNotifications(bus, { config, state: snapshot, projectRoot: "/project",
    env: { AUTH: "secret-auth", TOKEN: "secret-token", USER_KEY: "secret-user" } });
  bus.emit("started");
  bus.emit("paused");
  snapshot.reason = "Changed after the event";
  await notifications.flush();
  assert.equal(received.length, 4);
  const generic = received.find((r) => r.path === "/json");
  assert.equal(generic.headers.authorization, "Bearer secret-auth");
  assert.equal(JSON.parse(generic.body).event, "paused");
  assert.match(JSON.parse(generic.body).message, /Need your input/);
  assert.doesNotMatch(generic.body, /private prompt|secret-token|Changed after/);
  assert.equal(received.find((r) => r.path === "/topic").headers.title, "aio: paused");
  const discord = received.find((r) => r.path === "/discord?wait=true");
  assert.deepEqual(JSON.parse(discord.body).allowed_mentions, { parse: [] });
  const pushover = new URLSearchParams(received.find((r) => r.path === "/pushover").body);
  assert.equal(pushover.get("token"), "secret-token");
  assert.equal(pushover.get("user"), "secret-user");
  assert.equal(events.filter((e) => e.status === "accepted").length, 4);
  assert.doesNotMatch(JSON.stringify(events), /secret-|http/);
  await notifications.close();
  bus.emit("completed");
  assert.equal(received.length, 4);
});

test("HTTP failures, redirects and stalled services are bounded and never leak credentials", async (t) => {
  let redirected = false;
  const url = await server(t, (req, res) => {
    if (req.url === "/stall") return;
    if (req.url === "/redirect") { res.writeHead(302, { Location: "/secret-location" }); res.end(); return; }
    if (req.url === "/secret-location") redirected = true;
    res.writeHead(429); res.end("secret-service-response");
  });
  const bus = new EventEmitter();
  const warnings = [];
  bus.on("notificationWarning", (e) => warnings.push(e.message));
  const notifications = attachNotifications(bus, { config: {
    timeoutMs: 150, targets: ["reject", "redirect", "stall"].map((name) => ({ name, type: "webhook", url: url + "/" + name })),
  }, state: state(), projectRoot: "/project" });
  bus.emit("completed");
  await notifications.close();
  assert.ok(warnings.length >= 3);
  for (const name of ["reject", "redirect", "stall"]) assert.ok(warnings.some((item) => item.includes(name)));
  assert.equal(redirected, false);
  assert.doesNotMatch(warnings.join("\n"), /secret-|http:\/\//);
  assert.equal(bus.listenerCount("completed"), 0);
});

test("Pushover requires application-level acceptance and missing environment secrets skip only that target", async (t) => {
  const url = await server(t, (req, res) => res.end('{"status":0,"errors":["private response"]}'));
  const bus = new EventEmitter();
  const events = [];
  bus.on("notification", (e) => events.push(e));
  const notifications = attachNotifications(bus, { config: { targets: [
    { name: "push", type: "pushover", url, token: "token", user: "user" },
    { name: "missing", type: "ntfy", url: "${MISSING_URL}" },
  ] }, state: state(), projectRoot: "/project", env: {} });
  bus.emit("completed");
  await notifications.close();
  assert.equal(events.filter((e) => e.status === "failed").length, 2);
  assert.doesNotMatch(JSON.stringify(events), /private response|token|MISSING_URL/);
});

test("notification configuration persists with the global harness choice and rejects invalid fields", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aio-notify-"));
  t.after(() => fs.rmSync(dir, { force: true, recursive: true }));
  const env = { XDG_CONFIG_HOME: dir };
  const loaded = loadHarnesses(env);
  loaded.config.notifications = { events: ["started", "resumed", "completed"],
    targets: [{ name: "phone", type: "ntfy", url: "https://ntfy.sh/example" }] };
  saveDefault(loaded, "codex");
  assert.deepEqual(loadHarnesses(env).config.notifications, loaded.config.notifications);
  assert.throws(() => validateNotifications({ targets: [], events: ["stdout"] }), /invalid events/);
  assert.throws(() => validateNotifications({ targets: [], timeoutMs: 0 }), /timeoutMs/);
  assert.throws(() => validateNotifications({ targets: [{ name: "push", type: "pushover" }] }), /token and user/);
});
