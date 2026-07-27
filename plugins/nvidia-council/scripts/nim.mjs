#!/usr/bin/env node
// nvidia-council: one small client for NVIDIA's hosted NIM endpoint (OpenAI-compatible).
// No proxy in the path - the base URL is fixed unless you point it at a self-hosted NIM.
// Config: NVIDIA_API_KEY / NVIDIA_COUNCIL_MODELS / NVIDIA_BASE_URL, from the environment or
// ~/.config/nvidia-council/env (a live env var wins). Everything lives in this one file so the
// commands are `node nim.mjs <subcommand>`.
//
//   node nim.mjs config                       validate + print a non-secret summary
//   node nim.mjs save                         persist NVIDIA_* from the environment (0600)
//   node nim.mjs models [filter]              list the catalog ids the key can see
//   node nim.mjs council                      print the council model ids, one per line
//   node nim.mjs ask [model...]               prompt on stdin -> answers (default: the council)
//   node nim.mjs doctor [--json] [model...]   health-probe models (OK/SLOW/DEAD/UNREACHABLE)
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_BASE_URL = 'https://integrate.api.nvidia.com/v1';
export const CONFIG_PATH =
  process.env.NVIDIA_COUNCIL_ENV || join(homedir(), '.config', 'nvidia-council', 'env');
// Three lineages (DeepSeek / Mistral / Zhipu), free on the NIM hosted tier, each verified
// present in the live catalog and answering. NVIDIA rotates ids, so treat this as a starting
// point with a shelf life - :doctor detects a rotted one and :models re-picks.
export const DEFAULT_MODELS =
  'deepseek-ai/deepseek-v4-pro,mistralai/mistral-small-4-119b-2603,z-ai/glm-5.2';
const KEYS = ['NVIDIA_API_KEY', 'NVIDIA_COUNCIL_MODELS', 'NVIDIA_BASE_URL'];

// NVIDIA's free tier rate-limits per KEY (~40 req/min account-wide), not per model, so the
// council's own fan-out is what trips it. Stagger request STARTS instead of firing them
// together; requests still overlap, so wall-clock stays close to the slowest single model.
// ponytail: fixed stagger, no token bucket - one process at a time is the only caller.
export const DEFAULT_INTERVAL_MS = 1600; // 60000/1600 = 37.5 req/min, just under the ~40 cap

// Garbage or non-positive overrides fall back rather than through. `NVIDIA_MIN_INTERVAL_MS=abc`
// would make this NaN, which poisons the queue's clock on the first claim and silently removes
// ALL pacing - failing open on exactly the thing this exists to enforce.
export function intervalFrom(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
}

export const MIN_INTERVAL_MS = intervalFrom(process.env.NVIDIA_MIN_INTERVAL_MS);

// ---------- config ----------

// Tolerant of dotenv (KEY=value, KEY="value") and the shell form (export KEY="${KEY:-value}").
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!m) continue;
    let [, key, val] = m;
    val = val.trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    const def = val.match(/^\$\{[A-Za-z_][A-Za-z0-9_]*:-([\s\S]*)\}$/); // ${VAR:-default}
    if (def) val = def[1];
    out[key] = val;
  }
  return out;
}

function fileConfig() {
  try { return parseEnvFile(readFileSync(CONFIG_PATH, 'utf8')); }
  catch { return {}; }
}

// env-wins: a non-blank live env var overrides the file. Whitespace-only counts as unset, so a
// blank-but-present variable (a failed shell interpolation) can't shadow a real saved value.
export function loadConfig(env = process.env, file = fileConfig()) {
  const pick = (k) => (env[k] != null && env[k].trim() !== '' ? env[k] : file[k]);
  return {
    apiKey: pick('NVIDIA_API_KEY'),
    models: pick('NVIDIA_COUNCIL_MODELS'),
    baseUrl: pick('NVIDIA_BASE_URL') || DEFAULT_BASE_URL, // override only for a self-hosted NIM
  };
}

export function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

