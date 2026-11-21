// 自管凭据库 + 管理台登录通道。
//
// 这里只管三件事：
//   1. 登录：从回执 URL / 平台 Cookie 里拿到 access token（extractLoginResult、
//      exchangeCodeForToken；Cookie → token 的拆分在 server.mjs 的 parseCookieHeader）；
//   2. 存储：runtime/credentials/store.json（0600，原子写）与 device.json；
//   3. 工具：JWT iat/exp 解析，供「谁新用谁」的代际比较。
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

/** 从登录回跳 URL 提取凭据（桌面端 n4e 的判定：pathname 含 /cowork/auth 且带 code）。 */
export function extractLoginResult(rawUrl) {
  let u = null;
  try {
    u = new URL(String(rawUrl).trim());
  } catch {
    return { ok: false, reason: 'not-a-url' };
  }
  if (!u.pathname.includes('/cowork/auth')) return { ok: false, reason: 'not-cowork-auth-redirect' };
  const code = u.searchParams.get('code') || null;
  const token = u.searchParams.get('token') || null;
  return { ok: Boolean(code || token), token, code, url: u.toString() };
}

export const CODE_EXCHANGE_TIMEOUT_MS = 15_000;

/**
 * 用回执 URL 上的 code 换 access token（2026-11-21）。
 *
 * 背景：桌面客户端**不自己换 token** —— 它登录窗口监听 `did-navigate`，从 URL 上
 * 直接取 `token` 参数；token 是服务端认可「桌面客户端」身份时 302 附上的。
 * 浏览器打开同一个 URL 只会看到「请打开桌面客户端」提示页，地址栏里始终没有 token。
 *
 * 所以这里按桌面端身份（UA + 六头里的版本/系统/设备）请求，逐跳读 Location，
 * 一旦某一跳带上 token 就返回。浏览器里那一跳没带 token，不代表服务端换不出来。
 */
export async function exchangeCodeForToken(
  rawUrl,
  { deviceId = '', appVersion = '', osType = 'Windows', timeoutMs = CODE_EXCHANGE_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {},
) {
  const parsed = extractLoginResult(rawUrl);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };
  if (parsed.token) return { ok: true, token: parsed.token, via: 'url' };
  if (!parsed.code) return { ok: false, reason: 'no-code' };

  const ver = appVersion || '3.1.1';
  const headers = {
    // 与 Electron 桌面端一致的 UA 形态（TeleAgent/x.y.z + Electron/x）
    'User-Agent':
      `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ` +
      `TeleAgent/${ver} Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36`,
    Accept: 'text/html,application/json;q=0.9,*/*;q=0.8',
    'X-App-Version': ver,
    'X-OS-Type': osType || '',
    'X-SuperAgent-Device-Id': deviceId || '',
  };

  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let current = parsed.url;
  let lastStatus = null;
  let lastType = '';
  try {
    for (let hop = 0; hop < 6; hop += 1) {
      const res = await fetchImpl(current, { method: 'GET', headers, redirect: 'manual', signal: ctl.signal });
      lastStatus = res.status;
      lastType = res.headers.get('content-type') || '';
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        const next = new URL(loc, current).toString();
        const hit = extractLoginResult(next);
        if (hit.token) return { ok: true, token: hit.token, via: 'redirect', hops: hop + 1 };
        current = next;
        continue;
      }
      // 非跳转：可能在 body 里直接给 token（JSON 或 HTML 内嵌）
      const text = await res.text();
      const direct = text.match(/[?&"]token["']?\s*[:=]\s*["']?([A-Za-z0-9._-]{20,})/);
      if (direct && direct[1].includes('.')) {
        return { ok: true, token: direct[1], via: 'body', hops: hop + 1 };
      }
      return {
        ok: false,
        reason: 'no-token-in-response',
        detail: `HTTP ${res.status} ${lastType}｜${text.slice(0, 200).replace(/\s+/g, ' ')}`,
      };
    }
    return { ok: false, reason: 'too-many-hops', detail: `最后一跳 HTTP ${lastStatus} ${lastType}` };
  } catch (err) {
    const timedOut = err?.name === 'AbortError';
    return { ok: false, reason: timedOut ? 'timeout' : 'network-error', detail: String(err?.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

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
