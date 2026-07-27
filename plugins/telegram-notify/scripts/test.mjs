#!/usr/bin/env node
// Self-check for telegram-notify. No network, no deps, no token: exercises the pure logic
// (config parse/merge, target parsing/resolution, message shaping, chunking, update scraping,
// error classification, retry_after parsing, arg parsing) plus the request loop against a
// stubbed fetch. Run: node scripts/test.mjs
import assert from 'node:assert/strict';

// Message sends take a slot in the shared per-chat queue - at the shipped 1100ms the stubbed
// send tests would be seconds of pure waiting. Shrink the interval BEFORE importing (the module
// reads it once at load), which also exercises the env override. The pacing test asserts a
// property relative to MIN_INTERVAL_MS, so it proves the same thing at any interval.
// 150ms, not 20ms: Windows' timer granularity is ~16ms, which at 20ms would be most of the gap.
process.env.TELEGRAM_MIN_INTERVAL_MS ||= '150';
const {
  parseEnvFile, loadConfig, joinUrl, mergeConfig, serialize, redact, validToken,
  parseTargets, serializeTargets, looksLikeChatId, resolveTarget, VALID_TARGET, scrub, normalizeTargets,
  formatMessage, escapeHtml, chunk, LEVELS, MAX_MESSAGE,
  apiUrl, apiKind, retryAfterMs, collectChats, targetState,
  parseSendArgs, parseDoctorArgs, sendPayload, call,
  intervalFrom, MIN_INTERVAL_MS, DEFAULT_INTERVAL_MS, DEFAULT_API_BASE,
} = await import('./tg.mjs');

let n = 0;
const eq = (name, a, b) => { assert.deepEqual(a, b, name); n++; };
const ok = (name, v) => { assert.ok(v, name); n++; };
const throws = (name, fn) => { assert.throws(fn, name); n++; };

// Not a credential: a made-up string that merely MATCHES the BotFather shape, which the
// redaction tests need in order to prove a real one would be caught.
const TOKEN = '123456789:AAFakeTokenForTestsOnly_0123456789ab'; // secret-guard:allow
ok('the test token is shaped like a real one', validToken(TOKEN));

// --- config ---
eq('parseEnvFile dotenv', parseEnvFile(`TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_CHAT_ID="42"`),
  { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '42' });
eq('parseEnvFile shell form', parseEnvFile('export TELEGRAM_CHAT_ID="${TELEGRAM_CHAT_ID:-77}"'), { TELEGRAM_CHAT_ID: '77' });
eq('parseEnvFile skips comments/blanks', parseEnvFile('# c\n\nA=1'), { A: '1' });
// a hand-edited config with spaces around `=` must not silently lose the line - that looks
// identical to a config that was never saved
eq('parseEnvFile tolerates spaces around =', parseEnvFile('TELEGRAM_CHAT_ID = 42'), { TELEGRAM_CHAT_ID: '42' });
eq('loadConfig env wins over file',
  loadConfig({ TELEGRAM_BOT_TOKEN: 'live' }, { TELEGRAM_BOT_TOKEN: 'file' }).token, 'live');
eq('loadConfig blank env falls back to file (a failed interpolation must not shadow the file)',
  loadConfig({ TELEGRAM_BOT_TOKEN: '  ' }, { TELEGRAM_BOT_TOKEN: 'file' }).token, 'file');
eq('loadConfig defaults to the public Bot API', loadConfig({}, {}).apiBase, DEFAULT_API_BASE);
eq('loadConfig honours a local Bot API server override',
  loadConfig({ TELEGRAM_API_BASE: 'http://127.0.0.1:8081' }, {}).apiBase, 'http://127.0.0.1:8081');
eq('joinUrl trims a trailing slash', joinUrl('https://api.telegram.org/', 'x'), 'https://api.telegram.org/x');
eq('apiUrl puts the token in the path', apiUrl('https://api.telegram.org', 'T', 'getMe'), 'https://api.telegram.org/botT/getMe');

eq('mergeConfig env overrides, preserves the rest',
  mergeConfig({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'old' }, { TELEGRAM_CHAT_ID: 'new', OTHER: 'x' }),
  { TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: 'new' });
eq('mergeConfig ignores an empty env value', mergeConfig({ TELEGRAM_BOT_TOKEN: 't' }, { TELEGRAM_BOT_TOKEN: '' }), { TELEGRAM_BOT_TOKEN: 't' });
eq('mergeConfig ignores a whitespace-only env value (a blank save must not destroy the token)',
  mergeConfig({ TELEGRAM_BOT_TOKEN: 't' }, { TELEGRAM_BOT_TOKEN: '   ' }), { TELEGRAM_BOT_TOKEN: 't' });
