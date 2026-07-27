#!/usr/bin/env node
// telegram-notify: one small client for the Telegram Bot API, for outbound notifications.
// Config: TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID / TELEGRAM_TARGETS / TELEGRAM_API_BASE, from the
// environment or ~/.config/telegram-notify/env (a live env var wins). Everything lives in this
// one file so the commands are `node tg.mjs <subcommand>`.
//
//   node tg.mjs config                     validate + print a non-secret summary
//   node tg.mjs token                      prompt for the bot token on a TTY (hidden) and save
//   node tg.mjs save                       persist TELEGRAM_* from the environment (0600)
//   node tg.mjs whoami                     getMe - proves the token and prints the bot's @name
//   node tg.mjs discover                   list chats that have written to the bot (find your id)
//   node tg.mjs targets                    print the configured targets, one per line
//   node tg.mjs send [text] [flags]        send a notification (text also read from stdin)
//   node tg.mjs doctor [--json] [--send]   check the token and every target
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

export const DEFAULT_API_BASE = 'https://api.telegram.org';
export const CONFIG_PATH =
  process.env.TELEGRAM_NOTIFY_ENV || join(homedir(), '.config', 'telegram-notify', 'env');
const KEYS = ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_TARGETS', 'TELEGRAM_API_BASE'];

// Telegram enforces TWO send limits: ~1 message/second to a single chat, and ~30/second bot-wide.
// One queue at just over a second satisfies both, conservatively - the caller that actually trips
// either is our own chunking of a long message into parts for the same chat. Bursts get a 429
// carrying retry_after. Reads (getMe/getChat/getUpdates) are not limited this way and stay unpaced.
export const DEFAULT_INTERVAL_MS = 1100;

// Garbage or non-positive overrides fall back rather than through. `TELEGRAM_MIN_INTERVAL_MS=abc`
// would make this NaN, which poisons the queue's clock on the first claim and silently removes
// ALL pacing - failing open on exactly the thing this exists to enforce.
export function intervalFrom(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_INTERVAL_MS;
}

export const MIN_INTERVAL_MS = intervalFrom(process.env.TELEGRAM_MIN_INTERVAL_MS);

// Telegram truncates at 4096 UTF-16 code units per message; longer text is an API error, not a
// silent cut, so anything longer has to be split before it is sent.
export const MAX_MESSAGE = 4096;

// ---------- config ----------

// Tolerant of dotenv (KEY=value, KEY="value") and the shell form (export KEY="${KEY:-value}").
export function parseEnvFile(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // `\s*=` so a hand-edited `KEY = value` is read rather than silently dropped - a dropped
    // line here looks exactly like a config that was never saved
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
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
  // trimmed on the way out: validToken() trims before checking, so an env var carrying stray
  // whitespace (` 123:AA... `, easy to produce by pasting into a shell) would pass validation and
  // then be spliced into the URL path with the spaces still in it. Telegram answers that 404,
  // which this reports as "token rejected" - sending the user to re-copy a token that was fine.
  const pick = (k) => (env[k] != null && env[k].trim() !== '' ? env[k] : file[k])?.trim();
  return {
    token: pick('TELEGRAM_BOT_TOKEN'),
    chatId: pick('TELEGRAM_CHAT_ID'),
    targets: pick('TELEGRAM_TARGETS'),
    apiBase: pick('TELEGRAM_API_BASE') || DEFAULT_API_BASE, // override only for a local Bot API server
  };
}

export function joinUrl(base, path) {
  return `${String(base).replace(/\/+$/, '')}/${String(path).replace(/^\/+/, '')}`;
}

// THE token lives in the URL PATH (/bot<token>/sendMessage), not in a header - so a leak here is
// one careless error message away. Node's fetch failures quote the URL, and this plugin's output
// routinely lands in a terminal, a log, and an agent's context. Everything printed goes through
// this. split/join rather than a regex so the secret needs no escaping.
export function redact(text, secret) {
  let s = String(text ?? '');
  if (!secret || String(secret).length < 8) return s;
  // Also the percent-encoded form: the token sits in the URL PATH, and a proxy or a non-JSON
  // error page routinely quotes that path back with the `:` escaped as %3A - which the literal
  // form would sail straight past.
  for (const form of new Set([String(secret), encodeURIComponent(String(secret))])) {
    s = s.split(form).join('[redacted]');
  }
  return s;
}

// redact() only removes the token we KNOW about. The other way a token reaches the output is the
// user putting one where a chat id or a target name belongs - then it comes straight back inside
// "unknown target ..." or "... is not a chat id". Anything BotFather-shaped is scrubbed on the
// way out, whether or not it is the configured token.
// %3A as well as ":" - the same percent-encoded path echo that redact() has to cover
const TOKEN_SHAPED = /\d{5,}(?::|%3A)[A-Za-z0-9_-]{30,}/gi;
export function scrub(text) {
  return String(text ?? '').replace(TOKEN_SHAPED, '[redacted]');
}

