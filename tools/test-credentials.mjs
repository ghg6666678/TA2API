#!/usr/bin/env node
// 离线单测：lib/credentials.mjs（凭据库 + JWT 工具）
//
// 2026-11-21 起换发与「用 Cookie 登录」均已移除：token 只由桌面版签发并刷新，
// 反代读取 token.json 跟随。相关单测随之删除，理由见 docs/nas-docker.md。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
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

console.log('== JWT 工具 ==');
await t('jwtExpiresAt：解析 exp，坏 token 返回 null', () => {
  const exp = 1893456000;
  assert.equal(jwtExpiresAt(mkJwt({ exp })), exp * 1000);
  assert.equal(jwtExpiresAt('garbage'), null);
  assert.equal(jwtExpiresAt(undefined), null);
});
await t('tokenIat：解析 iat，坏 token 返回 null', () => {
  const tok = mkJwt({ iat: 1700000000, exp: 1700604800 });
  assert.equal(tokenIat(tok), 1700000000 * 1000);
  assert.equal(tokenIat('not-a-jwt'), null);
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
  saveCredentialStore(dir, { source: 'dpapi' });
  const s = loadCredentialStore(dir);
  assert.equal(s.token, 'a');
  assert.equal(s.generation, 1);
  assert.equal(s.source, 'dpapi', '后写入的字段不应覆盖已有字段');
});
await t('load store：文件不存在返回 null', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-cred-test3-'));
  assert.equal(loadCredentialStore(empty), null);
});

console.log(`\n通过 ${passed} 项${failures.length ? `，失败 ${failures.length} 项` : '，全部通过'}`);
if (failures.length) {
  for (const [name, err] of failures) console.error(`\nFAIL ${name}\n${err.stack}`);
  process.exit(1);
}