// Strip the key out of anything about to be printed. Providers really do echo the rejected
// credential back in an auth error, and this plugin's output routinely ends up in a terminal, a
// log, and an agent's context. split/join rather than a regex so the secret needs no escaping.
// Short values are left alone - a 2-char "secret" would redact half the message.
export function redact(text, secret) {
  const s = String(text ?? '');
  return secret && String(secret).length >= 8 ? s.split(String(secret)).join('[redacted]') : s;
}

export function die(msg, code = 1) {
  process.stderr.write(msg + '\n');
  process.exit(code);
}

export function requireConfig() {
  if (typeof fetch !== 'function') die('this needs Node >=18 (built-in fetch not found) - check `node --version`');
  const c = loadConfig();
  if (!c.apiKey) die('set NVIDIA_API_KEY (an nvapi-... key from build.nvidia.com), then run /nvidia-council:setup');
  return c;
}

// existing (from file) overlaid by any non-blank env value among KEYS. Whitespace-only counts as
// unset - matching loadConfig, which also ignores it. Without the trim, `NVIDIA_API_KEY=' '`
// (a failed shell interpolation) overwrites a good saved key with a space, passes the truthiness
// check in `save`, and gets written to disk: the credential destroyed by a "successful" save.
export function mergeConfig(existing, env) {
  const out = { ...existing };
  for (const k of KEYS) if (env[k] != null && String(env[k]).trim() !== '') out[k] = env[k];
  return out;
}

export function serialize(cfg) {
  return KEYS.filter((k) => cfg[k] != null && cfg[k] !== '').map((k) => `${k}=${cfg[k]}`).join('\n') + '\n';
}

// ---------- models ----------

// Falls back to the default whenever the CLEANED list is empty (not just when raw is blank),
// so garbage like ",,," degrades to a working council instead of zero models.
const clean = (s) => String(s || '').split(',').map((x) => x.trim()).filter(Boolean);

export function councilModels(raw) {
  const cleaned = clean(raw);
  return cleaned.length ? cleaned : clean(DEFAULT_MODELS);
}

export function parseModels(json) {
  if (!json || !Array.isArray(json.data)) throw new Error('no data array');
  return json.data.map((m) => m && m.id).filter((x) => typeof x === 'string' && x !== '');
}

export function filterModels(ids, filter) {
  const uniqueSorted = [...new Set(ids)].sort();
  if (!filter) return uniqueSorted;
  const f = filter.toLowerCase();
  return uniqueSorted.filter((id) => id.toLowerCase().includes(f)); // literal substring, no regex
}

export async function fetchModelIds({ baseUrl, apiKey, timeoutMs = 30000 }) {
  const url = joinUrl(baseUrl, 'models');
  await claimSlot(); // the catalog spends the same per-key budget as a completion does
  const res = await fetch(url, { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) });
  const raw = await res.text();
  try {
    return parseModels(JSON.parse(raw));
  } catch {
    const e = new Error('unreadable model list');
    e.raw = raw;
    e.url = url;
    throw e;
  }
}

// ---------- chat ----------

const REASONING = /deepseek|nemotron|-r1|thinking|qwq|reason/i; // these spend tokens on thinking

export function maxTokensFor(model) {
  return REASONING.test(model) ? 32768 : 8192;
}

// Reasoning NIMs emit their scratchpad either in a separate `reasoning_content` field or inline
// in <think> tags. Drop the tagged block - but only if an answer survives, since a model that
// ran out of tokens mid-think has nothing else to show.
export function stripThink(s) {
  const t = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  return t || s.trim();
}

// Pull the reply out of a parsed response; null when there's nothing usable, so the caller can
// fall back to the raw body rather than print an empty string that looks like a blank answer.
export function extractReply(body) {
  const msg = body?.choices?.[0]?.message;
  // whitespace-only counts as empty: some models emit " " alongside a real reasoning_content,
  // and returning that blank would look like the model answered with nothing
  const content = typeof msg?.content === 'string' && msg.content.trim() !== '' ? msg.content : msg?.reasoning_content;
  const chain = content ?? body?.error?.message ?? body?.error ?? body?.detail ?? body?.title;
  if (chain == null || chain === '') return null;
  return typeof chain === 'string' ? stripThink(chain) : JSON.stringify(chain);
}