// every stderr path goes through here, so no printed line can carry a token
export function warn(msg) {
  process.stderr.write(scrub(msg));
}

// stdout for lines that ECHO CONFIG back (config/targets/save). A hand-edited file could have a
// token sitting in TELEGRAM_CHAT_ID or TELEGRAM_TARGETS, and printing the config is exactly when
// that surfaces. Message bodies and Telegram-supplied ids are printed with console.log directly -
// scrubbing a user's own text would corrupt the thing they asked to send.
export function say(msg) {
  console.log(scrub(msg));
}

export function die(msg, code = 1) {
  process.stderr.write(scrub(msg) + '\n');
  process.exit(code);
}

// BotFather issues `<numeric bot id>:<35-char secret>`. Checking the shape up front turns the
// three usual paste accidents - the @BotFather chat line, a truncated copy, a trailing quote -
// into one clear message instead of a 404 from Telegram that reads like the API is down.
export function validToken(token) {
  return /^\d{5,}:[A-Za-z0-9_-]{30,}$/.test(String(token || '').trim());
}

export function requireConfig() {
  if (typeof fetch !== 'function') die('this needs Node >= 22 - check `node --version` (built-in fetch not found, so this is older than 18)');
  const c = loadConfig();
  if (!c.token) die('no bot token - run /telegram-notify:setup (or set TELEGRAM_BOT_TOKEN)');
  if (!validToken(c.token)) die('TELEGRAM_BOT_TOKEN is not shaped like a BotFather token (<digits>:<35 chars>) - re-copy it from @BotFather');
  return c;
}

// existing (from file) overlaid by any non-blank env value among KEYS. Whitespace-only counts as
// unset - matching loadConfig, which also ignores it. Without the trim, `TELEGRAM_BOT_TOKEN=' '`
// (a failed shell interpolation) overwrites a good saved token with a space, passes the
// truthiness check in `save`, and gets written to disk: the credential destroyed by a
// "successful" save.
export function mergeConfig(existing, env) {
  const out = { ...existing };
  // stored trimmed, matching what loadConfig hands out - otherwise a token pasted with stray
  // spaces gets written to the file with them, and the saved file reads as subtly wrong
  for (const k of KEYS) if (env[k] != null && String(env[k]).trim() !== '') out[k] = String(env[k]).trim();
  return out;
}

export function serialize(cfg) {
  return KEYS.filter((k) => cfg[k] != null && cfg[k] !== '').map((k) => `${k}=${cfg[k]}`).join('\n') + '\n';
}

// `overrides` is the deliberate-change channel, separate from `env`: a value there is written
// verbatim and `null` DELETES the key. It has to bypass mergeConfig, whose blank-value guard
// (there to stop a failed shell interpolation from wiping the token) would otherwise make
// "remove my last target" a silent no-op.
function saveConfig(env, overrides = {}) {
  const existing = existsSync(CONFIG_PATH) ? parseEnvFile(readFileSync(CONFIG_PATH, 'utf8')) : {};
  const merged = mergeConfig(existing, env);
  for (const [k, v] of Object.entries(overrides)) {
    if (v == null || v === '') delete merged[k];
    else merged[k] = v;
  }
  // Validate at the WRITE boundary, not at each call site: values arrive from flags AND from the
  // live environment, and checking only the flags let `TELEGRAM_TARGETS=ops--100 tg.mjs save`
  // write a list that later reads back as no targets at all, reporting success the whole way.
  // Only what THIS write CHANGES is validated - pre-existing junk in a hand-edited file must not
  // brick an unrelated operation like saving a new token.
  if (merged.TELEGRAM_CHAT_ID != null && merged.TELEGRAM_CHAT_ID !== existing.TELEGRAM_CHAT_ID
      && !looksLikeChatId(merged.TELEGRAM_CHAT_ID)) {
    die(`"${merged.TELEGRAM_CHAT_ID}" is not a chat id (digits, or @channelusername) - run /telegram-notify:setup to discover it`, 2);
  }
  if (merged.TELEGRAM_TARGETS != null && merged.TELEGRAM_TARGETS !== existing.TELEGRAM_TARGETS) {
    const { value, error } = normalizeTargets(merged.TELEGRAM_TARGETS);
    if (error) die(`${error} (e.g. alerts:-1001234567890,build:-1001234567890:42)`, 2);
    merged.TELEGRAM_TARGETS = value;
  }
  if (!merged.TELEGRAM_BOT_TOKEN?.trim()) die('need TELEGRAM_BOT_TOKEN to save config');
  mkdirSync(dirname(CONFIG_PATH), { recursive: true });
  if (existsSync(CONFIG_PATH)) {
    copyFileSync(CONFIG_PATH, CONFIG_PATH + '.bak');
    // the backup holds the token too - copyFileSync carries the SOURCE's mode, which may be loose
    // if that file was hand-written
    try { chmodSync(CONFIG_PATH + '.bak', 0o600); } catch { /* best effort on Windows */ }
  }
  writeFileSync(CONFIG_PATH, serialize(merged), { mode: 0o600 });
  try { chmodSync(CONFIG_PATH, 0o600); } catch { /* best effort on Windows */ }
  return merged;
}

