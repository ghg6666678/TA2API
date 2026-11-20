#!/usr/bin/env node
// 离线单测：lib/credentials.mjs
// 全部请求都打在本机 mock server 上，绝不访问真实网关。
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  refreshHeaders,
  cookieToHeader,
  parseSetCookies,
  classifyRefresh,
  parseRefreshResponse,
  extractLoginResult,
  osTypeFor,
  jwtExpiresAt,
  ensureDeviceIdentity,
  loadCredentialStore,
  saveCredentialStore,
  refreshToken,
  startRenewalLoop,
  detectRenewalMode,
  tokenIat,
  DEFAULT_AUTH_BASE,
} from '../lib/credentials.mjs';

let passed = 0;
const failures = [];
async function t(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures.push([name, err]);
    console.error(`  FAIL ${name}: ${err.message}`);
  }
}
const b64url = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
const mkJwt = (payload) => `${b64url({ alg: 'none' })}.${b64url(payload)}.sig`;

console.log('== 纯函数 ==');
await t('osTypeFor 映射与桌面端 snt 一致', () => {
  assert.equal(osTypeFor('win32'), 'Windows');
  assert.equal(osTypeFor('darwin'), 'macOS');
  assert.equal(osTypeFor('linux'), 'linux');
});
await t('refreshHeaders 字段齐全且取值正确', () => {
  const h = refreshHeaders({ token: 'T', deviceId: 'dev', appVersion: '9.9.9', osType: 'Linux', now: 1700000000000, nonce: 'n-1' });
  assert.equal(h['X-Token'], 'T');
  assert.equal(h['X-Timestamp'], '1700000000');
  assert.equal(h['X-Nonce'], 'n-1');
  assert.equal(h['X-App-Version'], '9.9.9');
  assert.equal(h['X-OS-Type'], 'Linux');
  assert.equal(h['X-SuperAgent-Device-Id'], 'dev');
  assert.equal(h['Content-Type'], 'application/json');
  assert.equal(h['Cookie'], undefined, '无 Cookie 时不加头');
});
await t('refreshHeaders/cookieToHeader：Cookie 对 → 头，空值跳过', () => {
  const h = refreshHeaders({ token: 'T', deviceId: 'd', cookie: { operToken: 'a', operationToken: 'b' } });
  assert.equal(h['Cookie'], 'operToken=a; operationToken=b');
  assert.equal(cookieToHeader({ operToken: 'a' }), 'operToken=a');
  assert.equal(cookieToHeader({}), '');
  assert.equal(cookieToHeader(null), '');
  const h2 = refreshHeaders({ token: 'T', deviceId: 'd', cookie: 'operToken=x' });
  assert.equal(h2['Cookie'], 'operToken=x', '字符串 Cookie 原样进头');
});
await t('parseSetCookies：提取 operToken/operationToken，忽略其他', () => {
  const out = parseSetCookies([
    'operToken=new-op; Path=/; Domain=.teleai.com.cn; Secure',
    'operationToken=Em9xR4%3Anew-tok; Path=/; Domain=.teleai.com.cn; Secure',
    'other=x; Path=/',
  ]);
  assert.deepEqual(out, { operToken: 'new-op', operationToken: 'Em9xR4%3Anew-tok' });
  assert.equal(parseSetCookies(['a=b']), null);
  assert.equal(parseSetCookies([]), null);
  assert.equal(parseSetCookies(undefined), null);
});
await t('classifyRefresh：五个终态业务码', () => {
  for (const code of [40112, 40113, 40114, 40115, 40116]) {
    const c = classifyRefresh(200, code);
    assert.equal(c.terminal, true, `code ${code} 应为终态`);
    assert.equal(c.retryable, false);
  }
  assert.equal(classifyRefresh(200, 40116).category, 'session_absolute_expired');
});
await t('classifyRefresh：50005/5xx 可重试、401 终态、403/404 特判', () => {
  assert.equal(classifyRefresh(200, 50005).retryable, true);
  assert.equal(classifyRefresh(503, null).retryable, true);
  assert.equal(classifyRefresh(401, null).terminal, true);
  assert.equal(classifyRefresh(403, null).terminal, false);
  assert.equal(classifyRefresh(404, null).category, 'unsupported');
  assert.equal(classifyRefresh(null, null).category, 'network_error');
});
await t('parseRefreshResponse：data 层 accessToken / 秒→毫秒 abs / 过去时间丢弃', () => {
  const now = Date.now();
  const r1 = parseRefreshResponse(JSON.stringify({ code: 0, data: { accessToken: ' t2 ', expiresIn: 604799, absoluteExpiresAt: Math.floor(now / 1000 + 86400) } }));
  assert.equal(r1.ok, true);
  assert.equal(r1.accessToken, 't2');
  assert.equal(r1.expiresIn, 604799);
  assert.ok(r1.absoluteExpiresAt > now);
  const r2 = parseRefreshResponse(JSON.stringify({ data: { accessToken: 'x', expiresIn: 10, absoluteExpiresAt: 1 } }));
  assert.equal(r2.absoluteExpiresAt, null, '过去的绝对期限应记 null');
  const r3 = parseRefreshResponse('不是 JSON');
  assert.equal(r3.ok, false);
  const r4 = parseRefreshResponse(JSON.stringify({ code: 40116 }));
  assert.equal(r4.ok, false);
  assert.equal(r4.code, 40116);
});
await t('extractLoginResult：cowork/auth 回跳 + code/token 提取', () => {
  const good = extractLoginResult('https://x.example.com/superCowork/sapi/cowork/auth?code=C1&token=T1');
  assert.equal(good.ok, true);
  assert.equal(good.token, 'T1');
  assert.equal(good.code, 'C1');
  const codeOnly = extractLoginResult('https://x.example.com/cowork/auth?code=C2');
  assert.equal(codeOnly.ok, true);
  assert.equal(codeOnly.token, null);
  assert.equal(extractLoginResult('https://x.example.com/other').ok, false);
  assert.equal(extractLoginResult('not a url').ok, false);
});
await t('jwtExpiresAt 解析 exp', () => {
  const exp = Math.floor(1893456000);
  assert.equal(jwtExpiresAt(mkJwt({ exp })), exp * 1000);
  assert.equal(jwtExpiresAt('garbage'), null);
});
await t('DEFAULT_AUTH_BASE 与官方上游同域', () => {
  assert.ok(DEFAULT_AUTH_BASE.startsWith('https://'));
  assert.ok(DEFAULT_AUTH_BASE.includes('/superCowork/sapi'));
});

