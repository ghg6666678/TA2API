#!/usr/bin/env node
// 在 Windows PC 上跑一次（可选迁移路径 B）：把桌面端登录态导出为 TA2API
// 自管凭据库格式（lib/credentials.mjs 的 store.json / device.json）。
//
// 用法: node docker/export-credentials.mjs [输出目录]   默认 ./ta-export
// 产物（拷到 NAS 的 /app/runtime/credentials/ 下即可被优先采用）：
//   store.json   { token, tokenIssuedAt, tokenExpiresAt, generation, source:'pc-export' }
//   device.json  { deviceId, installId }   —— 与 PC 端同一设备身份，保持 token+device 配对一致
//   export-meta.json  导出时间/剩余天数等元信息
//
// 注意：store.json 里的 token 是明文凭据，等同账号本身。只放 NAS 私有目录、
// 权限 600、不进 git、不外传。
//
// 主要路径其实是「NAS 管理台登录」（见 docker/DEPLOY-GUIDE.md 第 2 节）——
// 本脚本是给不想在 NAS 上做首次登录、或需要离线迁移的人准备的。
//
// 解密链路与 lib/auth.mjs 完全同构：
//   - 主密钥来自 Local State 的 os_crypt.encrypted_key（DPAPI, CurrentUser）
//   - token.json 的 encryptedToken 是 v10 = "v10" + nonce(12) + ct + tag(16)
//   - round-trip 解出 JWT 并检查 exp，确保导出的不是过期态
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import os from 'node:os';

const DATA = path.join(os.homedir(), '.local', 'share', 'TeleAgent');
const out = path.resolve(process.argv[2] || './ta-export');
fs.mkdirSync(path.join(out, 'credentials'), { recursive: true });

const lsPath = path.join(DATA, 'Local State');
const owner = JSON.parse(fs.readFileSync(path.join(DATA, 'current-owner.json'), 'utf8'));
const ownerDir = owner.ownerDir;
const srcToken = path.join(DATA, 'users', ownerDir, 'app-auth', 'token.json');
const srcMeta = path.join(DATA, 'app-auth', 'device-meta.json');

// 1) DPAPI 解 32B 主密钥（与 lib/auth.mjs 完全同款）
const ps = String.raw`
param([string]$LocalState,[string]$Out)
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security
$ls=Get-Content -LiteralPath $LocalState -Raw|ConvertFrom-Json
$raw=[Convert]::FromBase64String($ls.os_crypt.encrypted_key)
if([Text.Encoding]::ASCII.GetString($raw[0..4]) -ne 'DPAPI'){throw 'bad prefix'}
$blob=$raw[5..($raw.Length-1)]
$key=[System.Security.Cryptography.ProtectedData]::Unprotect($blob,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser)
[IO.File]::WriteAllText($Out,[Convert]::ToBase64String($key))
`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ta-exp-'));
const psFile = path.join(tmp, 'u.ps1');
const keyOut = path.join(tmp, 'k.b64');
fs.writeFileSync(psFile, '\uFEFF' + ps, 'utf8');
const r = spawnSync(
  'powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', psFile, lsPath, keyOut],
  { stdio: 'ignore' },
);
if (r.status !== 0) throw new Error('DPAPI 解保护失败：确认在已登录 TeleAgent 的本机运行');
const keyB64 = fs.readFileSync(keyOut, 'utf8').trim();
fs.rmSync(tmp, { recursive: true, force: true });

// 2) round-trip 校验：用主密钥解 token.json，确认是合法 JWT 且未过期
const rec = JSON.parse(fs.readFileSync(srcToken, 'utf8'));
const raw = Buffer.from(rec.encryptedToken, 'base64');
if (raw.subarray(0, 3).toString() !== 'v10') throw new Error('不支持的密文版本');
const nonce = raw.subarray(3, 15);
const tag = raw.subarray(raw.length - 16);
const ct = raw.subarray(15, raw.length - 16);
const d = crypto.createDecipheriv('aes-256-gcm', Buffer.from(keyB64, 'base64'), nonce);
d.setAuthTag(tag);
const plain = Buffer.concat([d.update(ct), d.final()]).toString('utf8');
const jwt = plain.slice(plain.lastIndexOf(':') + 1);
const payload = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString('utf8'));
const daysLeft = Math.round((payload.exp * 1000 - Date.now()) / 86400000);
if (!(daysLeft > 0)) throw new Error('导出的 token 已过期，请在 PC 上重新登录桌面端');

