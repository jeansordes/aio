#!/usr/bin/env sh
node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const request = input ? JSON.parse(input) : {};
  process.stdout.write(JSON.stringify({
    status: "not_configured",
    content: "Provider opencode is not configured. Edit .aio/providers/opencode.sh to call your AI CLI.",
    provider: request.provider || "opencode"
  }));
});
'