console.log('== 存储层 ==');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-cred-test-'));
await t('ensureDeviceIdentity：优先桌面端 device-meta，落盘复用', () => {
  const id1 = ensureDeviceIdentity(dir, { deviceId: 'e8b0c51f3439', installId: 'iid-1' });
  assert.equal(id1.deviceId, 'e8b0c51f3439');
  assert.equal(id1.source, 'desktop');
  const id2 = ensureDeviceIdentity(dir, {});
  assert.equal(id2.deviceId, 'e8b0c51f3439', '第二次应读取已落盘身份');
});
await t('ensureDeviceIdentity：无 fallback 时生成 12hex + UUID 并持久化', () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-cred-test2-'));
  const id = ensureDeviceIdentity(dir2, {});
  assert.match(id.deviceId, /^[0-9a-f]{12}$/);
  assert.match(id.installId, /^[0-9a-f-]{36}$/);
  assert.equal(ensureDeviceIdentity(dir2, {}).deviceId, id.deviceId);
});
await t('save/load store 原子合并写', () => {
  saveCredentialStore(dir, { token: 'a', generation: 1 });
  saveCredentialStore(dir, { lastAttemptDay: '2026-11-20' });
  const s = loadCredentialStore(dir);
  assert.equal(s.token, 'a');
  assert.equal(s.generation, 1);
  assert.equal(s.lastAttemptDay, '2026-11-20');
});