// Retry-After is seconds or an HTTP-date. Clamped so a hostile/absurd value can't park us.
export function retryAfterMs(header, now = Date.now()) {
  if (!header) return 5000;
  const secs = Number(String(header).trim());
  const ms = Number.isFinite(secs) ? secs * 1000 : Date.parse(header) - now;
  if (!Number.isFinite(ms) || ms < 0) return 5000;
  return Math.min(ms, 60000);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The rate limit is per KEY, so every request in this process shares one queue - including
// retries. Each caller claims the next slot and waits for it; staggering the fan-out instead
// would let a failed model's retry land on top of a later model's first attempt.
// ponytail: module-global, because one process is one council. Not safe across processes -
// if a second nim.mjs ever runs concurrently, this needs a real cross-process limiter.
let nextSlot = 0;
async function claimSlot() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_INTERVAL_MS;
  if (at > now) await sleep(at - now);
}

// Only a model-scoped rejection means the id itself is gone. A rejected key (401/403), a rate
// limit (429) or a provider fault (5xx) says nothing about the model - letting those read as
// "dead" would march the user through swapping out a perfectly healthy council on a bad key.
export function httpKind(status) {
  if (status === 404 || status === 410) return 'gone';
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'ratelimit';
  return 'server';
}

// One completion call. Never throws: returns {ok, kind, ms, text} so both the council and the
// doctor can use it. kind: gone | auth | ratelimit | server | errorbody | empty | timeout |
// network. A 429 is retried once honouring Retry-After - on the free tier that is the common
// failure. `timeoutMs` is the budget for the WHOLE call including that retry, and `ms` is always
// measured from the first attempt, so a rate-limited model can't report a fast, healthy latency.
export async function chat(model, prompt, { baseUrl, apiKey, timeoutMs = 300000, maxTokens, retries = 1 }) {
  const payload = {
    model,
    messages: [{ role: 'user', content: prompt }],
    max_tokens: maxTokens ?? maxTokensFor(model),
    temperature: 0.3,
  };
  await claimSlot(); // queue for a rate-limit slot BEFORE the clock starts - waiting your turn
  const started = Date.now(); // is not the model being slow, and must not eat its timeout
  const done = (o) => ({ ...o, ms: Date.now() - started });
  for (let attempt = 0; ; attempt++) {
    if (attempt) await claimSlot();
    const left = timeoutMs - (Date.now() - started);
    if (left <= 0) return done({ ok: false, kind: 'timeout', text: '(no response - timeout: retry budget exhausted)' });
    let res, raw;
    try {
      res = await fetch(joinUrl(baseUrl, 'chat/completions'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(left),
      });
      raw = await res.text();
    } catch (e) {
      // e.code on an AbortError is the legacy DOMException number (23) - useless in a message;
      // the cause's errno (ECONNREFUSED, ...) or the name is what actually tells you what broke.
      const kind = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'network';
      return done({ ok: false, kind, text: `(no response - ${kind}: ${e.cause?.code || e.name})` });
    }
    if (res.status === 429 && attempt < retries) {
      // don't burn the whole budget asleep only to report a timeout - if the backoff plus the
      // slot wait leaves no room to actually make the retry, say "rate limited" instead, which
      // is both the truth and the actionable answer
      const wait = retryAfterMs(res.headers.get('retry-after'));
      if (wait + MIN_INTERVAL_MS < timeoutMs - (Date.now() - started)) {
        await sleep(wait);
        continue;
      }
    }
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch { /* non-JSON body, e.g. an HTML 502 page */ }
    const reply = parsed ? extractReply(parsed) : null;
    // redact: an auth error can echo the key straight back, and this text gets printed
    const text = redact(reply != null ? reply : String(raw || '(no response)').slice(0, 500), apiKey);
    if (!res.ok) return done({ ok: false, kind: httpKind(res.status), status: res.status, text: `(HTTP ${res.status}) ${text}` });
    if (!parsed) return done({ ok: false, kind: 'empty', text });
    if (parsed.error || parsed.detail) return done({ ok: false, kind: 'errorbody', text });
    return done({ ok: true, kind: 'ok', text });
  }
}