eq('mergeConfig stores a trimmed value, matching what loadConfig hands back',
  mergeConfig({}, { TELEGRAM_BOT_TOKEN: `  ${TOKEN}  ` }).TELEGRAM_BOT_TOKEN, TOKEN);
eq('serialize writes only known keys', serialize({ TELEGRAM_BOT_TOKEN: 't', OTHER: 'x' }), 'TELEGRAM_BOT_TOKEN=t\n');
// save -> reload round-trip: a format drift between serialize and parseEnvFile would slip past
// testing either one alone
const rt = { TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_CHAT_ID: '-1001234567890', TELEGRAM_TARGETS: 'me:42,ops:-100:7' };
eq('serialize output parses back identically', parseEnvFile(serialize(rt)), rt);

// --- token shape ---
eq('validToken rejects the @BotFather prose line', validToken('Use this token to access the HTTP API: 123:abc'), false);
eq('validToken rejects a truncated copy', validToken('123456789:AAFake'), false);
eq('validToken rejects quotes carried along by the paste', validToken(`"${TOKEN}"`), false);
eq('validToken tolerates surrounding whitespace', validToken(` ${TOKEN} `), true);
eq('validToken rejects empty/undefined', validToken(undefined), false);

// --- redaction: the token is in the URL, so it can leak through any error text ---
eq('redact removes the token from an error string',
  redact(`request to https://api.telegram.org/bot${TOKEN}/getMe failed`, TOKEN),
  'request to https://api.telegram.org/bot[redacted]/getMe failed');
eq('redact removes every occurrence', redact(`${TOKEN} ${TOKEN}`, TOKEN), '[redacted] [redacted]');
eq('redact leaves text alone when there is no secret', redact('plain', ''), 'plain');
eq('redact ignores a too-short "secret" (it would blank out half the message)', redact('a-b', 'a'), 'a-b');
// a proxy quoting the request path back escapes the ":" - the literal form sails straight past
eq('redact removes the percent-encoded token too',
  redact(`GET /bot${encodeURIComponent(TOKEN)}/sendMessage failed`, TOKEN), 'GET /bot[redacted]/sendMessage failed');

// redact() only knows the CONFIGURED token. The other leak path is the user putting a token
// where a chat id or target name belongs, and the error echoing it back verbatim.
eq('scrub removes an unconfigured but token-shaped value', scrub(`unknown target "${TOKEN}"`), 'unknown target "[redacted]"');
eq('scrub removes every token-shaped value in the line', scrub(`${TOKEN} and ${TOKEN}`), '[redacted] and [redacted]');
eq('scrub leaves a chat id alone', scrub('unknown target "-1001234567890"'), 'unknown target "-1001234567890"');
eq('scrub leaves an ordinary name alone', scrub('unknown target "alerts"'), 'unknown target "alerts"');
eq('scrub also catches the percent-encoded form', scrub(`/bot${encodeURIComponent(TOKEN)}/x`), '/bot[redacted]/x');

// validToken trims before checking, so an untrimmed value would validate and then be spliced
// into the URL path WITH the whitespace - a 404 that reads as "your token is bad"
eq('loadConfig trims a token pasted with stray whitespace',
  loadConfig({ TELEGRAM_BOT_TOKEN: `  ${TOKEN}  ` }, {}).token, TOKEN);
eq('loadConfig trims the default chat id too', loadConfig({ TELEGRAM_CHAT_ID: ' 42 ' }, {}).chatId, '42');
eq('loadConfig still returns undefined for an absent value', loadConfig({}, {}).token, undefined);

// --- targets ---
eq('parseTargets name:chat pairs', parseTargets('me:42,alerts:-1001234567890'),
  { me: { chat: '42' }, alerts: { chat: '-1001234567890' } });
eq('parseTargets keeps a forum topic id', parseTargets('build:-1001:42'), { build: { chat: '-1001', thread: '42' } });
eq('parseTargets tolerates spaces, blanks and CR', parseTargets(' me : 42 ,, \r'), { me: { chat: '42' } });
eq('parseTargets drops a nameless or chatless entry', parseTargets(':42,me:,ok:1'), { ok: { chat: '1' } });
eq('parseTargets of garbage is empty, not a crash', parseTargets(',,,'), {});
eq('serializeTargets round-trips', parseTargets(serializeTargets(parseTargets('me:42,build:-1001:7'))),
  { me: { chat: '42' }, build: { chat: '-1001', thread: '7' } });
