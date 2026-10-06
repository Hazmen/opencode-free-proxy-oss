import express from "express";
import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";

const app = express();
app.use(express.json({ limit: "10mb" }));

const HERE = path.dirname(fileURLToPath(import.meta.url));

const PORT = process.env.PROXY_PORT || 6446;
const PROXY_VERSION = "17";
const BACKEND = "cli"; // requests are executed by genuine `opencode run`

// Resolve opencode binary: $OPENCODE_BIN → default npm location → PATH.
function resolveBin() {
  if (process.env.OPENCODE_BIN && fs.existsSync(process.env.OPENCODE_BIN)) return process.env.OPENCODE_BIN;
  const npmExe = path.join(os.homedir(), "AppData", "Roaming", "npm", "node_modules", "opencode-ai", "bin", "opencode.exe");
  if (fs.existsSync(npmExe)) return npmExe;
  return "opencode"; // rely on PATH
}
const OPENCODE_BIN = resolveBin();
const CLI_DIR = process.env.CLI_WORKDIR || HERE;
const CLI_TIMEOUT_MS = parseInt(process.env.CLI_TIMEOUT_MS || "240000", 10);

const FALLBACK_MODELS = [
  "big-pickle",
  "space-bunny-free",
  "mimo-v2.6-flash-free",
  "ling-3.0-flash-fin-free",
  "ling-3.1-flash-free",
  "longcat-2.5-preview-free",
  "nemotron-3-ultra-free",
  "nemotron-3.5-lightning-free",
  "fledge-alpha-free",
  "muse-spark-1.3-contributor-free",
];

