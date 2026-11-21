#!/usr/bin/env node
// 离线单测：lib/credentials.mjs（凭据库 + 登录通道）
// 全部请求都打在本机 mock server 上，绝不访问真实网关。
//
// 注：2026-11-21 起自管换发（token-refresh）实现已整体移除——服务端只认官方桌面
// 客户端，第三方进程一律 40115。相关单测随之删除，理由见 docs/nas-docker.md。
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  extractLoginResult,
  exchangeCodeForToken,
  jwtExpiresAt,
  tokenIat,
  ensureDeviceIdentity,
  loadCredentialStore,
  saveCredentialStore,
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

console.log('== 登录回执解析 ==');
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
await t('jwtExpiresAt：解析 exp，坏 token 返回 null', () => {
  const exp = 1893456000;
  assert.equal(jwtExpiresAt(mkJwt({ exp })), exp * 1000);
  assert.equal(jwtExpiresAt('garbage'), null);
});
await t('tokenIat：解析 iat，坏 token 返回 null', () => {
  const tok = mkJwt({ iat: 1700000000, exp: 1700604800 });
  assert.equal(tokenIat(tok), 1700000000 * 1000);
  assert.equal(tokenIat('not-a-jwt'), null);
});

console.log('== 回执换 token（本机 mock）==');
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/cowork/auth') {
    // 只有回执里带 code 且请求像桌面端时才给 token（模拟服务端逐跳签发）
    const code = u.searchParams.get('code');
    const isDesktop = String(req.headers['user-agent'] || '').includes('TeleAgent/');
    if (code && isDesktop) {
      res.writeHead(302, { location: `/cowork/auth?code=${code}&token=tok-from-redirect` });
      res.end();
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<html>请打开桌面客户端</html>');
    return;
  }
  res.writeHead(404).end('no route');
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const mockBase = `http://127.0.0.1:${server.address().port}`;

await t('exchangeCodeForToken：回执已带 token 时直接返回（不发请求）', async () => {
  const r = await exchangeCodeForToken(`${mockBase}/cowork/auth?code=C1&token=tok-in-url`);
  assert.equal(r.ok, true);
  assert.equal(r.via, 'url');
  assert.equal(r.token, 'tok-in-url');
});
await t('exchangeCodeForToken：只有 code 时按桌面端身份逐跳取到 token', async () => {
  const r = await exchangeCodeForToken(`${mockBase}/cowork/auth?code=C2`, { appVersion: '3.1.1.000' });
  assert.equal(r.ok, true, r.reason || '');
  assert.equal(r.via, 'redirect');
  assert.equal(r.token, 'tok-from-redirect');
});
await t('exchangeCodeForToken：非回执 URL 直接拒绝', async () => {
  const r = await exchangeCodeForToken(`${mockBase}/other`);
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'not-cowork-auth-redirect');
});
server.close();

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
  saveCredentialStore(dir, { cookies: { operationToken: 'Em9xR4:tok' } });
  const s = loadCredentialStore(dir);
  assert.equal(s.token, 'a');
  assert.equal(s.generation, 1);
  assert.equal(s.cookies.operationToken, 'Em9xR4:tok', '后写入的字段不应覆盖已有字段');
});

console.log(`\n通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过'}`);
if (failures.length) {
  for (const [name, err] of failures) console.error(`\nFAIL ${name}\n${err.stack}`);
  process.exit(1);
}