eq('looksLikeChatId accepts a negative group id', looksLikeChatId('-1001234567890'), true);
eq('looksLikeChatId accepts a @channelusername', looksLikeChatId('@my_channel'), true);
eq('looksLikeChatId rejects a bare word (that is a target name, not an id)', looksLikeChatId('alerts'), false);

// the strict form used to validate input before it is written (parseTargets stays lenient)
eq('VALID_TARGET accepts name:chat', VALID_TARGET.test('alerts:-1001234567890'), true);
eq('VALID_TARGET accepts name:chat:topic', VALID_TARGET.test('build:-1001234567890:42'), true);
eq('VALID_TARGET accepts an @channelusername', VALID_TARGET.test('news:@my_channel'), true);
eq('VALID_TARGET rejects a missing chat id', VALID_TARGET.test('broken'), false);
eq('VALID_TARGET rejects a non-id chat', VALID_TARGET.test('alerts:not-an-id'), false);
eq('VALID_TARGET rejects a non-numeric topic', VALID_TARGET.test('build:-100:general'), false);
eq('VALID_TARGET rejects an extra field (parseTargets would silently ignore it)',
  VALID_TARGET.test('build:-100:42:extra'), false);

eq('normalizeTargets returns the canonical form', normalizeTargets(' ops : -100 , b:-100:7 ').value, 'ops:-100,b:-100:7');
eq('normalizeTargets reports the offending entry', normalizeTargets('ops:-100,broken').error?.includes('"broken"'), true);
eq('normalizeTargets rejects an all-garbage list', normalizeTargets(',,,').error !== undefined, true);
eq('normalizeTargets sets no value when it errors', normalizeTargets('broken').value, undefined);
// last-one-wins in the map would silently discard the first route, and the two entries
// disagreeing is exactly when guessing is wrong
eq('normalizeTargets rejects a duplicate target name',
  normalizeTargets('alerts:-100,alerts:-200').error?.includes('"alerts"'), true);
eq('normalizeTargets allows the same chat under two names (that is a real use case)',
  normalizeTargets('alerts:-100,builds:-100').value, 'alerts:-100,builds:-100');

const CFG = { chatId: '42', targets: 'ops:-100,build:-100:7' };
eq('resolveTarget by name', resolveTarget('ops', CFG), { chat: '-100' });
eq('resolveTarget by name with a topic', resolveTarget('build', CFG), { chat: '-100', thread: '7' });
eq('resolveTarget falls back to the default chat', resolveTarget(null, CFG), { chat: '42' });
eq('resolveTarget accepts a raw id typed in place of a name', resolveTarget('-1009', CFG), { chat: '-1009' });
eq('resolveTarget returns null for an unknown name (so the caller can list the known ones)',
  resolveTarget('nope', CFG), null);
eq('resolveTarget with no default and several targets is ambiguous -> null',
  resolveTarget(null, { targets: 'a:1,b:2' }), null);
eq('resolveTarget with no default and exactly one target picks it',
  resolveTarget(null, { targets: 'a:1' }), { chat: '1' });
eq('resolveTarget with nothing configured -> null', resolveTarget(null, {}), null);
eq('resolveTarget ignores a whitespace-only default chat', resolveTarget(null, { chatId: '  ' }), null);

// --- message shaping ---
eq('escapeHtml escapes the three that break Telegram HTML', escapeHtml('<b>&</b>'), '&lt;b&gt;&amp;&lt;/b&gt;');
eq('escapeHtml escapes & before < (no double-escaping)', escapeHtml('&lt;'), '&amp;lt;');
eq('formatMessage plain body only', formatMessage({ text: 'hi' }), 'hi');
eq('formatMessage title + body', formatMessage({ text: 'hi', title: 'Deploy' }), 'Deploy\n\nhi');
eq('formatMessage level emoji', formatMessage({ text: 'hi', title: 'Deploy', level: 'error' }), `${LEVELS.error} Deploy\n\nhi`);
eq('formatMessage level without a title still marks the line', formatMessage({ text: 'hi', level: 'warn' }), `${LEVELS.warn} hi`);
eq('formatMessage title only', formatMessage({ title: 'Done', level: 'ok' }), `${LEVELS.ok} Done`);
eq('formatMessage bolds and escapes the title in HTML mode',
  formatMessage({ text: 'x', title: 'a<b>', html: true }), '<b>a&lt;b&gt;</b>\n\nx');
eq('formatMessage of nothing is empty (the caller refuses to send it)', formatMessage({}), '');