// ---------- doctor ----------

// One good attempt wins. Among failures, only a model-scoped rejection (404/410, or a 2xx body
// carrying an error) means the id is gone -> DEAD. Everything else - timeouts, network errors,
// a rejected key, a rate limit, a 5xx, an unparseable body - is UNREACHABLE: unproven, not
// condemned, so a bad key or a busy provider never talks the user into replacing a good model.
export function classify(attempts, { slowMs = 15000 } = {}) {
  const good = attempts.filter((a) => a.ok);
  if (good.length) {
    const best = Math.min(...good.map((a) => a.ms));
    return { state: best > slowMs ? 'SLOW' : 'OK', best };
  }
  const dead = attempts.some((a) => a.kind === 'gone' || a.kind === 'errorbody');
  return { state: dead ? 'DEAD' : 'UNREACHABLE', best: null };
}

// A probe answers "does this id still serve?", not "is the answer good" - so any 2xx without an
// error body counts, even an empty one. A reasoning model that burns its budget on <think> is
// alive, and must not be condemned as DEAD.
export async function probe(model, cfg, { attempts = 2, slowMs = 15000, timeoutMs = 60000 } = {}) {
  const tries = [];
  for (let i = 0; i < attempts; i++) {
    // no pacing here - chat() takes a shared rate-limit slot per attempt (see claimSlot)
    const r = await chat(model, 'ping', { ...cfg, timeoutMs, maxTokens: 512, retries: 1 });
    tries.push(r);
    if (r.ok) break; // no need to keep spending rate limit once it answered
    // a rejected key and an exhausted rate limit are not going to change within this run, and
    // hammering either is exactly the wrong move - the verdict is UNREACHABLE regardless
    if (r.kind === 'auth' || r.kind === 'ratelimit') break;
  }
  return { model, ...classify(tries, { slowMs }), last: tries[tries.length - 1] };
}

// Positional walk, so a flag's VALUE can never be mistaken for a model id (a naive
// "drop the known flag strings" filter eats a model literally named `1`). Out-of-range numbers
// fall back to the default rather than through: `--attempts -1` would probe zero times and then
// report an untested model UNREACHABLE, and `--attempts Infinity` would never stop retrying.
const bounded = (v, dflt, min, max) => {
  const n = Number(v);
  return Number.isFinite(n) && n >= min && n <= max ? n : dflt;
};

export function parseDoctorArgs(args) {
  const out = { json: false, attempts: 2, slowMs: 15000, models: [] };
  // Only swallow the next token as a flag's value when it actually looks like one. Consuming it
  // blind means `doctor --attempts --json` eats the --json, so a caller gating on the JSON output
  // gets an empty stdout and no error - the silent kind of broken.
  const NUM = { '--attempts': ['attempts', 2, 1, 10], '--slow': ['slowMs', 15000, 0, 600000] };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (Object.hasOwn(NUM, a)) {
      const [key, dflt, min, max] = NUM[a];
      const next = args[i + 1];
      const isValue = next !== undefined && !String(next).startsWith('--');
      if (isValue) i++;
      out[key] = bounded(isValue ? next : undefined, dflt, min, max);
    } else if (a === '--json') out.json = true;
    else out.models.push(a);
  }
  out.attempts = Math.round(out.attempts);
  return out;
}

// ---------- CLI ----------

async function readStdin() {
  const chunks = [];
  for await (const ch of process.stdin) chunks.push(ch);
  return Buffer.concat(chunks).toString('utf8');
}

