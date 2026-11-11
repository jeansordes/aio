const os = require("node:os");

const EVENTS = ["started", "resumed", "paused", "completed"];
const TYPES = ["webhook", "ntfy", "discord", "pushover"];
const mapping = (v) => v && typeof v === "object" && !Array.isArray(v);
const text = (v) => typeof v === "string" && v.trim().length > 0;

function validateNotifications(config) {
  if (config === undefined) return;
  const requireValue = (ok, message) => { if (!ok) throw new Error("Notifications: " + message); };
  const fields = (obj, allowed) => {
    requireValue(mapping(obj), "expected a mapping.");
    requireValue(Object.keys(obj).every((key) => allowed.includes(key)), "unknown configuration field.");
  };
  fields(config, ["events", "timeoutMs", "targets"]);
  if (config.events !== undefined) requireValue(Array.isArray(config.events) &&
    config.events.every((event) => EVENTS.includes(event)), "invalid events.");
  if (config.timeoutMs !== undefined) requireValue(Number.isInteger(config.timeoutMs) &&
    config.timeoutMs >= 100 && config.timeoutMs <= 10000, "timeoutMs must be between 100 and 10000.");
  requireValue(Array.isArray(config.targets) && config.targets.length <= 10, "targets must be an array of at most ten destinations.");
  const names = new Set();
  for (const target of config.targets) {
    fields(target, ["name", "type", "url", "headers", "token", "user"]);
    requireValue(text(target.name) && /^[a-zA-Z0-9_-]{1,64}$/.test(target.name) && !names.has(target.name),
      "destination names must be unique identifiers.");
    names.add(target.name);
    requireValue(TYPES.includes(target.type), "invalid destination type.");
    requireValue(target.url === undefined ? target.type === "pushover" : text(target.url), "destination needs a URL.");
    if (target.headers !== undefined) requireValue(mapping(target.headers) &&
      Object.values(target.headers).every((value) => typeof value === "string"), "invalid headers.");
    if (target.type === "pushover") requireValue(text(target.token) && text(target.user), "Pushover needs token and user.");
    else requireValue(target.token === undefined && target.user === undefined, "token and user are Pushover fields.");
  }
}

function resolveTarget(target, env) {
  const expand = (value) => value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, key) => {
    if (!env[key]) throw new Error("Missing notification environment variable.");
    return env[key];
  });
  const resolved = {
    ...target,
    url: expand(target.url ?? "https://api.pushover.net/1/messages.json"),
    headers: Object.fromEntries(Object.entries(target.headers ?? {}).map(([key, value]) => [key, expand(value)])),
    ...(target.token ? { token: expand(target.token), user: expand(target.user) } : {}),
  };
  const url = new URL(resolved.url);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid notification URL.");
  if (resolved.type === "discord") url.searchParams.set("wait", "true");
  resolved.url = url.href;
  return resolved;
}

function notificationPayload(event, state, projectRoot) {
  const latest = state.history.at(-1)?.report;
  return {
    event, timestamp: new Date().toISOString(), machine: os.hostname(), project: projectRoot,
    workflow: state.workflow.name, node: state.current,
    title: `aio: ${event}`,
    message: [
      `${state.workflow.name} — ${event}`,
      `Project: ${projectRoot}`,
      `Machine: ${os.hostname()} | Node: ${state.current}`,
      state.reason || latest?.summary || "",
    ].join("\n").slice(0, 1000),
  };
}

function requestBody(target, payload) {
  const headers = { ...target.headers };
  const setType = (value) => {
    // A caller's authorization headers are preserved; adapter encoding is fixed.
    for (const key of Object.keys(headers)) if (key.toLowerCase() === "content-type") delete headers[key];
    headers["Content-Type"] = value;
  };
  let body;
  if (target.type === "ntfy") {
    setType("text/plain; charset=utf-8");
    headers.Title = payload.title;
    body = payload.message;
  } else if (target.type === "pushover") {
    setType("application/x-www-form-urlencoded");
    body = new URLSearchParams({ token: target.token, user: target.user, title: payload.title, message: payload.message }).toString();
  } else {
    setType("application/json");
    body = JSON.stringify(target.type === "discord"
      ? { content: `${payload.title}\n${payload.message}`, allowed_mentions: { parse: [] } }
      : payload);
  }
  return { method: "POST", headers, body, redirect: "error" };
}

function attachNotifications(bus, { config, state, projectRoot, env = process.env, fetchImpl = fetch }) {
  validateNotifications(config);
  const selected = new Set(config?.events ?? ["paused", "completed"]);
  const timeoutMs = config?.timeoutMs ?? 3000;
  const controllers = new Set();
  let pending = Promise.resolve();
  let queued = 0;
  let closed = false;
  let generation = 0;
  const report = (target, event, status, detail) => {
    bus.emit("notification", { target, event, status, ...(detail ? { detail } : {}) });
    if (status === "failed") bus.emit("notificationWarning", {
      message: `Notification ${target} (${event}) failed: ${detail}.`,
    });
  };
  const targets = [];
  for (const target of config?.targets ?? []) {
    try { targets.push(resolveTarget(target, env)); }
    catch {
      report(target.name, "configuration", "failed", "check URL, credentials and environment variables");
    }
  }
  async function send(target, payload) {
    const controller = new AbortController();
    controllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(target.url, { ...requestBody(target, payload), signal: controller.signal });
      if (!response.ok) {
        await response.body?.cancel();
        report(target.name, payload.event, "failed", `HTTP ${response.status}`);
      } else if (target.type === "pushover") {
        // Pushover has an application-level status, separate from HTTP acceptance.
        let raw = "";
        if (response.body) {
          for await (const chunk of response.body) {
            raw += Buffer.from(chunk).toString("utf8");
            if (raw.length > 16384) throw new Error("Oversized response.");
          }
        }
        if (JSON.parse(raw).status !== 1) throw new Error("Rejected message.");
        report(target.name, payload.event, "accepted");
      } else {
        await response.body?.cancel();
        report(target.name, payload.event, "accepted");
      }
    } catch {
      report(target.name, payload.event, "failed", controller.signal.aborted ? "request timed out or shutdown" : "request rejected or network unavailable");
    } finally {
      clearTimeout(timer);
      controllers.delete(controller);
    }
  }
  const bindings = EVENTS.map((event) => {
    const listener = () => {
      if (closed || !selected.has(event) || !targets.length) return;
      if (queued >= 16) {
        report("queue", event, "failed", "pending notification limit reached");
        return;
      }
      const payload = notificationPayload(event, state, projectRoot);
      const ticket = generation;
      queued++;
      pending = pending.then(async () => {
        if (closed || ticket !== generation) return;
        await Promise.all(targets.map((target) => send(target, payload)));
      }).finally(() => { queued--; });
    };
    bus.on(event, listener);
    return [event, listener];
  });
  return {
    async flush() {
      let timer;
      let timedOut = false;
      await Promise.race([pending, new Promise((resolve) => {
        timer = setTimeout(() => { timedOut = true; resolve(); }, timeoutMs);
      })]);
      clearTimeout(timer);
      if (timedOut) {
        generation++;
        for (const controller of controllers) controller.abort();
        report("queue", "delivery", "failed", "delivery window expired; pending events dropped");
        await pending;
      }
    },
    async close() {
      for (const [event, listener] of bindings) bus.off(event, listener);
      await this.flush();
      closed = true;
    },
  };
}

module.exports = { validateNotifications, attachNotifications };