// --- chunking ---
eq('chunk leaves a short message whole', chunk('hi'), ['hi']);
eq('chunk of empty text yields nothing to send', chunk(''), []);
eq('chunk breaks on a newline rather than mid-word', chunk('aaaa\nbbbb\ncccc', 10), ['aaaa\nbbbb', 'cccc']);
eq('chunk hard-splits a line with no usable break point', chunk('x'.repeat(25), 10),
  ['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
ok('chunk always terminates and respects the limit', (() => {
  const parts = chunk('y'.repeat(20000) + '\n' + 'z\n'.repeat(500), MAX_MESSAGE);
  return parts.length > 1 && parts.every((p) => p.length <= MAX_MESSAGE) && parts.every((p) => p.length > 0);
})());
eq('chunk reassembles losslessly apart from the split newlines',
  chunk('aaaa\nbbbb\ncccc', 10).join('\n'), 'aaaa\nbbbb\ncccc');
eq('chunk of an all-newline blob does not loop forever', chunk('\n'.repeat(30), 10).every((p) => p.length <= 10), true);

// --- update scraping ---
eq('collectChats reads a private message', collectChats([{ message: { chat: { id: 42, type: 'private', first_name: 'Serge' } } }]),
  [{ id: '42', type: 'private', name: 'Serge' }]);
eq('collectChats dedupes across updates',
  collectChats([{ message: { chat: { id: 1, type: 'private' } } }, { message: { chat: { id: 1, type: 'private' } } }]).length, 1);
eq('collectChats finds a group the bot was just ADDED to (no message exists yet)',
  collectChats([{ my_chat_member: { chat: { id: -100, type: 'supergroup', title: 'Ops' } } }]),
  [{ id: '-100', type: 'supergroup', name: 'Ops' }]);
eq('collectChats reads a channel post', collectChats([{ channel_post: { chat: { id: -200, type: 'channel', title: 'News' } } }]).length, 1);
eq('collectChats falls back to @username for a name',
  collectChats([{ message: { chat: { id: 5, type: 'private', username: 'serge' } } }])[0].name, '@serge');
eq('collectChats survives junk', collectChats([null, {}, { message: {} }, 'x', { message: { chat: {} } }]), []);
eq('collectChats survives a non-array', collectChats(undefined), []);

// --- error classification ---
eq('apiKind ok', apiKind(200, { ok: true }), 'ok');
eq('apiKind 401 is a token problem', apiKind(401, { ok: false, error_code: 401, description: 'Unauthorized' }), 'auth');
eq('apiKind 404 is ALSO a token problem (Telegram answers a bad token on the /bot<token>/ path)',
  apiKind(404, { ok: false, error_code: 404, description: 'Not Found' }), 'auth');
eq('apiKind chat not found', apiKind(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }), 'notfound');
// a wrong topic id is the target's fault, not the network's - as a generic badrequest it would
// print UNREACHABLE with no hint
eq('apiKind treats a missing forum topic as target-scoped',
  apiKind(400, { ok: false, error_code: 400, description: 'Bad Request: message thread not found' }), 'notfound');
eq('apiKind other 400 is a bad request, not a missing chat',
  apiKind(400, { ok: false, error_code: 400, description: "Bad Request: can't parse entities" }), 'badrequest');
eq('apiKind 403 blocked', apiKind(403, { ok: false, error_code: 403, description: 'Forbidden: bot was blocked by the user' }), 'blocked');
eq('apiKind 429 rate limit', apiKind(429, { ok: false, error_code: 429, description: 'Too Many Requests' }), 'ratelimit');
eq('apiKind 409 conflict', apiKind(409, { ok: false, error_code: 409, description: 'Conflict: terminated by other getUpdates' }), 'conflict');
eq('apiKind 5xx server', apiKind(502, null), 'server');
eq('apiKind uses the HTTP status when the body is unparseable (an HTML proxy page)', apiKind(401, null), 'auth');

// a bad token must never be reported as a bad CHAT, or the user re-hunts a chat id that was fine
eq('targetState maps only a chat-scoped rejection to MISSING', targetState('notfound'), 'MISSING');
eq('targetState blocked', targetState('blocked'), 'BLOCKED');
eq('targetState ok', targetState('ok'), 'OK');
eq('targetState token failure is UNREACHABLE, not MISSING', targetState('auth'), 'UNREACHABLE');
eq('targetState rate limit is UNREACHABLE, not MISSING', targetState('ratelimit'), 'UNREACHABLE');
eq('targetState network failure is UNREACHABLE', targetState('network'), 'UNREACHABLE');

// --- retry_after (Telegram puts it in the BODY, not the header) ---
eq('retryAfterMs from the body', retryAfterMs({ parameters: { retry_after: 7 } }), 7000);
eq('retryAfterMs prefers the body over the header', retryAfterMs({ parameters: { retry_after: 2 } }, '30'), 2000);
eq('retryAfterMs falls back to a Retry-After header', retryAfterMs({}, '3'), 3000);
eq('retryAfterMs default when neither is present', retryAfterMs(null, null), 5000);
eq('retryAfterMs clamps an absurd value', retryAfterMs({ parameters: { retry_after: 999999 } }), 60000);
eq('retryAfterMs ignores garbage', retryAfterMs({ parameters: { retry_after: 'soon' } }, 'later'), 5000);
eq('retryAfterMs ignores a negative value', retryAfterMs({ parameters: { retry_after: -5 } }), 5000);

// --- interval override validation ---
eq('intervalFrom accepts a positive number', intervalFrom('250'), 250);
eq('intervalFrom rejects garbage (NaN would silently disable ALL pacing)', intervalFrom('abc'), DEFAULT_INTERVAL_MS);
eq('intervalFrom rejects zero and negatives', [intervalFrom('0'), intervalFrom('-5')], [DEFAULT_INTERVAL_MS, DEFAULT_INTERVAL_MS]);
eq('intervalFrom rejects undefined', intervalFrom(undefined), DEFAULT_INTERVAL_MS);

// --- send arg parsing ---
eq('parseSendArgs bare positional is the message', parseSendArgs(['hello']).text, 'hello');
eq('parseSendArgs flags', parseSendArgs(['--to', 'ops', '--title', 'T', '--level', 'warn', '--html', '--silent']),
  { to: 'ops', title: 'T', level: 'warn', thread: null, text: null, html: true, silent: true, dryRun: false });
eq('parseSendArgs --dry-run', parseSendArgs(['--dry-run']).dryRun, true);
// consuming the next token blind would title the message "--html" and silently drop HTML mode
throws('parseSendArgs refuses a flag as a flag value', () => parseSendArgs(['--title', '--html']));
throws('parseSendArgs refuses a trailing flag with no value', () => parseSendArgs(['--to']));
eq('parseSendArgs still accepts a value that merely starts with dashes',
  parseSendArgs(['--title', '-- build --']).title, '-- build --');
throws('parseSendArgs rejects an unknown option', () => parseSendArgs(['--colour', 'red']));
// a blanket startsWith('-') check would reject these ordinary messages as unknown flags
eq('parseSendArgs accepts a message starting with a dash', parseSendArgs(['- deploy failed']).text, '- deploy failed');
eq('parseSendArgs accepts a message starting with a negative number', parseSendArgs(['-5 degrees']).text, '-5 degrees');
throws('parseSendArgs still rejects a single-dash option', () => parseSendArgs(['-v']));
throws('parseSendArgs rejects a typo in --level (a dropped emoji is invisible)', () => parseSendArgs(['--level', 'critical']));
throws('parseSendArgs rejects a second bare positional', () => parseSendArgs(['a', 'b']));
eq('parseSendArgs keeps a numeric --thread', parseSendArgs(['--thread', '42']).thread, '42');
// unvalidated, this reaches the payload as NaN and returns an opaque Bad Request
throws('parseSendArgs rejects a non-numeric --thread', () => parseSendArgs(['--thread', 'general']));
eq('parseSendArgs accepts every documented level',
  Object.keys(LEVELS).map((l) => parseSendArgs(['--level', l]).level), Object.keys(LEVELS));

eq('parseDoctorArgs flags', parseDoctorArgs(['--json', '--send']), { json: true, send: true });
eq('parseDoctorArgs defaults', parseDoctorArgs([]), { json: false, send: false });
throws('parseDoctorArgs rejects an unknown option', () => parseDoctorArgs(['--all']));

// --- payload ---
eq('sendPayload minimal', sendPayload({ chat: '42' }, 'hi'), { chat_id: '42', text: 'hi' });
eq('sendPayload forum topic becomes message_thread_id as a NUMBER (a string is rejected by the API)',
  sendPayload({ chat: '-100', thread: '7' }, 'hi').message_thread_id, 7);
eq('sendPayload html', sendPayload({ chat: '1' }, 'x', { html: true }).parse_mode, 'HTML');
eq('sendPayload silent', sendPayload({ chat: '1' }, 'x', { silent: true }).disable_notification, true);
eq('sendPayload omits parse_mode by default (arbitrary text must never fail to parse)',
  Object.hasOwn(sendPayload({ chat: '1' }, '<not html>'), 'parse_mode'), false);

// --- request loop, against a stubbed fetch ---
const realFetch = globalThis.fetch;
const stub = (fn) => { globalThis.fetch = fn; };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const CFG_API = { apiBase: DEFAULT_API_BASE, token: TOKEN };

let seen = [];
stub(async (url, init) => { seen.push({ url, body: JSON.parse(init.body) }); return json(200, { ok: true, result: { username: 'bot' } }); });
let r = await call('getMe', {}, CFG_API);
eq('call returns the unwrapped result', r.result.username, 'bot');
eq('call POSTs to the method path', seen[0].url, `${DEFAULT_API_BASE}/bot${TOKEN}/getMe`);

stub(async () => json(400, { ok: false, error_code: 400, description: 'Bad Request: chat not found' }));
r = await call('sendMessage', { chat_id: 'x' }, CFG_API);
eq('call classifies a missing chat', [r.ok, r.kind], [false, 'notfound']);

// the token is in the URL, so an API error that echoes the request must not print it back
stub(async () => json(401, { ok: false, error_code: 401, description: `Unauthorized for bot${TOKEN}` }));
r = await call('getMe', {}, CFG_API);
eq('call redacts the token out of a description', r.description.includes(TOKEN), false);
eq('call classifies a rejected token', r.kind, 'auth');

let calls = 0;
stub(async () => (++calls === 1
  ? json(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 0 } })
  : json(200, { ok: true, result: 'sent' })));
