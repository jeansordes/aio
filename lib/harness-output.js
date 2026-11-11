/**
 * @param {object} ev
 * @returns {string | null} text to stream, or null if this assistant event should be ignored
 */
function assistantVisibleText(ev) {
  if (ev.type !== "assistant") {
    return null;
  }
  const parts = ev.message?.content;
  if (!Array.isArray(parts)) {
    return null;
  }
  const texts = parts.filter((p) => p && p.type === "text" && p.text).map((p) => p.text);
  const t = texts.join("");
  if (!t) {
    return null;
  }
  if (ev.timestamp_ms != null && ev.model_call_id != null) {
    return null;
  }
  return t;
}

/**
 * @param {object} ev
 * @returns {string | null}
 */
function toolCallSummaryLine(ev) {
  if (ev.type !== "tool_call") {
    return null;
  }
  const subtype = ev.subtype ?? "?";
  const tc = ev.tool_call;
  let name = "tool";
  if (tc && typeof tc === "object") {
    if (tc.readToolCall) name = `read_file`;
    else if (tc.writeToolCall) name = `write_file`;
    else if (tc.function?.name) name = String(tc.function.name);
    else {
      const keys = Object.keys(tc);
      if (keys.length) name = keys[0];
    }
  }
  return `${subtype} ${name}`;
}

/**
 * @param {string} line
 * @returns {object | null} parsed event, or null if not JSON object
 */
function tryParseStreamJsonLine(line) {
  try {
    const ev = JSON.parse(line);
    if (ev && typeof ev === "object" && !Array.isArray(ev)) {
      return ev;
    }
  } catch {
    /* fall through */
  }
  return null;
}


module.exports = { assistantVisibleText, toolCallSummaryLine, tryParseStreamJsonLine };
