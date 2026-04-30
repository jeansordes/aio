const https = require("node:https");
const { URL } = require("node:url");
const { loadProjectEnv } = require("./env-file");

const DEFAULT_INTERVAL_MS = 1100;
const MAX_CONTENT = 1800;

/**
 * @param {import('node:events').EventEmitter} bus
 * @param {{ projectRoot: string, env?: NodeJS.ProcessEnv, intervalMs?: number }} options
 * @returns {() => void}
 */
function attachDiscordSink(bus, options) {
  const projectRoot = options.projectRoot;
  const env = { ...process.env, ...loadProjectEnv(projectRoot), ...(options.env ?? {}) };
  const webhookUrl = env.DISCORD_WEBHOOK_URL?.trim();
  const mentionUserId = env.DISCORD_MENTION_USER_ID?.trim();

  if (!webhookUrl) {
    return () => {};
  }

  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  /** @type {{ content: string }[]} */
  const queue = [];
  let timer = null;

  function schedule() {
    if (timer != null) return;
    timer = setTimeout(flush, intervalMs);
  }

  function flush() {
    timer = null;
    const item = queue.shift();
    if (!item) return;
    postDiscordWebhook(webhookUrl, item.content).catch(() => {});
    if (queue.length) schedule();
  }

  function enqueue(content) {
    const text = truncateDiscord(content);
    queue.push({ content: text });
    schedule();
  }

  function mentionPrefix() {
    return mentionUserId ? `<@${mentionUserId}> ` : "";
  }

  const bindings = [
    [
      "runStart",
      (p) => {
        enqueue(`${mentionPrefix()}**aio** run start · workflow \`${p.workflow}\` · \`${p.runId}\``);
      },
    ],
    [
      "stepMilestone",
      (p) => {
        const files =
          p.changed_files?.length > 0 ? ` · files: ${p.changed_files.slice(0, 8).join(", ")}` : "";
        enqueue(
          `${mentionPrefix()}**step** \`${p.stateName}\`/${p.roleName} · ${p.status} · exit ${p.exit_code ?? "?"} · ${p.durationMs}ms${files}`,
        );
      },
    ],
    [
      "runEnd",
      (p) => {
        enqueue(`${mentionPrefix()}**aio** run finished · final state \`${p.finalState}\``);
      },
    ],
    [
      "runError",
      (p) => {
        enqueue(`${mentionPrefix()}**aio** run error: ${p.message}`);
      },
    ],
  ];

  for (const [ev, fn] of bindings) {
    bus.on(ev, fn);
  }

  return () => {
    for (const [ev, fn] of bindings) {
      bus.off(ev, fn);
    }
    if (timer != null) {
      clearTimeout(timer);
      timer = null;
    }
    queue.length = 0;
  };
}

function truncateDiscord(text) {
  const s = String(text ?? "").trim();
  if (s.length <= MAX_CONTENT) return s;
  return `${s.slice(0, MAX_CONTENT)}…`;
}

/**
 * @param {string} webhookUrl
 * @param {string} content
 * @returns {Promise<void>}
 */
function postDiscordWebhook(webhookUrl, content) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(webhookUrl);
    } catch (err) {
      reject(err);
      return;
    }
    if (url.protocol !== "https:") {
      reject(new Error("Discord webhook URL must be https"));
      return;
    }
    const body = JSON.stringify({ content });
    const req = https.request(
      {
        method: "POST",
        hostname: url.hostname,
        path: `${url.pathname}${url.search}`,
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`Discord webhook HTTP ${res.statusCode}`));
          return;
        }
        resolve();
      },
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

module.exports = {
  attachDiscordSink,
  postDiscordWebhook,
};