// ── Auto-fetch free models ─────────────────────────────────────────
// The Zen catalog endpoint answers without auth; we re-read it at startup
// and every MODELS_REFRESH_MS so new free models appear automatically
// (no proxy update needed). Anything failing → keep the baked-in list.
const ZEN_MODELS_URL = process.env.ZEN_MODELS_URL || "https://opencode.ai/zen/v1/models";
const MODELS_REFRESH_MS = parseInt(process.env.MODELS_REFRESH_MS || String(6 * 3600 * 1000), 10);
const MODEL_DENYLIST = new Set(
  (process.env.MODEL_DENYLIST || "jev-1.13-free,mimo-v2.5-free").split(",").map((s) => s.trim()).filter(Boolean)
);
// jev-1.13-free uses a different endpoint (systemone), mimo-v2.5-free is deprecated upstream.
function isFreeModel(id) {
  if (MODEL_DENYLIST.has(id)) return false;
  return id === "big-pickle" || id.endsWith("-free");
}
let MODELS = [...FALLBACK_MODELS];
async function refreshModels() {
  try {
    const res = await fetch(ZEN_MODELS_URL, { headers: { "User-Agent": "opencode-free-proxy" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    const ids = [...new Set((data.data || []).map((m) => m.id).filter(isFreeModel))];
    if (!ids.length) {
      console.log("[MODELS] fetch returned no free models, keeping current list");
      return;
    }
    const added = ids.filter((id) => !MODELS.includes(id));
    const gone = MODELS.filter((id) => !ids.includes(id));
    MODELS = ids;
    console.log(`[MODELS] auto-fetched ${MODELS.length} free models` +
      (added.length ? ` (+${added.join(", ")})` : "") +
      (gone.length ? ` (-${gone.join(", ")})` : ""));
  } catch (e) {
    console.log("[MODELS] auto-fetch failed, keeping baked-in list:", e.message);
  }
}
await refreshModels();
if (MODELS_REFRESH_MS > 0) setInterval(refreshModels, MODELS_REFRESH_MS).unref?.();

// Reasoning variants accepted by `opencode run --variant` per model
// (source: `opencode models opencode --verbose`). Empty/absent = provider
// default, no --variant flag is sent.
const VARIANTS = {
  "space-bunny-free": ["low", "medium", "high", "xhigh", "max"],
  "ling-3.0-flash-fin-free": ["low", "medium", "high"],
  "ling-3.1-flash-free": ["low", "medium", "high"],
  "longcat-2.5-preview-free": ["low", "medium", "high"],
  "fledge-alpha-free": ["low", "high", "max"],
  "muse-spark-1.3-contributor-free": ["minimal", "low", "medium", "high", "xhigh"],
};

// Pick a valid --variant for the model, or null (provider default).
// Accepts OpenAI `reasoning_effort`, `{ reasoning: { effort } }`, or a raw string.
function pickVariant(model, effort) {
  const v = typeof effort === "string" ? effort.trim().toLowerCase() : null;
  if (!v) return null;
  return (VARIANTS[model] || []).includes(v) ? v : null;
}

// ── API Keys ───────────────────────────────────────────────────────
const keysFile = process.env.KEYS_FILE || "./api-keys.json";
let apiKeys = {};
function loadKeys() {
  try { apiKeys = JSON.parse(fs.readFileSync(keysFile, "utf8")); } catch {}
  if (Object.keys(apiKeys).length === 0) {
    apiKeys = {
      admin: "oc-" + crypto.randomBytes(20).toString("hex"),
      "user-default": "oc-" + crypto.randomBytes(20).toString("hex"),
    };
    fs.writeFileSync(keysFile, JSON.stringify(apiKeys, null, 2));
    console.log("[INIT] Generated new API keys →", keysFile);
  }
}
loadKeys();

function auth(req) {
  const hdr = req.headers.authorization || req.headers["x-api-key"] || "";
  const tok = hdr.startsWith("Bearer ") ? hdr.slice(7) : hdr;
  for (const [name, key] of Object.entries(apiKeys)) {
    if (tok === key) return name;
  }
  return null;
}

// ── Helpers ────────────────────────────────────────────────────────
const ID_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
function ocId(prefix) {
  const bytes = crypto.randomBytes(26);
  let s = "";
  for (let i = 0; i < 26; i++) s += ID_ALPHABET[bytes[i] % 62];
  return `${prefix}_${s}`;
}

// Persistent CLI session per proxy user (continuity + less session spam)
const cliSessionsFile = "./cli-sessions.json";
let cliSessions = {};
try { cliSessions = JSON.parse(fs.readFileSync(cliSessionsFile, "utf8")); } catch {}
function saveCliSessions() {
  try { fs.writeFileSync(cliSessionsFile, JSON.stringify(cliSessions, null, 2)); } catch {}
}

// Serialize CLI runs per user (one opencode session at a time)
const locks = {};
function withLock(user, fn) {
  const prev = locks[user] || Promise.resolve();
  const next = prev.then(fn, fn);
  locks[user] = next.catch(() => {});
  return next;
}

function msgText(m) {
  const c = m.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    const t = c.filter((b) => b.type === "text").map((b) => b.text || "").join("\n");
    const urls = c.flatMap((b) => {
      const u = b?.type === "image_url" ? (b.image_url?.url ?? b.url)
        : (b?.type === "image" ? "inline" : null);
      return u ? [String(u)] : [];
    });
    let note = "";
    const local = urls.filter((u) => u.startsWith("data:") || u === "inline").length;
    if (local) note += `\n[${local} image(s) attached as file(s) — see attached files]`;
    for (const u of urls.filter((u) => /^https?:\/\//.test(u)).slice(0, 4)) {
      note += `\n[remote image (not attached, URL only): ${u.slice(0, 300)}]`;
    }
    return (t || JSON.stringify(c)) + note;
  }
  return JSON.stringify(c ?? "");
}

// ── Image attachments ──────────────────────────────────────────────
// OpenAI `image_url` / Anthropic `image` parts carry no weight in a text
// prompt, so base64 payloads are saved to temp files and handed to
// `opencode run --file` (native attachment path). Remote URLs can't be
// fetched safely here and stay a text placeholder (see msgText).
let imgSeq = 0;
function saveBase64Image(b64, mediaType) {
  const clean = String(b64 || "").replace(/\s/g, "");
  if (!clean || clean.length % 4 !== 0) return null;
  if (!/^[A-Za-z0-9+/=]+$/.test(clean.slice(0, 200))) return null;
  const ext = String(mediaType || "image/png").split("/")[1]?.split(/[+;]/)[0]?.replace(/[^a-z0-9]/gi, "") || "png";
  const file = path.join(os.tmpdir(), `oc-img-${Date.now().toString(36)}-${(imgSeq++).toString(36)}.${ext}`);
  try {
    fs.writeFileSync(file, Buffer.from(clean, "base64"));
    return file;
  } catch { return null; }
}

// Scan OpenAI-style messages for image_url parts. data: URLs become temp
// files; remote URLs stay placeholders (counted for logging).
function extractOpenAIImages(messages) {
  const files = [];
  let remote = 0;
  for (const m of messages || []) {
    if (!Array.isArray(m?.content)) continue;
    for (const b of m.content) {
      if (b?.type !== "image_url") continue;
      const url = String(b.image_url?.url ?? b.url ?? "");
      if (url.startsWith("data:")) {
        const mm = /^data:(image\/[\w.+-]+);base64,([\s\S]*)$/.exec(url);
        const f = mm && saveBase64Image(mm[2], mm[1]);
        if (f) files.push(f);
      } else if (/^https?:\/\//.test(url)) remote++;
    }
  }
  return { files, remote };
}

function cleanupTempFiles(files) {
  for (const f of files || []) {
    if (typeof f === "string" && f.startsWith(os.tmpdir() + path.sep) && path.basename(f).startsWith("oc-img-")) {
      fs.promises.unlink(f).catch(() => {});
    }
  }
}

// Flatten OpenAI messages into one prompt (CLI takes a single prompt;
// full transcript is replayed every call so the model keeps context).
// Client tool schemas ARE forwarded as definitions; the model must emit
// fenced ```tool_call blocks which the proxy converts to real tool_calls.
// The CLI's own native tools stay forbidden (text/function-request only).
function buildPrompt(messages, tools, toolChoice) {
  const sys = (messages || []).filter((m) => m.role === "system").map(msgText).join("\n");
  const rest = (messages || []).filter((m) => m.role !== "system").map((m) => {
    if (m.role === "tool") return `tool result [${m.tool_call_id || "?"}]: ${msgText(m)}`;
    if (m.role === "assistant" && m.tool_calls) {
      const calls = (m.tool_calls || []).map((t) => `${t.function?.name}(${t.function?.arguments})`).join("; ");
      return `assistant: ${msgText(m)}\n[tool calls made: ${calls}]`;
    }
    return `${m.role}: ${msgText(m)}`;
  });
  let prompt = (sys ? `[System instructions]\n${sys}\n\n` : "") +
    `[Conversation so far — reply as assistant to the last message.]\n${rest.join("\n")}`;
  if (tools?.length && toolChoice !== "none") {
    const defs = tools.map((t) => ({
      name: t.function?.name,
      description: t.function?.description || "",
      parameters: t.function?.parameters || {},
    }));
    const forced = typeof toolChoice === "object" && toolChoice?.function?.name
      ? `\nYou MUST call the function "${toolChoice.function.name}" now (not in later turns).`
      : toolChoice === "required"
        ? `\nYou MUST call at least one of the functions below now (not in later turns).`
        : "";
    prompt += `\n\n[Available functions — you may EITHER answer with plain text OR request function calls. Do not use any other tools. Functions:\n${JSON.stringify(defs)}\nTo request calls, emit one fenced block per call (nothing else inside the fence matters):\n\`\`\`tool_call\n{"name": "<function name>", "arguments": {<JSON object matching parameters>}}\n\`\`\`\nCRITICAL: argument key names are case-sensitive — copy them EXACTLY as defined above (usually snake_case like file_path, old_string). NEVER use camelCase variants (filePath, oldString, newString are WRONG and will be rejected).\nIf no call is needed, just answer in plain text without any fence.${forced}]`;
  } else {
    prompt += `\n[Text answer only, do not call any tools.]`;
  }
  return prompt;
}

// Extract fenced ```tool_call {"name","arguments"} blocks, validated
// against the client-provided definitions. Returns OAI-style tool_calls.
// Key repair: models running inside opencode CLI often emit its native
// camelCase keys (filePath) instead of the client's snake_case (file_path) —
// remap when the schema confirms the target, then enforce `required`.
function camelToSnake(s) {
  return s.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}
function parseToolCalls(text, tools) {
  const defs = new Map((tools || []).map((t) => [t.function?.name, t]));
  const debug = [];
  const tryObj = (obj, where) => {
    if (!obj || typeof obj.name !== "string" || !defs.has(obj.name)) return;
    const params = defs.get(obj.name).function?.parameters || {};
    const props = params.properties || {};
    const required = params.required || [];
    const rawArgs = obj.arguments ?? obj.parameters ?? obj.input;
    let args = rawArgs && typeof rawArgs === "object" ? { ...rawArgs } : {};
    if (typeof rawArgs === "string") { try { args = JSON.parse(rawArgs); } catch { args = {}; } }
    for (const k of Object.keys(args)) {
      if (!(k in props) && camelToSnake(k) in props) {
        args[camelToSnake(k)] = args[k];
        delete args[k];
      }
    }
    if (!required.every((k) => k in args)) {
      debug.push(`${obj.name}@${where}: missing required`);
      return null;
    }
    return {
      id: "call_" + crypto.randomBytes(12).toString("hex"),
      type: "function",
      function: { name: obj.name, arguments: JSON.stringify(args) },
    };
  };
  const calls = [];
  const re = /```tool_call\s*([\s\S]*?)```/g;
  let m;
  let fences = 0;
  while ((m = re.exec(text)) !== null) {
    fences++;
    let obj;
    try { obj = JSON.parse(m[1].trim()); } catch { debug.push(`fence#${fences}: bad json`); continue; }
    const c = tryObj(obj, `fence#${fences}`);
    if (c) calls.push(c);
  }
  // Fallback: plain ```json fences or bare {"name","arguments"} objects
  // (models that half-follow the format). Only when fences gave nothing.
  if (!calls.length) {
    const reJ = /```(?:json)?\s*(\{[\s\S]*?\})\s*```/g;
    while ((m = reJ.exec(text)) !== null) {
      let obj;
      try { obj = JSON.parse(m[1]); } catch { continue; }
      const c = tryObj(obj, "json-fence");
      if (c) calls.push(c);
    }
    if (!calls.length) {
      const reB = /\{\s*"name"\s*:\s*"([A-Za-z0-9_\-]+)"\s*,\s*"(arguments|parameters|input)"\s*:\s*(\{[\s\S]*?\})\s*\}/g;
      while ((m = reB.exec(text)) !== null) {
        if (!defs.has(m[1])) continue;
        let a = {};
        try { a = JSON.parse(m[3]); } catch { continue; }
        const c = tryObj({ name: m[1], arguments: a }, "bare-json");
        if (c) calls.push(c);
      }
    }
  }
  if (process.env.PROXY_DEBUG) {
    try {
      fs.appendFileSync("./proxy-debug.log",
        `[${new Date().toISOString()}] fences=${fences} calls=${calls.length}` +
        (debug.length ? ` dropped=[${debug.join("; ")}]` : "") +
        ` preview=${JSON.stringify(stripFences(text).slice(0, 200))}\n`);
    } catch {}
  }
  return calls;
}

// Run genuine `opencode run --format json`, prompt via stdin.
// opts: { variant?: string, files?: string[] }
// Returns { text, usage:{input,output}, sessionId }.
function cliRun(model, prompt, sessionId, opts = {}) {
  return new Promise((resolve, reject) => {
    const args = ["run", "--model", `opencode/${model}`, "--format", "json"];
    if (sessionId) args.push("--session", sessionId);
    const variant = pickVariant(model, opts.variant);
    if (variant) args.push("--variant", variant);
    const files = (opts.files || []).filter((f) => typeof f === "string" && fs.existsSync(f));
    for (const f of files.slice(0, 8)) args.push("--file", f);
    let child;
    try {
      child = spawn(OPENCODE_BIN, args, { cwd: CLI_DIR, stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      return reject(new Error("spawn failed: " + e.message));
    }
    let out = "";
    let errText = "";
    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      reject(new Error("CLI timeout"));
    }, CLI_TIMEOUT_MS);
    child.stdout.on("data", (d) => { out += d.toString(); });
    child.stderr.on("data", (d) => { errText += d.toString(); });
    child.on("error", (e) => {
      clearTimeout(timer);
      cleanupTempFiles(files);
      reject(new Error("spawn error: " + e.message));
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      let text = "";
      let usage = { input: 0, output: 0 };
      let ses = sessionId;
      let firstErr = null;
      for (const line of out.split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        let ev;
        try { ev = JSON.parse(t); } catch { continue; }
        if (ev.sessionID && !ses) ses = ev.sessionID;
        if (ev.type === "text" && ev.part?.text) text += ev.part.text;
        else if (ev.type === "step_finish" && ev.part?.tokens) {
          // keep max (a run may contain several steps, incl. tiny title calls)
          usage = {
            input: Math.max(usage.input, ev.part.tokens.input || 0),
            output: Math.max(usage.output, ev.part.tokens.output || 0),
          };
        } else if (ev.type === "error" && !firstErr) {
          firstErr = ev.error?.data?.message || ev.error?.name || "CLI error";
        }
      }
      cleanupTempFiles(files);
      if (text) return resolve({ text, usage, sessionId: ses });
      reject(new Error(firstErr || `CLI exited ${code} with no text${errText ? ": " + errText.slice(0, 200) : ""}`));
    });
    try {
      child.stdin.write(prompt);
      child.stdin.end();
    } catch (e) {
      clearTimeout(timer);
      reject(e);
    }
  });
}

// ── Anthropic Messages → OpenAI conversion ─────────────────────────
function anthropicToOpenAI(body) {
  const messages = [];
  if (body.system) {
    const sys = typeof body.system === "string" ? body.system
      : Array.isArray(body.system) ? body.system.map((b) => b.text || "").join("\n") : "";
    if (sys) messages.push({ role: "system", content: sys });
  }
  for (const msg of body.messages || []) {
    if (typeof msg.content === "string") {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      const text = msg.content
        .filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("\n");
      const toolUses = msg.content.filter((b) => b.type === "tool_use");
      if (toolUses.length && msg.role === "assistant") {
        messages.push({
          role: "assistant",
          content: text || null,
          tool_calls: toolUses.map((t) => ({
            id: t.id,
            type: "function",
            function: { name: t.name, arguments: JSON.stringify(t.input || {}) },
          })),
        });
      } else if (msg.content.some((b) => b.type === "tool_result")) {
        for (const b of msg.content.filter((b) => b.type === "tool_result")) {
          const resultText = typeof b.content === "string" ? b.content
            : Array.isArray(b.content) ? b.content.map((c) => c.text || "").join("\n") : "";
          messages.push({ role: "tool", tool_call_id: b.tool_use_id, content: resultText });
        }
      } else {
        messages.push({ role: msg.role, content: text });
      }
    }
  }
  const tools = (body.tools || []).map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description || "",
      parameters: t.input_schema || {},
    },
  }));

  return { messages, tools: tools.length ? tools : undefined };
}

