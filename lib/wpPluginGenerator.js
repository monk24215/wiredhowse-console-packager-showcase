// Generates a WordPress plugin as a set of files from a plain-language request.
// The model returns JSON only: { "name": "...", "files": { "path": "content" } }.
// Output is validated by pluginValidate.js before anything is packaged.

const ANTHROPIC_API = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 32000;

const SYSTEM_PROMPT = `You write WordPress plugins.

Return ONLY a JSON object, no prose, no markdown fences:
{"name": "<Human readable plugin name>", "files": {"<relative/path.php>": "<full file contents>"}}

Rules:
- Root file is <slug>.php and starts with <?php, then a standard plugin header comment
  containing "Plugin Name:", "Description:", "Version:", "Requires at least:", "Requires PHP:",
  "License:" and "Text Domain:".
- Guard direct access: if ( ! defined( 'ABSPATH' ) ) { exit; }
- Use WordPress APIs and standards: prefix all functions, classes, options and hooks with a unique
  prefix derived from the plugin slug; use add_action/add_filter; use the Settings API for options;
  enqueue scripts and styles with wp_enqueue_*; never print unescaped output (esc_html, esc_attr,
  esc_url, wp_kses_post); sanitize all input (sanitize_text_field, absint, etc.); use nonces and
  current_user_can() for any form or admin action.
- Include uninstall.php (or register_uninstall_hook) that removes the plugin's options.
- Do NOT use eval, base64_decode, gzinflate, str_rot13, shell_exec, exec, system, passthru,
  proc_open, popen, assert, or remote includes.
- Keep it to the minimum set of files that fully delivers the request. Use relative paths only
  (no leading slash, no "..").
- Implement the requested behaviour completely; do not leave TODO placeholders.`;

function parsePluginJson(raw) {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (fenced ? fenced[1] : raw).trim();
  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw new Error("Generated output is not valid JSON");
  }
  if (!data || typeof data.files !== "object") {
    throw new Error("Generated JSON has no 'files' object");
  }
  return { name: String(data.name || "My Plugin"), files: data.files };
}

// Throws on API failure, truncation, or malformed JSON. Caller validates the file set.
export async function generatePluginFiles(apiKey, model, prompt) {
  if (!apiKey) throw new Error("No Anthropic API key available for plugin generation");

  const res = await fetch(ANTHROPIC_API, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: `Create a WordPress plugin for this request:\n"${prompt}"` }],
    }),
  });
  const text = await res.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Anthropic API non-JSON response (HTTP ${res.status}): ${text.slice(0, 300)}`);
  }
  if (!res.ok) {
    throw new Error(`Anthropic API HTTP ${res.status}: ${text.slice(0, 300)}`);
  }
  const block = Array.isArray(data.content) ? data.content.find((c) => c.type === "text") : null;
  if (!block?.text) {
    throw new Error("Anthropic API returned no text content");
  }
  if (data.stop_reason === "max_tokens") {
    throw new Error(`Plugin generation truncated at max_tokens (${MAX_TOKENS})`);
  }
  return parsePluginJson(block.text);
}
