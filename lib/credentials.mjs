// 自管凭据库 + 管理台登录通道。
//
// 它只管两件事：
//   1. 存储：runtime/credentials/store.json（0600，原子写）与 device.json；
//   2. 工具：JWT iat/exp 解析，供「谁新用谁」的代际比较。
//
// 登录与换发都不在这里：token 由桌面版签发并刷新，反代读取 token.json（dpapi）跟随；
// 管理台不再提供「用 Cookie 登录」——那条路拿到的 token 同样只有 7 天、同样不能续期，
// 到期照样得开桌面版，没有独立价值。
//
// 【为什么没有换发（token-refresh）】2026-11-21 实测：服务端只接受官方桌面客户端
// 发出的换发请求，第三方 HTTP 客户端（Node fetch / curl 8.21 / Chromium 131 全部试过）
// 一律 40115 session_not_found；而同一会话桌面版能连续成功。已排除凭据过期、Cookie
// 轮转、deviceId、UA、版本号、Origin/Referer、双客户端竞争。
// 结论：PC 上 token 由桌面版刷新，反代只跟随（server.mjs 的 followDesktopToken）；
// 原先复刻的换发协议实现已整体移除，协议细节留在 git 历史与 docs/nas-docker.md。
//
// 存储位置：runtime/credentials/store.json，runtime/ 本就在 .gitignore 内。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/** JWT exp → ms（无法解析返回 null）。 */export function jwtExpiresAt(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

/** JWT iat → ms（无法解析返回 null）。用于「谁新用谁」：跟随桌面版 token.json 时比较代际。 */
export function tokenIat(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload?.iat === 'number' ? payload.iat * 1000 : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- 存储层

function credentialDir(runtimeRoot) {
  return path.join(runtimeRoot, 'credentials');
}
function storeFile(runtimeRoot) {
  return path.join(credentialDir(runtimeRoot), 'store.json');
}
function deviceFile(runtimeRoot) {
  return path.join(credentialDir(runtimeRoot), 'device.json');
}

function readJsonFile(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  try {
    fs.chmodSync(file, 0o600);
  } catch {}
}

/** 桌面端 device-meta.json（deviceId/installId 明文）优先；没有则生成并持久化。 */
export function ensureDeviceIdentity(runtimeRoot, fallbackMeta = {}) {
  const existing = readJsonFile(deviceFile(runtimeRoot));
  if (existing?.deviceId) return { ...existing, source: 'credentials' };
  const dId = String(fallbackMeta?.deviceId ?? '').trim();
  const iId = String(fallbackMeta?.installId ?? '').trim();
  if (dId) {
    const identity = { deviceId: dId, installId: iId || crypto.randomUUID() };
    writeJsonAtomic(deviceFile(runtimeRoot), identity);
    return { ...identity, source: 'desktop' };
  }
  // 新设备身份：deviceId 12 位 hex（与桌面端形态一致，如 MAC 无分隔），installId 为 UUID v4。
  const identity = { deviceId: crypto.randomBytes(6).toString('hex'), installId: crypto.randomUUID() };
  writeJsonAtomic(deviceFile(runtimeRoot), identity);
  return { ...identity, source: 'generated' };
}

export function loadCredentialStore(runtimeRoot) {
  return readJsonFile(storeFile(runtimeRoot));
}

/** 合并写入（原子 + 0600）。返回合并后的完整 store。 */
export function saveCredentialStore(runtimeRoot, patch) {
  const next = { ...(loadCredentialStore(runtimeRoot) ?? {}), ...patch };
  writeJsonAtomic(storeFile(runtimeRoot), next);
  return next;
}