// OpenAI response → Anthropic Messages format
function openAIToAnthropic(oaiResp, model, inputTokens) {
  const choice = oaiResp.choices?.[0];
  if (!choice) {
    return {
      id: ocId("msg"),
      type: "message",
      role: "assistant",
      content: [{ type: "text", text: "" }],
      model,
      stop_reason: "end_turn",
      usage: { input_tokens: inputTokens || 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    };
  }

  const content = [];
  if (choice.message?.content) {
    content.push({ type: "text", text: choice.message.content });
  }
  if (choice.message?.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch {}
      content.push({
        type: "tool_use",
        id: tc.id || ocId("toolu"),
        name: tc.function.name,
        input,
      });
    }
  }
  if (!content.length) content.push({ type: "text", text: "" });

  let stopReason = "end_turn";
  if (choice.finish_reason === "tool_calls") stopReason = "tool_use";
  else if (choice.finish_reason === "length") stopReason = "max_tokens";

  return {
    id: ocId("msg"),
    type: "message",
    role: "assistant",
    content,
    model,
    stop_reason: stopReason,
    usage: {
      input_tokens: oaiResp.usage?.prompt_tokens || inputTokens || 0,
      output_tokens: oaiResp.usage?.completion_tokens || 0,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
    },
  };
}