// 3.5) 平台 Cookie 对（operToken/operationToken）——2026-11-20 实证：换发请求缺这对
//      Cookie 会被服务器判 40115 session_not_found。明文存于 owner partition 的
//      Cookies SQLite（Electron net.fetch 会话）。随 store.json 一并导出。
let cookies = null;
try {
  const cookiesDb = path.join(DATA, 'Partitions', `owner%3A${ownerDir}`, 'Network', 'Cookies');
  if (fs.existsSync(cookiesDb)) {
    const { DatabaseSync } = await import('node:sqlite');
    const db = new DatabaseSync(cookiesDb, { readOnly: true });
    const rows = db
      .prepare("SELECT name, value FROM cookies WHERE host_key LIKE '%teleai.com.cn' AND name IN ('operToken','operationToken')")
      .all();
    db.close();
    const c = {};
    for (const r of rows) if (r.value && r.value.trim()) c[r.name] = r.value.trim();
    if (c.operToken || c.operationToken) cookies = c;
  }
} catch (err) {
  console.warn(`警告：Cookie 导出失败（${err.message}）。NAS 端可在管理台「导入 Cookie」补录，否则自动续期将报 40115。`);
}

// 4) 写 TA2API 自管凭据库格式（不导出主密钥本身——NAS 端不再需要 DPAPI）
const meta = JSON.parse(fs.readFileSync(srcMeta, 'utf8'));
const store = {
  token: jwt,
  tokenIssuedAt: payload.iat ? payload.iat * 1000 : Date.now(),
  tokenExpiresAt: payload.exp * 1000,
  absoluteExpiresAt: null,
  generation: 1,
  source: 'pc-export',
  ...(cookies ? { cookies } : {}),
};
fs.writeFileSync(path.join(out, 'credentials', 'store.json'), JSON.stringify(store, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(out, 'credentials', 'device.json'), JSON.stringify({ deviceId: meta.deviceId, installId: meta.installId }, null, 2), { mode: 0o600 });
fs.writeFileSync(
  path.join(out, 'export-meta.json'),
  JSON.stringify({ exportedAt: new Date().toISOString(), tokenDaysLeft: daysLeft, ownerDir }, null, 2),
);

// 4) 账号「非密」配置布局（NAS 端 paths.mjs 需要，缺模型目录会启动失败）：
//    current-owner.json / runtimes/.version.json / users/<ownerDir>/model-catalog.json / preset-context.json
//    拷到 out/TeleAgent-layout/ → NAS 端放到 /data/TeleAgent/
const layout = path.join(out, 'TeleAgent-layout');
fs.mkdirSync(path.join(layout, 'runtimes'), { recursive: true });
fs.mkdirSync(path.join(layout, 'users', ownerDir), { recursive: true });
fs.copyFileSync(path.join(DATA, 'current-owner.json'), path.join(layout, 'current-owner.json'));
const srcVer = path.join(DATA, 'runtimes', '.version.json');
if (fs.existsSync(srcVer)) fs.copyFileSync(srcVer, path.join(layout, 'runtimes', '.version.json'));
for (const name of ['model-catalog.json', 'preset-context.json']) {
  const src = path.join(DATA, 'users', ownerDir, name);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(layout, 'users', ownerDir, name));
  else console.warn(`警告：缺少 ${name}（NAS 端模型列表将依赖它）`);
}

console.log(`OK — token 可解，剩余 ${daysLeft} 天；导出目录：${out}`);
console.log(cookies ? `平台 Cookie 对已随 store.json 导出（${Object.keys(cookies).join('、')}）——NAS 端自动续期开箱即用。` : '注意：本次未导出平台 Cookie 对（换发会话要素），NAS 端请在管理台「导入 Cookie」补录，否则自动续期会报 40115。');
console.log('把 credentials/ 拷到 NAS 的 /app/runtime/credentials/，TeleAgent-layout/ 拷到 /data/TeleAgent/。');
console.log('注意：store.json 里的 token 和 Cookie 都是明文凭据，不要外传/提交 git。');