r = await call('sendMessage', {}, CFG_API, { timeoutMs: 5000 });
eq('call retries a 429 honouring retry_after and then succeeds', [r.ok, calls], [true, 2]);

calls = 0;
stub(async () => { calls++; return json(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 30 } }); });
r = await call('sendMessage', {}, CFG_API, { timeoutMs: 200 });
eq('call reports the rate limit instead of sleeping past its own budget', [r.ok, r.kind, calls], [false, 'ratelimit', 1]);

stub(async () => { const e = new Error('fetch failed'); e.name = 'TypeError'; e.cause = { code: 'ENOTFOUND' }; throw e; });
r = await call('getMe', {}, CFG_API);
eq('call reports the underlying errno, not the DOMException number', [r.kind, r.description], ['network', 'network: ENOTFOUND']);

stub(async () => { const e = new Error('t'); e.name = 'TimeoutError'; throw e; });
r = await call('getMe', {}, CFG_API);
eq('call classifies a timeout', r.kind, 'timeout');

stub(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }));
r = await call('getMe', {}, CFG_API);
eq('call survives a non-JSON body from a proxy', [r.ok, r.kind], [false, 'server']);

stub(async () => json(400, { ok: false, error_code: 400, description: 'Bad Request: group chat was upgraded to a supergroup chat', parameters: { migrate_to_chat_id: -1009 } }));
r = await call('sendMessage', {}, CFG_API);
eq('call surfaces the new id when a group is promoted to a supergroup', r.migrate, -1009);