console.log('== refreshToken（本机 mock 网关）==');
let mode = 'success';
let lastReq = null;
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    lastReq = { url: req.url, method: req.method, headers: req.headers, body: Buffer.concat(chunks).toString('utf8') };
    res.setHeader('content-type', 'application/json');
    if (mode === 'success') {
      res.setHeader('set-cookie', ['operToken=op-next; Path=/; Domain=.teleai.com.cn', 'operationToken=Em9xR4%3Atok-next; Path=/; Domain=.teleai.com.cn']);
      res.end(JSON.stringify({ code: 0, data: { accessToken: 'tok-new', expiresIn: 604799, absoluteExpiresAt: Math.floor(Date.now() / 1000 + 90 * 86400) } }));
    } else if (mode === 'unauthorized') {
      res.statusCode = 401;
      res.end(JSON.stringify({ code: 40001, message: 'unauthorized' }));
    } else if (mode === 'absolute-expired') {
      res.statusCode = 200;
      res.end(JSON.stringify({ code: 40116 }));
    } else if (mode === 'busy') {
      res.statusCode = 200;
      res.end(JSON.stringify({ code: 50005 }));
    } else if (mode === 'unsupported') {
      res.statusCode = 404;
      res.end('no route');
    } else if (mode === 'hang') {
      // 不响应，让超时触发
    } else {
      res.statusCode = 500;
      res.end('{}');
    }
  });
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const mockBase = `http://127.0.0.1:${server.address().port}`;
const baseArgs = { token: 'tok-old', deviceId: 'dev1', authBase: mockBase, appVersion: '3.1.1.000', osType: 'linux' };

await t('成功换发：POST 空 body + 全套头 + 结果字段', async () => {
  const r = await refreshToken({ ...baseArgs, cookie: { operToken: 'op-old', operationToken: 'Em9xR4%3Atok-old' } });
  assert.equal(r.status, 'succeeded');
  assert.equal(r.token, 'tok-new');
  assert.equal(r.expiresIn, 604799);
  assert.ok(r.absoluteExpiresAt > Date.now());
  assert.equal(lastReq.method, 'POST');
  assert.equal(lastReq.url, '/cowork/auth/token-refresh');
  assert.equal(lastReq.body, '');
  assert.equal(lastReq.headers['x-token'], 'tok-old');
  assert.equal(lastReq.headers['x-superagent-device-id'], 'dev1');
  assert.match(lastReq.headers['x-timestamp'], /^\d{10}$/);
  assert.equal(lastReq.headers['cookie'], 'operToken=op-old; operationToken=Em9xR4%3Atok-old', '换发必须携带平台 Cookie 对（40115 根因修复）');
  assert.ok(Array.isArray(r.setCookies) && r.setCookies.length === 2, '结果应携带响应 Set-Cookie（自持下一代的原料）');
});
await t('401 → unauthorized 终态', async () => {
  mode = 'unauthorized';
  const r = await refreshToken(baseArgs);
  assert.equal(r.status, 'failed');
  assert.equal(r.category, 'unauthorized');
  assert.equal(r.terminal, true);
});
await t('2xx + 业务码 40116 → 终态 session_absolute_expired', async () => {
  mode = 'absolute-expired';
  const r = await refreshToken(baseArgs);
  assert.equal(r.status, 'failed');
  assert.equal(r.category, 'session_absolute_expired');
  assert.equal(r.terminal, true);
});
await t('业务码 50005 → 可重试', async () => {
  mode = 'busy';
  const r = await refreshToken(baseArgs);
  assert.equal(r.status, 'failed');
  assert.equal(r.retryable, true);
  assert.equal(r.terminal, false);
});
await t('404 → unsupported', async () => {
  mode = 'unsupported';
  const r = await refreshToken(baseArgs);
  assert.equal(r.status, 'unsupported');
});
await t('超时 → timed_out 可重试', async () => {
  mode = 'hang';
  const r = await refreshToken({ ...baseArgs, timeoutMs: 300 });
  assert.equal(r.category, 'timed_out');
  assert.equal(r.retryable, true);
  mode = 'success';
});