// ---------- targets ----------

// `name:chat[:thread]` pairs, e.g. `me:123456789,alerts:-1001234567890,build:-1001234567890:42`.
// The thread is a forum-topic id, so one group can host several notification streams. Chat ids
// are digits (negative for groups) or an @channelusername - neither contains a colon, so a plain
// split is unambiguous.
export function parseTargets(raw) {
  const out = {};
  for (const item of String(raw || '').split(',')) {
    const s = item.trim();
    if (!s) continue;
    const [name, chat, thread] = s.split(':').map((p) => p.trim());
    if (!name || !chat) continue;
    out[name] = thread ? { chat, thread } : { chat };
  }
  return out;
}

export function serializeTargets(map) {
  return Object.entries(map)
    .map(([name, t]) => (t.thread ? `${name}:${t.chat}:${t.thread}` : `${name}:${t.chat}`))
    .join(',');
}

export function looksLikeChatId(s) {
  return /^-?\d+$/.test(String(s)) || /^@[A-Za-z][A-Za-z0-9_]{4,}$/.test(String(s));
}

// Strict form of one target entry, for validating input before it is written. parseTargets
// itself stays lenient so a hand-edited config degrades instead of failing outright.
export const VALID_TARGET = /^[^:,\s][^:,]*:(-?\d+|@[A-Za-z][A-Za-z0-9_]{4,})(:\d+)?$/;