// pacing: consecutive PACED sends are spaced by at least one interval, so chunking a long
// message cannot trip Telegram's ~1 msg/sec per-chat limit. Tolerance is one OS timer tick
// (~16ms on Windows), not a percentage of the interval.
stub(async () => json(200, { ok: true, result: 1 }));
const t0 = Date.now();
await call('sendMessage', {}, CFG_API, { pace: true });
await call('sendMessage', {}, CFG_API, { pace: true });
ok(`paced sends are spaced by >= MIN_INTERVAL_MS (${MIN_INTERVAL_MS}ms)`, Date.now() - t0 >= MIN_INTERVAL_MS - 16);

const t1 = Date.now();
await call('getMe', {}, CFG_API);
await call('getMe', {}, CFG_API);
ok('reads are NOT paced (only message sends are rate-limited per chat)', Date.now() - t1 < MIN_INTERVAL_MS);

globalThis.fetch = realFetch;

// --- config mutation, end to end through the real CLI ---
// `targets add/rm` is the only code that REWRITES the saved config, so a bug here costs someone
// their token or their routes. Driven as a subprocess against a throwaway config file: the module
// resolves CONFIG_PATH once at load, so an in-process test could not point it anywhere safe.
const { execFileSync } = await import('node:child_process');
const { mkdtempSync, readFileSync: read, writeFileSync: write, rmSync, existsSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const dir = mkdtempSync(join(tmpdir(), 'tg-test-'));
const envFile = join(dir, 'env');
const { fileURLToPath } = await import('node:url'); // not URL.pathname: that yields /C:/... on Windows
const script = fileURLToPath(new URL('./tg.mjs', import.meta.url));
const tgEnv = (extra = {}) => ({
  ...process.env, TELEGRAM_NOTIFY_ENV: envFile,
  TELEGRAM_BOT_TOKEN: '', TELEGRAM_CHAT_ID: '', TELEGRAM_TARGETS: '', ...extra,
});
const tg = (...args) => execFileSync(process.execPath, [script, ...args], {
  env: tgEnv(),
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'], // capture stderr too - the deliberate failures below are not test noise
});
// same, but with live TELEGRAM_* set - the case where env-merging on write would corrupt the file
const tgWithEnv = (extra, ...args) => execFileSync(process.execPath, [script, ...args], {
  env: tgEnv(extra), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
});
const fails = (name, ...args) => { assert.throws(() => tg(...args), name); n++; };

try {
  write(envFile, `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_CHAT_ID=42\n`);
  tg('targets', 'add', 'alerts', '-1001234567890');
  tg('targets', 'add', 'builds', '-1001234567890', '7');
  eq('targets add appends without disturbing the others',
    parseEnvFile(read(envFile, 'utf8')).TELEGRAM_TARGETS, 'alerts:-1001234567890,builds:-1001234567890:7');
  eq('targets add preserves the token', parseEnvFile(read(envFile, 'utf8')).TELEGRAM_BOT_TOKEN, TOKEN);
  eq('targets add preserves the default chat', parseEnvFile(read(envFile, 'utf8')).TELEGRAM_CHAT_ID, '42');
  eq('targets lists the default and both routes', tg('targets').trim().split(/\r?\n/).length, 3);

  tg('targets', 'rm', 'alerts');
  eq('targets rm removes only the named one', parseEnvFile(read(envFile, 'utf8')).TELEGRAM_TARGETS, 'builds:-1001234567890:7');
  tg('targets', 'rm', 'builds');
  // mergeConfig ignores blank values to protect the token, so clearing the LAST target needs an
  // explicit delete - without it, removing it would look like it worked and change nothing
  eq('removing the last target actually clears the key',
    Object.hasOwn(parseEnvFile(read(envFile, 'utf8')), 'TELEGRAM_TARGETS'), false);
  eq('the token survives clearing every target', parseEnvFile(read(envFile, 'utf8')).TELEGRAM_BOT_TOKEN, TOKEN);
  ok('a .bak of the previous config is kept', existsSync(envFile + '.bak'));

  // `save` takes the non-secret values as FLAGS so one line works in bash and PowerShell alike
  // (`VAR=value cmd` is a parse error in PowerShell). The token stays environment-only.
  tg('save', '--chat', '777', '--targets', 'ops:-100');
  eq('save --chat writes the default chat', parseEnvFile(read(envFile, 'utf8')).TELEGRAM_CHAT_ID, '777');
  eq('save --targets writes the routes', parseEnvFile(read(envFile, 'utf8')).TELEGRAM_TARGETS, 'ops:-100');
  eq('save leaves the token alone', parseEnvFile(read(envFile, 'utf8')).TELEGRAM_BOT_TOKEN, TOKEN);
  tg('save', '--targets', '');
  eq('save with an empty value clears that setting', Object.hasOwn(parseEnvFile(read(envFile, 'utf8')), 'TELEGRAM_TARGETS'), false);
  eq('save without a flag leaves the other settings untouched',
    (tg('save'), parseEnvFile(read(envFile, 'utf8')).TELEGRAM_CHAT_ID), '777');
  fails('save rejects a --chat that is not a chat id', 'save', '--chat', 'my-group');
  // written verbatim, an unparseable list reads back as ZERO targets: a config that looks set
  // but routes nowhere
  fails('save rejects an unparseable --targets list', 'save', '--targets', 'ops--100');
  fails('save rejects a --targets entry whose chat is not an id', 'save', '--targets', 'ops:my-group');
  fails('save rejects a duplicate target name rather than dropping a route', 'save', '--targets', 'ops:-100,ops:-200');
  // Validating only the FLAGS let the same garbage in through the ENVIRONMENT, which `save` also
  // writes to disk - success reported, config silently routing nowhere.
  const envSaveFails = (name, extra) => {
    assert.throws(() => tgWithEnv(extra, 'save'), name);
    n++;
  };
  envSaveFails('save rejects a malformed TELEGRAM_TARGETS from the live environment', { TELEGRAM_TARGETS: 'ops--100' });
  envSaveFails('save rejects a non-id TELEGRAM_CHAT_ID from the live environment', { TELEGRAM_CHAT_ID: 'my-group' });
  eq('the rejected env value never reached the file',
    parseEnvFile(read(envFile, 'utf8')).TELEGRAM_CHAT_ID, '777');
  // pre-existing junk in a hand-edited file must not block an unrelated write
  write(envFile, `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_TARGETS=already-broken\n`);
  eq('a save that does not touch the broken value still succeeds',
    (tg('save', '--chat', '555'), parseEnvFile(read(envFile, 'utf8')).TELEGRAM_CHAT_ID), '555');
  write(envFile, `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_CHAT_ID=777\n`);
  eq('save normalizes a valid --targets list',
    (tg('save', '--targets', ' ops : -100 , build:-100:7 '), parseEnvFile(read(envFile, 'utf8')).TELEGRAM_TARGETS),
    'ops:-100,build:-100:7');
  fails('save rejects a flag with no value', 'save', '--chat');
  fails('save rejects an unknown flag', 'save', '--token', 'x'); // the token is env-only, by design

  // A `targets` edit must touch ONLY the target list in the saved file. If it merged the live
  // environment on write, a throwaway `TELEGRAM_BOT_TOKEN=...` in the shell would be baked onto
  // disk, replacing the real saved token - and a temporary TELEGRAM_TARGETS would erase the
  // file's own routes. The command reports "targets: ..." either way, so the damage is silent.
  write(envFile, `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_CHAT_ID=42\nTELEGRAM_TARGETS=keepme:-100\n`);
  const OTHER = '987654321:BBSomeOtherTokenEntirely_9876543210zz';
  tgWithEnv({ TELEGRAM_BOT_TOKEN: OTHER, TELEGRAM_CHAT_ID: '999', TELEGRAM_TARGETS: 'ephemeral:-1' },
    'targets', 'add', 'alerts', '-1002');
  const after = parseEnvFile(read(envFile, 'utf8'));
  eq('a targets edit does not write a live env token over the saved one', after.TELEGRAM_BOT_TOKEN, TOKEN);
  eq('a targets edit does not write a live env default chat to disk', after.TELEGRAM_CHAT_ID, '42');
  eq('a targets edit extends the SAVED routes, not the env-supplied ones', after.TELEGRAM_TARGETS, 'keepme:-100,alerts:-1002');

  // a targets edit writes back the PARSED map, so an unreadable entry in the file disappears -
  // silently, unless it is called out
  write(envFile, `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_TARGETS=good:-100,unreadable\n`);
  ok('a targets edit warns before dropping an unreadable saved entry', (() => {
    const r = execFileSync(process.execPath, [script, 'targets', 'add', 'new', '-200'], {
      env: tgEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
    });
    return r.includes('good:-100,new:-200');
  })());

  write(envFile, `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_CHAT_ID=42\n`);
  fails('targets add rejects a non-id (a typo would create a target that can never deliver)',
    'targets', 'add', 'oops', 'not-an-id');
  // silently ignoring a trailing operand makes `targets rm a b` look like it removed both
  tg('targets', 'add', 'one', '-100');
  fails('targets add rejects extra operands', 'targets', 'add', 'n', '-100', '42', 'extra');
  fails('targets rm rejects extra operands', 'targets', 'rm', 'one', 'two');
  // a token pasted where a chat id or name belongs must not come back in the error text
  ok('a token pasted as a chat id is scrubbed from the error', (() => {
    try { tg('targets', 'add', 'oops', TOKEN); return false; }
    catch (e) { return !`${e.stdout}${e.stderr}`.includes(TOKEN); }
  })());
  ok('a token pasted as a target name is scrubbed from the error', (() => {
    try { tg('send', '--to', TOKEN, 'hi'); return false; }
    catch (e) { return !`${e.stdout}${e.stderr}`.includes(TOKEN); }
  })());
  fails('targets add rejects a name containing the field separator', 'targets', 'add', 'a:b', '42');
  fails('targets rm of an unknown name is an error, not a silent no-op', 'targets', 'rm', 'ghost');
  fails('an unknown subcommand exits non-zero', 'nonsense');
  fails('a prototype method is not a subcommand', 'toString');
  eq('the config summary never prints the token', tg('config').includes(TOKEN), false);
  // a hand-edited file can put a token anywhere; printing the config is when that surfaces
  write(envFile, `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_CHAT_ID=${TOKEN}\n`);
  eq('a token sitting in the chat-id slot is scrubbed from the config summary',
    tg('config').includes(TOKEN), false);
  eq('config still reports that a default is configured', tg('config').includes('[redacted]'), true);
  write(envFile, `TELEGRAM_BOT_TOKEN=${TOKEN}\nTELEGRAM_CHAT_ID=42\n`);
  ok('the config summary names the config file', tg('config').includes(envFile));
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log(`telegram-notify self-check: ${n} checks passed`);