console.log('== 续期循环 ==');
const loopDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-cred-loop-'));
let renewed = null;
let needLogin = null;
const loop = startRenewalLoop({
  runtimeRoot: loopDir,
  getToken: () => loadCredentialStore(loopDir)?.token ?? '',
  getCookies: async () => ({ operToken: 'op-loop', operationToken: 'Em9xR4%3Atok-loop' }),
  deviceId: 'dev1',
  authBase: mockBase,
  intervalMs: 3_600_000,
  startupDelayMs: 600_000,
  onRenewed: (r) => { renewed = r; },
  onNeedLogin: (r) => { needLogin = r; },
  fetchImpl: globalThis.fetch,
});
await t('tick：首次换发成功 → 落库 + onRenewed + Cookie 回写', async () => {
  saveCredentialStore(loopDir, { token: 'tok-old', generation: 0 });
  const r = await loop.tick();
  assert.equal(r.ok, true);
  assert.equal(renewed.token, 'tok-new');
  assert.equal(renewed.generation, 1);
  const s = loadCredentialStore(loopDir);
  assert.equal(s.token, 'tok-new');
  assert.equal(s.generation, 1);
  assert.ok(s.lastAttemptDay);
  // 换发请求带了 getCookies 提供的 Cookie 对
  assert.equal(lastReq.headers['cookie'], 'operToken=op-loop; operationToken=Em9xR4%3Atok-loop');
  // 响应 Set-Cookie 解析后落库自持
  assert.equal(s.cookies?.operToken, 'op-next');
  assert.equal(s.cookies?.operationToken, 'Em9xR4%3Atok-next');
});
await t('tick：同一自然日去重（force 除外）', async () => {
  const r = await loop.tick();
  assert.equal(r.status, 'skipped');
  assert.equal(r.reason, 'already-attempted-today');
  const r2 = await loop.tick(true);
  assert.equal(r2.ok, true, 'force 应绕过去重');
});
await t('tick：终态失败 → onNeedLogin 且保留 day 标记', async () => {
  mode = 'absolute-expired';
  const r = await loop.tick(true);
  assert.equal(r.ok, false);
  assert.equal(r.terminal, true);
  assert.match(needLogin, /重新登录/);
  const s = loadCredentialStore(loopDir);
  assert.ok(s.lastAttemptDay, '终态失败仍保留当日标记');
  mode = 'success';
});
await t('tick：无 token → skipped + onNeedLogin', async () => {
  const loop2 = startRenewalLoop({
    runtimeRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'ta-cred-loop2-')),
    getToken: () => '',
    deviceId: 'dev1',
    authBase: mockBase,
    startupDelayMs: 600_000,
    fetchImpl: globalThis.fetch,
  });
  let nl = null;
  const r = await loop2.tick();
  assert.equal(r.status, 'skipped');
  assert.equal(r.reason, 'no-token');
  loop2.stop();
});
await t('TA_RENEW_INTERVAL_MS=0 → 循环禁用（不建定时器，仅手动 tick）', () => {
  process.env.TA_RENEW_INTERVAL_MS = '0';
  const d3 = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-cred-loop3-'));
  const l3 = startRenewalLoop({
    runtimeRoot: d3,
    getToken: () => '',
    deviceId: 'dev1',
    authBase: mockBase,
    fetchImpl: globalThis.fetch,
  });
  assert.equal(l3.status().disabled, true);
  assert.equal(l3.status().intervalMs, 0);
  l3.stop();
  delete process.env.TA_RENEW_INTERVAL_MS;
});
await t('detectRenewalMode：无 Local State → nas（自动）', () => {
  const m = detectRenewalMode({ deviceDataRoot: '/nonexistent-ta-root', env: {} });
  assert.equal(m.mode, 'nas');
  assert.equal(m.explicit, false);
});
await t('detectRenewalMode：有 Local State → gui-companion（自动）', () => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-mode-'));
  fs.writeFileSync(path.join(d, 'Local State'), '{}');
  const m = detectRenewalMode({ deviceDataRoot: d, env: {} });
  assert.equal(m.mode, 'gui-companion');
  assert.equal(m.explicit, false);
});
await t('detectRenewalMode：TA_RENEW_MODE 显式覆盖检测', () => {
  assert.equal(detectRenewalMode({ deviceDataRoot: '/nonexistent', env: { TA_RENEW_MODE: 'nas' } }).mode, 'nas');
  assert.equal(detectRenewalMode({ deviceDataRoot: '/nonexistent', env: { TA_RENEW_MODE: 'gui' } }).mode, 'gui-companion');
  assert.equal(detectRenewalMode({ localStateExists: true, env: { TA_RENEW_MODE: 'nas' } }).mode, 'nas');
});
await t('tokenIat：解析 JWT iat，坏 token 返回 null', () => {
  const payload = Buffer.from(JSON.stringify({ iat: 1700000000, exp: 1700604800 })).toString('base64url');
  const tok = `h.${payload}.s`;
  assert.equal(tokenIat(tok), 1700000000 * 1000);
  assert.equal(tokenIat('not-a-jwt'), null);
});
loop.stop();
server.close();

console.log(`\n通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过'}`);
if (failures.length) {
  for (const [name, err] of failures) console.error(`\nFAIL ${name}\n${err.stack}`);
  process.exit(1);
}