const CMDS = {
  async config() {
    if (typeof fetch !== 'function') die('this needs Node >=18 (built-in fetch not found) - check `node --version`');
    const c = loadConfig();
    if (!c.apiKey) die('missing NVIDIA_API_KEY (set it in the environment, then run /nvidia-council:setup)');
    console.log(`base URL: ${c.baseUrl}${c.baseUrl === DEFAULT_BASE_URL ? ' (NVIDIA hosted)' : ' (override)'}`);
    console.log('api key:  set (not shown)');
    console.log(`models:   ${c.models && c.models.trim() ? c.models : '(default trio)'}`);
  },

  async save() {
    const existing = existsSync(CONFIG_PATH) ? parseEnvFile(readFileSync(CONFIG_PATH, 'utf8')) : {};
    const merged = mergeConfig(existing, process.env);
    if (!merged.NVIDIA_API_KEY?.trim()) die('need NVIDIA_API_KEY in the environment to save config');
    mkdirSync(dirname(CONFIG_PATH), { recursive: true });
    if (existsSync(CONFIG_PATH)) {
      copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
      // the backup holds the key too - copyFileSync carries the SOURCE's mode, which may be
      // loose if that file was hand-written
      try { chmodSync(CONFIG_PATH + '.bak', 0o600); } catch { /* best effort on Windows */ }
    }
    writeFileSync(CONFIG_PATH, serialize(merged), { mode: 0o600 });
    try { chmodSync(CONFIG_PATH, 0o600); } catch { /* best effort on Windows */ }
    console.log(`saved config to ${CONFIG_PATH} (key not shown); models: ${merged.NVIDIA_COUNCIL_MODELS || '(default trio)'}`);
  },

  async council() {
    for (const m of councilModels(loadConfig().models)) console.log(m);
  },

  async models(args) {
    const cfg = requireConfig();
    let ids;
    try {
      ids = await fetchModelIds(cfg);
    } catch (e) {
      if (e.raw !== undefined) {
        process.stderr.write(`could not read a model list from ${e.url}\n${redact(String(e.raw).slice(0, 300), cfg.apiKey)}\n`);
        process.exit(1);
      }
      die(`could not reach NVIDIA: ${e.cause?.code || e.name || e.message}`);
    }
    if (!ids.length) {
      process.stderr.write('NVIDIA returned an empty catalog - check the key at build.nvidia.com\n');
      process.exit(0);
    }
    for (const id of filterModels(ids, args[0] || '')) console.log(id);
  },

  // prompt on stdin; models from argv, else the council. Prints one "### <model>" section each.
  async ask(args) {
    const cfg = requireConfig();
    const models = args.length ? args : councilModels(cfg.models);
    const prompt = await readStdin();
    if (!prompt.trim()) die('empty prompt on stdin', 2);
    // all at once: claimSlot() inside chat() does the pacing, and answers stay in model order
    const answers = await Promise.all(models.map(async (m) => (await chat(m, prompt, cfg)).text));
    models.forEach((m, i) => console.log(`### ${m}\n${answers[i]}\n`));
  },

  async doctor(args) {
    const { json, attempts, slowMs, models } = parseDoctorArgs(args);
    const cfg = requireConfig();
    const targets = models.length ? models : councilModels(cfg.models);
    const results = await Promise.all(targets.map((m) => probe(m, cfg, { attempts, slowMs })));
    for (const r of results) {
      const detail = r.best != null ? `${r.best}ms` : (r.last?.text || '').replace(/\s+/g, ' ').slice(0, 160);
      process.stderr.write(`${r.state.padEnd(11)} ${r.model}  ${detail}\n`);
      if (json) console.log(JSON.stringify({ model: r.model, state: r.state, ms: r.best }));
    }
    // a whole council failing at once is nearly always one cause, not N dead models - name it,
    // or the next step is a pointless hunt for replacements
    if (results.some((r) => r.last?.kind === 'auth')) {
      process.stderr.write('^ NVIDIA rejected the key - fix NVIDIA_API_KEY; the models are not the problem\n');
    } else if (results.some((r) => r.last?.kind === 'ratelimit')) {
      process.stderr.write('^ rate limit hit (~40 req/min per key) - wait a minute and re-run before replacing anything\n');
    }
    if (results.some((r) => r.state === 'DEAD' || r.state === 'UNREACHABLE')) process.exit(1);
  },
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  // hasOwn, not a plain lookup: `nim.mjs toString` would otherwise resolve to Object.prototype's
  // method, "succeed" silently and print nothing instead of the usage line
  const fn = cmd && Object.hasOwn(CMDS, cmd) ? CMDS[cmd] : null;
  if (!fn) die(`usage: nim.mjs <${Object.keys(CMDS).join('|')}> [args]`, 2);
  await fn(args);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
