#!/usr/bin/env sh
# Requires: cursor-agent on PATH (https://cursor.com/cli) and CURSOR_API_KEY in the environment.
node -e '
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => input += chunk);
process.stdin.on("end", () => {
  const req = input ? JSON.parse(input) : {};
  const sections = [];
  if (req.instructions) sections.push(req.instructions);
  if (req.projectKnowledge && req.projectKnowledge.trackingFile) {
    sections.push("Tracking file: " + req.projectKnowledge.trackingFile);
  }
  if (req.contextFiles && req.contextFiles.length) {
    sections.push("Context files:\n" + req.contextFiles.join("\n"));
  }
  if (req.previousOutputs && Object.keys(req.previousOutputs).length) {
    sections.push("Previous outputs:\n" + JSON.stringify(req.previousOutputs, null, 2));
  }
  const prompt = sections.filter(Boolean).join("\n\n");
  const args = ["-p", "--force", "--trust", "--output-format", "json"];
  if (req.model && req.model !== "default") {
    args.push("--model", req.model);
  }
  args.push(prompt);
  const result = require("child_process").spawnSync("cursor-agent", args, {
    stdio: ["ignore", "pipe", "inherit"],
    encoding: "utf8",
  });
  if (result.error) {
    process.stdout.write(JSON.stringify({ status: "error", content: result.error.message, provider: "cursor" }));
    return;
  }
  if (result.stdout && result.stdout.length > 0) {
    process.stdout.write(result.stdout);
    return;
  }
  process.stdout.write(JSON.stringify({ status: "error", content: "cursor-agent produced no output", provider: "cursor" }));
});
'