// Strict gate + canonical form, used on every write. Returns {value} or {error} rather than
// throwing, so the caller decides how to report it. parseTargets alone would accept this
// silently: it drops entries it cannot read, so "ops--100" saves fine and routes nowhere.
export function normalizeTargets(raw) {
  const entries = String(raw ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const bad = entries.find((e) => !VALID_TARGET.test(e.replace(/\s*:\s*/g, ':')));
  if (bad !== undefined) return { error: `target entry "${bad}" is not "name:chat_id" or "name:chat_id:topic_id"` };
  // A repeated name is last-one-wins in the map, so the earlier route would vanish without a
  // word - and the two entries that disagree are exactly the case where guessing is wrong.
  const names = entries.map((e) => e.split(':')[0].trim());
  const dupe = names.find((nm, i) => names.indexOf(nm) !== i);
  if (dupe !== undefined) return { error: `target name "${dupe}" appears more than once - each name routes to exactly one chat` };
  const map = parseTargets(raw);
  if (!Object.keys(map).length) return { error: 'the target list is empty' };
  return { value: serializeTargets(map) };
}

// A name resolves against the configured targets first, then - because a raw id is what people
// have in hand mid-incident - is accepted verbatim if it looks like a chat id. Returns null when
// nothing matches, so the caller can print the known names instead of failing at the API.
export function resolveTarget(name, { chatId, targets } = {}) {
  const map = parseTargets(targets);
  if (!name) {
    if (chatId && String(chatId).trim()) return { chat: String(chatId).trim() };
    const names = Object.keys(map);
    return names.length === 1 ? map[names[0]] : null; // one target is unambiguous; several is not
  }
  if (Object.hasOwn(map, name)) return map[name];
  return looksLikeChatId(name) ? { chat: String(name) } : null;
}

// ---------- message shaping ----------

export const LEVELS = { info: 'ℹ️', ok: '✅', warn: '⚠️', error: '❌' };

export function escapeHtml(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function formatMessage({ text, title, level, html = false } = {}) {
  const emoji = level ? `${LEVELS[level]} ` : '';
  const body = String(text ?? '');
  if (!title) return emoji ? `${emoji}${body}`.trimEnd() : body;
  const head = `${emoji}${html ? `<b>${escapeHtml(title)}</b>` : title}`;
  return body.trim() ? `${head}\n\n${body}` : head;
}

// Split on the last newline that leaves a reasonably full part, so a log tail breaks between
// lines instead of mid-word. A line longer than the limit still has to be cut hard.
export function chunk(text, limit = MAX_MESSAGE) {
  const out = [];
  let rest = String(text ?? '');
  const max = Math.max(1, Math.round(limit));
  while (rest.length > max) {
    let cut = rest.lastIndexOf('\n', max);
    if (cut <= max / 2) cut = max; // no useful break point - hard split rather than emit a sliver
    out.push(rest.slice(0, cut));
    rest = rest.slice(cut).replace(/^\n/, '');
  }
  if (rest !== '') out.push(rest);
  return out;
}

// ---------- API ----------

export function apiUrl(base, token, method) {
  return joinUrl(base, `bot${token}/${method}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One shared queue rather than a stagger per call site, so a retry cannot land on top of the
// next chunk's first attempt. ponytail: module-global, because one process is one
// notification. Not safe across processes - concurrent tg.mjs runs can still earn a 429, which
// is retried honouring retry_after.
let nextSlot = 0;
async function claimSlot() {
  const now = Date.now();
  const at = Math.max(now, nextSlot);
  nextSlot = at + MIN_INTERVAL_MS;
  if (at > now) await sleep(at - now);
}

// Telegram puts the backoff in the RESPONSE BODY (parameters.retry_after, seconds), not in a
// Retry-After header like most APIs. Clamped so a hostile/absurd value can't park us.
export function retryAfterMs(body, header) {
  const secs = Number(body?.parameters?.retry_after);
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60000);
  // `Number('')` is 0, not NaN - without the emptiness check a MISSING header would read as
  // "retry after 0ms" and turn the backoff into a hot loop against a rate limiter
  const raw = String(header ?? '').trim();
  const h = raw === '' ? NaN : Number(raw);
  if (Number.isFinite(h) && h >= 0) return Math.min(h * 1000, 60000);
  return 5000;
}

// What kind of "no" this is decides what the user should do about it, so the distinctions matter:
// a rejected TOKEN is not a missing CHAT, and neither is a rate limit. 404 lands here as `auth`
// because Telegram answers a malformed token with 404 on the /bot<token>/ path itself - reporting
// that as "method not found" would send someone hunting a bug in this file.
export function apiKind(status, body) {
  if (body && body.ok === true) return 'ok';
  const code = Number(body?.error_code) || Number(status);
  const desc = String(body?.description || '').toLowerCase();
  if (code === 401 || code === 404) return 'auth';
  if (code === 409) return 'conflict'; // a webhook is set, or another poller holds getUpdates
  if (code === 429) return 'ratelimit';
  if (code === 403) return 'blocked'; // bot blocked by the user, or kicked from the group
  // "message thread not found" is target-scoped too: the topic id in the target is wrong. Left
  // as a generic badrequest it would surface as UNREACHABLE with no hint, pointing the user at
  // the network instead of at the one number they need to change.
  if (code === 400) return /chat not found|chat_id is empty|user not found|chat was upgraded|thread not found/.test(desc) ? 'notfound' : 'badrequest';
  if (code >= 500) return 'server';
  return 'badrequest';
}

// Human-facing next step per failure kind. Without this the raw description ("Bad Request: chat
// not found") is technically true and operationally useless - the actual cause is almost always
// "the bot has never seen that chat", which no API text says.
export const HINTS = {
  auth: 'Telegram rejected the token - re-copy it from @BotFather and re-run /telegram-notify:setup',
  notfound: 'chat or topic not found - a bot can only message a chat that contacted it first: open the bot in Telegram and send /start (for a group: add the bot, then post any message), then re-run /telegram-notify:setup. If the target pins a topic id, check that topic still exists',
  blocked: 'the bot is blocked, or is not a member of that chat - unblock it, or re-add it to the group',
  ratelimit: 'rate limited - Telegram allows ~1 message/second to one chat and ~30/second overall; wait and retry',
  conflict: 'another process holds the update stream (or a webhook is set) - stop it, or delete the webhook, then retry',
  server: 'Telegram returned a server error - transient, retry shortly',
  timeout: 'no answer in time - check network/proxy reachability to api.telegram.org',
  network: 'could not reach api.telegram.org - check network, DNS, or a corporate proxy',
};

// One API call. Never throws: returns {ok, kind, result, description, ms} so send/doctor share it.
// A 429 is retried once honouring retry_after. `timeoutMs` is the budget for the WHOLE call
// including that retry, and `ms` is measured from the first attempt, so a rate-limited call can't
// report a fast, healthy latency.
export async function call(method, params, cfg, { timeoutMs = 20000, retries = 1, pace = false } = {}) {
  if (pace) await claimSlot(); // queue BEFORE the clock starts - waiting your turn is not latency
  const started = Date.now();
  const done = (o) => ({ ...o, ms: Date.now() - started });
  for (let attempt = 0; ; attempt++) {
    if (attempt && pace) await claimSlot();
    const left = timeoutMs - (Date.now() - started);
    if (left <= 0) return done({ ok: false, kind: 'timeout', description: 'timeout: retry budget exhausted' });
    let res, raw;
    try {
      res = await fetch(apiUrl(cfg.apiBase, cfg.token, method), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // AbortSignal.timeout throws RangeError on a fractional value, which would surface as a
        // "network" failure and hide the real outcome
        body: JSON.stringify(params ?? {}),
        signal: AbortSignal.timeout(Math.max(1, Math.round(left))),
      });
      raw = await res.text();
    } catch (e) {
      // e.code on an AbortError is the legacy DOMException number (23) - useless in a message;
      // the cause's errno (ENOTFOUND, ECONNREFUSED, ...) or the name is what tells you what broke.
      // The message is redacted because a fetch failure can quote the URL, and the URL holds the token.
      const kind = e.name === 'TimeoutError' || e.name === 'AbortError' ? 'timeout' : 'network';
      return done({ ok: false, kind, description: redact(`${kind}: ${e.cause?.code || e.name}`, cfg.token) });
    }
    let body = null;
    try { body = JSON.parse(raw); } catch { /* non-JSON body, e.g. an HTML 502 from a proxy */ }
    const kind = apiKind(res.status, body);
    if (kind === 'ratelimit' && attempt < retries) {
      const wait = retryAfterMs(body, res.headers.get('retry-after'));
      // don't burn the whole budget asleep only to report a timeout - if the backoff leaves no
      // room to actually make the retry, report the rate limit, which is the actionable answer
      if (wait + (pace ? MIN_INTERVAL_MS : 0) < timeoutMs - (Date.now() - started)) {
        await sleep(wait);
        continue;
      }
    }
    if (body?.ok === true) return done({ ok: true, kind: 'ok', result: body.result });
    const description = redact(
      String(body?.description || raw || `HTTP ${res.status}`).slice(0, 500), cfg.token,
    );
    // a group promoted to a supergroup keeps working under a NEW id; naming it turns a dead
    // target into a one-line config fix
    const migrate = body?.parameters?.migrate_to_chat_id;
    return done({ ok: false, kind, status: res.status, description, ...(migrate ? { migrate } : {}) });
  }
}

// ---------- discovery ----------

// Every update shape that carries a chat, so `discover` also finds a group the bot was just
// ADDED to (my_chat_member) - there is no message in that case, and telling the user "send
// something" when they already did the right thing is the confusing part of every other guide.
const CHAT_BEARING = ['message', 'edited_message', 'channel_post', 'edited_channel_post', 'my_chat_member', 'chat_member'];

export function collectChats(updates) {
  const seen = new Map();
  const visit = (chat) => {
    if (!chat || (typeof chat.id !== 'number' && typeof chat.id !== 'string')) return;
    const id = String(chat.id);
    if (seen.has(id)) return;
    const name = chat.title
      || [chat.first_name, chat.last_name].filter(Boolean).join(' ')
      || (chat.username ? `@${chat.username}` : '');
    seen.set(id, { id, type: chat.type || '?', name });
  };
  for (const u of Array.isArray(updates) ? updates : []) {
    if (!u || typeof u !== 'object') continue;
    for (const k of CHAT_BEARING) visit(u[k]?.chat);
    visit(u.callback_query?.message?.chat);
  }
  return [...seen.values()];
}

// ---------- send ----------

// Positional walk, so a flag's VALUE can never be mistaken for a flag. Consuming the next token
// blind means `send --title --html` eats the --html and titles the message "--html"; rejecting
// anything that starts with `--` would instead break a legitimate `--title "-- build --"`. Only a
// flag-SHAPED token (--word, --two-words) counts as the next flag.
const FLAGISH = /^--[a-z][a-z-]*$/;

export function parseSendArgs(args) {
  const out = { to: null, title: null, level: null, thread: null, text: null, html: false, silent: false, dryRun: false };
  const STR = { '--to': 'to', '--title': 'title', '--level': 'level', '--thread': 'thread', '--text': 'text' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (Object.hasOwn(STR, a)) {
      const next = args[i + 1];
      if (next === undefined || FLAGISH.test(String(next))) throw new Error(`${a} needs a value`);
      out[STR[a]] = next;
      i++;
    } else if (a === '--html') out.html = true;
    else if (a === '--silent') out.silent = true;
    else if (a === '--dry-run') out.dryRun = true;
    // only an option-SHAPED token is an option. A blanket startsWith('-') would reject the
    // perfectly ordinary message `- deploy failed` (or `-5 degrees`) as an unknown flag.
    else if (/^-{1,2}[A-Za-z][\w-]*$/.test(a)) throw new Error(`unknown option: ${a}`);
    else if (out.text === null) out.text = a; // bare positional = the message
    else throw new Error(`unexpected argument: ${a} (quote the message, or use --text)`);
  }
  // silently ignoring a typo'd level would drop the ❌ from a failure notification and nobody
  // would notice until it mattered
  if (out.level !== null && !Object.hasOwn(LEVELS, out.level)) {
    throw new Error(`unknown --level ${out.level} (use: ${Object.keys(LEVELS).join(', ')})`);
  }
  // sendPayload feeds this to Number(); an unchecked word becomes NaN in the payload and comes
  // back as an opaque Bad Request instead of naming the actual mistake
  if (out.thread !== null && !/^\d+$/.test(out.thread)) {
    throw new Error(`--thread must be a numeric topic id, got "${out.thread}"`);
  }
  return out;
}

export function sendPayload(target, text, { html = false, silent = false } = {}) {
  return {
    chat_id: target.chat,
    text,
    ...(target.thread ? { message_thread_id: Number(target.thread) } : {}),
    ...(html ? { parse_mode: 'HTML' } : {}),
    ...(silent ? { disable_notification: true } : {}),
  };
}

async function readStdin() {
  const chunks = [];
  for await (const ch of process.stdin) chunks.push(ch);
  return Buffer.concat(chunks).toString('utf8');
}

// ---------- doctor ----------

export function parseDoctorArgs(args) {
  const out = { json: false, send: false };
  for (const a of args) {
    if (a === '--json') out.json = true;
    else if (a === '--send') out.send = true;
    else throw new Error(`unknown option: ${a}`);
  }
  return out;
}

// Only a chat-scoped rejection means the target itself is wrong. A rejected token, a rate limit,
// a 5xx or a network fault says nothing about the chat - reporting those as MISSING would march
// the user through re-discovering a perfectly good chat id on a bad token.
export function targetState(kind) {
  if (kind === 'ok') return 'OK';
  if (kind === 'notfound') return 'MISSING';
  if (kind === 'blocked') return 'BLOCKED';
  return 'UNREACHABLE';
}

// ---------- CLI ----------

// Reads the token from the terminal with the echo suppressed, so it never reaches this session's
// transcript, the shell history, or argv (visible in the process list on a shared box). Only
// usable from a real terminal - the caller falls back to the environment path when it is not.
async function promptHidden(question) {
  const { createInterface } = await import('node:readline');
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    process.stdout.write(question);
    rl._writeToOutput = () => {}; // suppress the echo, including the prompt's own re-render
    rl.question('', (answer) => {
      rl.close();
      process.stdout.write('\n');
      resolve(answer);
    });
  });
}

const CMDS = {
  async config() {
    if (typeof fetch !== 'function') die('this needs Node >= 22 - check `node --version` (built-in fetch not found, so this is older than 18)');
    const c = loadConfig();
    if (!c.token) die('no bot token saved - run /telegram-notify:setup');
    const map = parseTargets(c.targets);
    say(`config:   ${CONFIG_PATH}`);
    say(`api base: ${c.apiBase}${c.apiBase === DEFAULT_API_BASE ? '' : ' (override)'}`);
    console.log(`token:    set${validToken(c.token) ? '' : ' but MALFORMED'} (not shown)`);
    say(`default:  ${c.chatId || '(none)'}`);
    say(`targets:  ${Object.keys(map).length ? serializeTargets(map) : '(none)'}`);
  },

  async token() {
    if (!process.stdin.isTTY) {
      die('not a terminal - run this in your own terminal, or set TELEGRAM_BOT_TOKEN and use `tg.mjs save`');
    }
    const entered = (await promptHidden('Paste the @BotFather token (input hidden): ')).trim();
    if (!entered) die('nothing entered');
    if (!validToken(entered)) die('that is not shaped like a BotFather token (<digits>:<35 chars>) - copy the whole line, no quotes');
    const cfg = { ...loadConfig(), token: entered };
    const me = await call('getMe', {}, cfg);
    if (!me.ok) die(`token check failed: ${me.description}\n${HINTS[me.kind] || ''}`);
    saveConfig(process.env, { TELEGRAM_BOT_TOKEN: entered });
    say(`saved ${CONFIG_PATH} - bot @${me.result?.username || '?'} (token not shown)`);
  },

  // The token comes from the ENVIRONMENT only - argv is visible in the process list. The chat
  // id and target list are not secret, so they take flags: `VAR=x cmd` is a bash-ism that is a
  // parse error in PowerShell, and setup should not need a different line per shell.
  async save(args) {
    const over = {};
    const FLAGS = { '--chat': 'TELEGRAM_CHAT_ID', '--targets': 'TELEGRAM_TARGETS', '--api-base': 'TELEGRAM_API_BASE' };
    for (let i = 0; i < args.length; i++) {
      const key = FLAGS[args[i]];
      if (!key) die(`unknown option: ${args[i]} (use: ${Object.keys(FLAGS).join(', ')})`, 2);
      const next = args[i + 1];
      if (next === undefined || /^--[a-z]/.test(String(next))) die(`${args[i]} needs a value`, 2);
      over[key] = next.trim() || null; // an explicitly empty value CLEARS the setting
      i++;
    }
    // no validation here: saveConfig validates every value it is about to write, whichever way
    // it arrived, so the live-environment path cannot slip past the flag path's checks
    const merged = saveConfig(process.env, over);
    say(`saved config to ${CONFIG_PATH} (token not shown); default chat: ${merged.TELEGRAM_CHAT_ID || '(none)'}; targets: ${merged.TELEGRAM_TARGETS || '(none)'}`);
  },

  async whoami() {
    const cfg = requireConfig();
    const r = await call('getMe', {}, cfg);
    if (!r.ok) die(`${r.description}\n${HINTS[r.kind] || ''}`);
    const me = r.result || {};
    say(`@${me.username || '?'}  ${me.first_name || ''}  id=${me.id ?? '?'}`); // a bot display name is attacker-influenced text
  },

  // `targets` alone lists; `add`/`rm` edit. Editing here rather than by rewriting the whole
  // TELEGRAM_TARGETS string elsewhere means adding one route can't drop the others.
  async targets(args) {
    const [op, ...rest] = args;
    if (op === 'add' || op === 'rm') {
      // Edit the SAVED FILE, not the env-winning view, and write back only TELEGRAM_TARGETS.
      // Basing this on loadConfig() and saving with process.env would let a temporary
      // `TELEGRAM_TARGETS=...` in the shell get baked into the file - and would drag any live
      // TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID onto disk with it, silently replacing saved values
      // the user never asked to touch.
      const saved = existsSync(CONFIG_PATH) ? parseEnvFile(readFileSync(CONFIG_PATH, 'utf8')) : {};
      const map = parseTargets(saved.TELEGRAM_TARGETS);
      // parseTargets drops what it cannot read, and this write puts the PARSED map back - so a
      // hand-broken entry in the file would vanish without a word. Say it out loud; the .bak is
      // the recovery path.
      const rawCount = String(saved.TELEGRAM_TARGETS || '').split(',').filter((s) => s.trim()).length;
      if (rawCount > Object.keys(map).length) {
        warn(`note: ${rawCount - Object.keys(map).length} unreadable or duplicate entry in the saved target list will be dropped (previous file kept as ${CONFIG_PATH}.bak)\n`);
      }
      const live = process.env.TELEGRAM_TARGETS;
      if (live != null && live.trim() !== '' && live !== saved.TELEGRAM_TARGETS) {
        warn('note: TELEGRAM_TARGETS is set in this environment and will keep shadowing the saved file until you unset it\n');
      }
      const name = rest[0];
      if (!name) die(`usage: tg.mjs targets ${op} <name>${op === 'add' ? ' <chat id> [topic id]' : ''}`, 2);
      if (name.includes(':') || name.includes(',')) die('a target name cannot contain ":" or "," (they separate the fields)', 2);
      // exact arity: silently ignoring a trailing operand makes `targets rm a b` look like it
      // removed both, and `targets add n 1 2 3` look like it stored everything passed
      const maxArgs = op === 'add' ? 3 : 1;
      if (rest.length > maxArgs) die(`too many arguments for "targets ${op}" - got ${rest.length}, expected at most ${maxArgs}`, 2);
      if (op === 'add') {
        const [, chat, thread] = rest;
        if (!chat) die('usage: tg.mjs targets add <name> <chat id> [topic id]', 2);
        if (!looksLikeChatId(chat)) die(`"${chat}" is not a chat id (digits, or @channelusername) - run /telegram-notify:setup to discover it`, 2);
        if (thread !== undefined && !/^\d+$/.test(thread)) die(`"${thread}" is not a topic id (digits)`, 2);
        map[name] = thread ? { chat, thread } : { chat };
      } else {
        if (!Object.hasOwn(map, name)) die(`no target "${name}" - known: ${Object.keys(map).join(', ') || '(none)'}`);
        delete map[name];
      }
      const line = serializeTargets(map);
      // {} as the env, so nothing but the target list is touched. null clears the key when the
      // last target is removed.
      saveConfig({}, { TELEGRAM_TARGETS: line || null });
      say(`targets: ${line || '(none)'}`);
      return;
    }
    if (op !== undefined) die(`usage: tg.mjs targets [add <name> <chat id> [topic id] | rm <name>]`, 2);
    const c = loadConfig();
    const map = parseTargets(c.targets);
    if (c.chatId) say(`(default)\t${c.chatId}`);
    for (const [name, t] of Object.entries(map)) say(`${name}\t${t.chat}${t.thread ? `\ttopic ${t.thread}` : ''}`);
    if (!c.chatId && !Object.keys(map).length) console.log('(no targets configured - run /telegram-notify:setup)');
  },

  // Lists every chat Telegram still has a pending update for. This is the friendly way to learn
  // your own numeric id: message the bot, run this, copy the number.
  async discover() {
    const cfg = requireConfig();
    // No `offset`, so this does NOT confirm/consume the updates - another consumer of the same
    // bot (a poller, a webhook-less channel plugin) still sees them afterwards.
    const r = await call('getUpdates', { limit: 100, timeout: 0 }, cfg);
    if (!r.ok) die(`${r.description}\n${HINTS[r.kind] || ''}`);
    const chats = collectChats(r.result);
    if (!chats.length) {
      warn('no chats yet - open the bot in Telegram and send it /start (for a group: add the bot, then post any message), then re-run.\nnote: Telegram only keeps pending updates for ~24h, and a bot with a webhook or another running poller will not list any here.\n');
      process.exit(0);
    }
    // say(): a chat TITLE is other people's text, so it holds the same invariant as the rest
    for (const c of chats) say(`${c.id}\t${c.type}\t${c.name}`);
  },

  async send(args) {
    let opts;
    try { opts = parseSendArgs(args); } catch (e) { die(String(e.message), 2); }
    const cfg = requireConfig();
    const target = resolveTarget(opts.to, cfg);
    if (!target) {
      const known = Object.keys(parseTargets(cfg.targets));
      die(opts.to
        ? `unknown target "${opts.to}" - known: ${known.join(', ') || '(none)'}${cfg.chatId ? ', or omit --to for the default' : ''}`
        : `no default chat - pass --to <name|chat id>, or run /telegram-notify:setup${known.length ? ` (known: ${known.join(', ')})` : ''}`);
    }
    // an explicit --thread overrides the topic the target pins, so one target can still address
    // a different topic ad hoc. Without this merge the flag parses, documents, and does nothing.
    const dest = opts.thread ? { ...target, thread: opts.thread } : target;
    // stdin only when it is a pipe: reading a TTY with no input would hang forever with no output
    const text = opts.text ?? (process.stdin.isTTY ? '' : await readStdin());
    const message = formatMessage({ text, title: opts.title, level: opts.level, html: opts.html });
    if (!message.trim()) die('nothing to send - pass text as an argument, --text, or on stdin', 2);
    const parts = chunk(message);
    if (opts.dryRun) {
      say(`would send ${parts.length} message(s) to chat ${dest.chat}${dest.thread ? ` topic ${dest.thread}` : ''}${opts.html ? ' as HTML' : ''}${opts.silent ? ' silently' : ''}:`);
      // scrubbed, unlike the real send: a dry run's whole output is a PREVIEW for a human
      // terminal and an agent's context, which is exactly where a token must not land. The real
      // send delivers the text verbatim to a chat, so a token-shaped body is masked here only.
      say(parts.map((p, i) => `--- part ${i + 1}/${parts.length} ---\n${p}`).join('\n'));
      return;
    }
    // splitting counts characters, which knows nothing about markup - a tag or a <pre> block
    // straddling the cut leaves both halves unbalanced and Telegram rejects them with "can't
    // parse entities". Say so up front; the alternative failure is an API error that reads like
    // the message was malformed to begin with.
    if (opts.html && parts.length > 1) {
      warn(`warning: ${parts.length} parts and --html - a tag split across parts will be rejected; send plain text or shorten it\n`);
    }
    for (const [i, part] of parts.entries()) {
      const r = await call('sendMessage', sendPayload(dest, part, opts), cfg, { pace: true });
      if (!r.ok) {
        const where = parts.length > 1 ? ` (part ${i + 1}/${parts.length})` : '';
        const extra = r.migrate ? `\nthe group became a supergroup - its id is now ${r.migrate}; update the target` : '';
        die(`send failed${where}: ${r.description}\n${HINTS[r.kind] || ''}${extra}`);
      }
    }
    warn(`sent ${parts.length} message(s) to ${opts.to || target.chat}\n`);
  },

  async doctor(args) {
    let opts;
    try { opts = parseDoctorArgs(args); } catch (e) { die(String(e.message), 2); }
    const cfg = requireConfig();
    const me = await call('getMe', {}, cfg);
    const line = (s, name, detail) => warn(`${String(s).padEnd(11)} ${String(name).padEnd(22)} ${detail}\n`);
    if (!me.ok) {
      line(me.kind === 'auth' ? 'BAD_TOKEN' : 'UNREACHABLE', 'token', me.description);
      warn(`^ ${HINTS[me.kind] || 'could not verify the token'}\n`);
      if (opts.json) console.log(JSON.stringify({ token: 'FAIL', kind: me.kind }));
      process.exit(1);
    }
    line('OK', 'token', `@${me.result?.username || '?'} (${me.ms}ms)`);

    const map = parseTargets(cfg.targets);
    const list = [
      ...(cfg.chatId ? [['(default)', { chat: cfg.chatId }]] : []),
      ...Object.entries(map),
    ];
    if (!list.length) {
      warn('no targets configured - run /telegram-notify:setup\n');
      if (opts.json) console.log(JSON.stringify({ token: 'OK', targets: [] }));
      return;
    }
    let bad = 0;
    for (const [name, t] of list) {
      // getChat verifies reachability WITHOUT posting - a health check that pings every target
      // trains people to ignore the notification channel
      const r = opts.send
        // silent: a health check across several targets should not make every phone in the room
        // buzz at once - the message still lands, it just arrives without a sound
        ? await call('sendMessage', sendPayload(t, `${LEVELS.ok} telegram-notify test - target "${name}"`, { silent: true }), cfg, { pace: true })
        : await call('getChat', { chat_id: t.chat }, cfg);
      const state = targetState(r.kind);
      if (state !== 'OK') bad++;
      const title = r.ok ? (r.result?.chat?.title || r.result?.title || r.result?.username || t.chat) : r.description;
      line(state, name, `${t.chat}${t.thread ? ` topic ${t.thread}` : ''}  ${title}`);
      if (state !== 'OK' && HINTS[r.kind]) warn(`  ^ ${HINTS[r.kind]}\n`);
      if (opts.json) say(JSON.stringify({ target: name, chat: t.chat, state }));
    }
    if (bad) process.exit(1);
  },
};

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  // hasOwn, not a plain lookup: `tg.mjs toString` would otherwise resolve to Object.prototype's
  // method, "succeed" silently and print nothing instead of the usage line
  const fn = cmd && Object.hasOwn(CMDS, cmd) ? CMDS[cmd] : null;
  if (!fn) die(`usage: tg.mjs <${Object.keys(CMDS).join('|')}> [args]`, 2);
  await fn(args);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) main();