function toOAIObject(model, text, usage, calls) {
  return {
    id: "chatcmpl-" + crypto.randomBytes(12).toString("hex"),
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{
      index: 0,
      message: { role: "assistant", content: text, ...(calls?.length ? { tool_calls: calls } : {}) },
      finish_reason: calls?.length ? "tool_calls" : "stop",
    }],
    usage: {
      prompt_tokens: usage.input,
      completion_tokens: usage.output,
      total_tokens: usage.input + usage.output,
    },
  };
}

async function runForUser(user, model, messages, tools, toolChoice, opts = {}) {
  return withLock(user, async () => {
    const out = await cliRun(model, buildPrompt(messages, tools, toolChoice), cliSessions[user], opts);
    if (out.sessionId && out.sessionId !== cliSessions[user]) {
      cliSessions[user] = out.sessionId;
      saveCliSessions();
    }
    return out;
  });
}

// Split CLI text into final content + validated tool calls.
function stripFences(text) {
  return String(text || "").replace(/```tool_call\s*[\s\S]*?```/g, "").trim();
}
function splitToolCalls(text, tools, toolChoice) {
  if (!tools?.length || toolChoice === "none") return { content: text, calls: [] };
  const calls = parseToolCalls(text, tools);
  const content = stripFences(text) || null;
  return { content, calls };
}

// ── Routes: OpenAI format ──────────────────────────────────────────
app.get("/v1/models", (_req, res) => {
  res.json({
    object: "list",
    data: MODELS.map((id) => ({
      id, object: "model", created: 1779000000, owned_by: "opencode-free",
    })),
  });
});

app.post("/v1/chat/completions", async (req, res) => {
  const user = auth(req);
  if (!user) return res.status(401).json({ error: { message: "Invalid API key" } });

  const { model, messages, stream, tools, tool_choice, reasoning_effort, reasoning } = req.body;
  if (!MODELS.includes(model)) {
    return res.status(400).json({ error: { message: `Unknown model: ${model}. Available: ${MODELS.join(", ")}` } });
  }
  const wantEffort = reasoning_effort ?? reasoning?.effort;
  const variant = pickVariant(model, wantEffort);
  if (wantEffort && !variant) {
    return res.status(400).json({ error: { message: `Model ${model} does not support reasoning effort "${wantEffort}". Supported: ${(VARIANTS[model] || []).join(", ") || "none (provider default)"}` } });
  }
  const { files, remote } = extractOpenAIImages(messages);

  console.log("[OAI]", new Date().toISOString(), user, model, stream ? "stream" : "sync",
    "msgs:", (messages || []).length, tools?.length ? `tools:${tools.length}` : "no-tools",
    variant ? `variant:${variant}` : "variant:default",
    files.length ? `images:${files.length}` : "", remote ? `remote-images:${remote}(url-only)` : "");

  try {
    const r = await runForUser(user, model, messages, tools, tool_choice, { variant, files });
    const { content, calls } = splitToolCalls(r.text, tools, tool_choice);
    const oai = toOAIObject(model, content, r.usage, calls);
    if (!stream) return res.json(oai);
    // Fake-stream the completed result (CLI has no live token stream)
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const chunk = (delta, finish) => res.write(`data: ${JSON.stringify({ id: oai.id, object: "chat.completion.chunk", created: oai.created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    if (content) {
      for (const p of content.match(/[\s\S]{1,400}/g) || [content]) chunk({ content: p }, null);
    }
    (calls || []).forEach((tc, i) => chunk({ tool_calls: [{ index: i, id: tc.id, type: "function", function: { name: tc.function.name, arguments: tc.function.arguments } }] }, null));
    chunk({}, calls?.length ? "tool_calls" : "stop");
    res.write("data: [DONE]\n\n");
    res.end();
  } catch (e) {
    console.log("[CLI ERROR]", e.message);
    if (!res.headersSent) {
      res.status(502).json({ error: { message: "Upstream error: " + e.message, type: "upstream_error" } });
    }
  }
});

// ── Routes: Anthropic Messages format ──────────────────────────────
app.post("/v1/messages", async (req, res) => {
  const user = auth(req);
  if (!user) {
    return res.status(401).json({ type: "error", error: { type: "authentication_error", message: "Invalid API key" } });
  }

  const { model, stream, max_tokens, tool_choice: antChoice } = req.body;
  if (!MODELS.includes(model)) {
    return res.status(400).json({
      type: "error",
      error: { type: "invalid_request_error", message: `Unknown model: ${model}. Available: ${MODELS.join(", ")}` },
    });
  }

  const { messages, tools } = anthropicToOpenAI(req.body);
  // Anthropic image blocks are dropped by the conversion above, so persist
  // them first and reference them from the prompt + CLI attachments.
  const antFiles = [];
  for (const msg of req.body.messages || []) {
    if (!Array.isArray(msg?.content)) continue;
    for (const b of msg.content) {
      if (b?.type === "image" && b.source?.type === "base64" && b.source?.data) {
        const f = saveBase64Image(b.source.data, b.source.media_type);
        if (f) antFiles.push(f);
      }
    }
  }
  if (antFiles.length) {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const note = `[${antFiles.length} image(s) attached as file(s) — see attached files]`;
    if (lastUser) lastUser.content = `${lastUser.content || ""}\n${note}`;
    else messages.push({ role: "user", content: note });
  }
  const toolChoice = !antChoice || antChoice.type === "auto" ? undefined
    : antChoice.type === "none" ? "none"
    : antChoice.type === "any" ? "required"
    : antChoice.name ? { type: "function", function: { name: antChoice.name } } : undefined;
  const inputTokens = JSON.stringify(messages).length / 4 | 0;

  console.log("[ANT]", new Date().toISOString(), user, model, stream ? "stream" : "sync",
    "msgs:", messages.length, tools?.length ? `tools:${tools.length}` : "no-tools",
    antFiles.length ? `images:${antFiles.length}` : "");

  try {
    const r = await runForUser(user, model, messages, tools, toolChoice, { files: antFiles });
    const { content, calls } = splitToolCalls(r.text, tools, toolChoice);
    const oai = toOAIObject(model, content, r.usage, calls);
    if (!stream) {
      return res.json(openAIToAnthropic(oai, model, inputTokens));
    }
    // Fake-stream Anthropic SSE from completed result
    const msgId = ocId("msg");
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const sendSSE = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    sendSSE("message_start", {
      type: "message_start",
      message: {
        id: msgId, type: "message", role: "assistant", content: [],
        model, stop_reason: null,
        usage: { input_tokens: inputTokens, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      },
    });
    let idx = 0;
    if (content) {
      sendSSE("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "text", text: "" } });
      for (const p of content.match(/[\s\S]{1,400}/g) || [content]) {
        sendSSE("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "text_delta", text: p } });
      }
      sendSSE("content_block_stop", { type: "content_block_stop", index: idx });
      idx++;
    }
    for (const tc of calls || []) {
      let input = {};
      try { input = JSON.parse(tc.function.arguments); } catch {}
      sendSSE("content_block_start", { type: "content_block_start", index: idx, content_block: { type: "tool_use", id: tc.id, name: tc.function.name } });
      sendSSE("content_block_delta", { type: "content_block_delta", index: idx, delta: { type: "input_json_delta", partial_json: tc.function.arguments } });
      sendSSE("content_block_stop", { type: "content_block_stop", index: idx });
      idx++;
      void input;
    }
    sendSSE("message_delta", {
      type: "message_delta",
      delta: { stop_reason: calls?.length ? "tool_use" : "end_turn" },
      usage: { output_tokens: Math.ceil((content || "").length / 4) },
    });
    sendSSE("message_stop", { type: "message_stop" });
    res.end();
    if (max_tokens) void max_tokens;
  } catch (e) {
    console.log("[CLI ERROR]", e.message);
    if (!res.headersSent) {
      res.status(502).json({ type: "error", error: { type: "upstream_error", message: e.message } });
    }
  }
});

// ── Health ──────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({
  status: "ok", version: `v${PROXY_VERSION}`, backend: BACKEND, models: MODELS.length,
  endpoints: ["/v1/chat/completions", "/v1/messages", "/v1/models"],
}));

// ── Start ──────────────────────────────────────────────────────────
app.listen(PORT, "0.0.0.0", () => {
  console.log(`OpenCode Free Proxy v${PROXY_VERSION} (backend=${BACKEND}) on http://0.0.0.0:${PORT}`);
  console.log(`  CLI binary:  ${OPENCODE_BIN}`);
  console.log(`  CLI workdir: ${CLI_DIR}`);
  console.log("  OpenAI:    POST /v1/chat/completions");
  console.log("  Anthropic: POST /v1/messages");
  console.log("  Models:    GET  /v1/models");
  console.log("  Health:    GET  /health");
  console.log("  Models:", MODELS.join(", "));
  for (const [name, key] of Object.entries(apiKeys)) {
    console.log(`  ${name.padEnd(15)} ${key}`);
  }
});
