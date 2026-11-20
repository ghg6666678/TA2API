// 自管凭据库 + 官方 token-refresh 协议复刻（NAS/容器「自给自足」的核心）。
//
// 协议证据（2026-11-20，TeleAgent 桌面端 3.1.1 app.asar 主进程 AuthRenewal 模块；
// 提取件：工作区 reverse/teleagent-kernel/asar-extract/dist-electron/main-runtime-632rqJFI.js）：
//
//   换发：POST {authBase}/cowork/auth/token-refresh
//   请求头（FEt，全部明文可见）：
//     Content-Type: application/json
//     X-Token: <当前 JWT>            —— 源码注释：「换新/logout 与现网一致使用 X-Token，不引入 Bearer」
//     X-Timestamp: <unix 秒>
//     X-Nonce: <UUID>
//     X-App-Version: <应用版本>       （桌面端 = Electron app.getVersion()，如 3.1.1.000）
//     X-OS-Type: win32→Windows / darwin→macOS / 其余原样（snt 映射）
//     X-SuperAgent-Device-Id: <deviceId>
//   body 为空（源码注释：「Body 可空（后端契约）：不发任何猜测字段」），超时 10s（LEt=1e4）。
//   【换发不走内核那套 X-SuperAgent-Signature HMAC 签名】——这意味着无需内核即可自续期。
//
//   【Cookie 是会话定位要素（2026-11-20 实证）】：
//   桌面端 kNe 用 Electron net.fetch（MV(Fi()) = owner partition session）发请求——
//   自动携带 .teleai.com.cn 域全部 Cookie。session 里有一对：
//     operToken       = <短 JWT>（~356 字符）
//     operationToken  = "<tenant>:<accessToken>"（tenant 是 JWT claims 里的租户段）
//   两者都是登录页响应 Set-Cookie 种下的，明文存于 partition Cookies SQLite 的 value 列。
//   只发 FEt 头、不带这对 Cookie → 服务器返回业务码 40115 session_not_found
//   （「已 logout 或已轮转并超出吊销宽限」）——2026-11-20 管理台「手动续期」实测复现。
//   因此 refreshToken 支持 cookie 参数；Cookie 来源：
//     PC：readPlatformCookies() 读 partition Cookies 库（node:sqlite，失败降级 null）；
//     NAS/容器：store.json 的 cookies 字段（export-credentials 导入或管理台粘贴）；
//     换发成功后：响应 Set-Cookie 会被 parseSetCookies 解析并落库，实现自持。
//
//   响应（GEt/WEt/HEt）：{ code | responseCode, data: { accessToken, expiresIn(秒), absoluteExpiresAt?(ms或s) } }
//   业务码（aI 枚举 + OEt 分类）：
//     40112 missing_token        终态（需重新登录）
//     40113 signature_invalid    终态
//     40114 token_expired        终态（已超出验签宽限）
//     40115 session_not_found    终态（已 logout 或已轮转并超出吊销宽限）
//     40116 session_absolute_expired 终态（源码注释：90 天绝对期限已过）
//     50005 temporarily_unavailable  可重试；HTTP>=500 同
//     HTTP 401 → unauthorized（终态）；403 → forbidden；404/405 → unsupported（网关不支持换发）
//
//   桌面端日志实测（11-16 ~ 11-20）：每次成功后 ttl=604799s —— 每次换发把 7 天 TTL 重置回满。
//   桌面端触发器：启动补偿 / 6h 定时器 / 唤醒，renewal-schedule.json 只记「每天最多一次」。
//
// 首次登录（浏览器通道，与官方 Web 登录壳同机制）：
//   登录页 https://agent.teleai.com.cn/meter/teleagent-login/login 本就设计为 iframe 内嵌
//   （源码注释：「Desktop 和 Web 登录壳都只 iframe 此地址」），登录完成后向父窗口
//   postMessage { type: 'loginRedirect', url }，url 即 .../superCowork/sapi/cowork/auth?code=..&token=..
//   （桌面端 did-navigate 监听同一 URL 形态并取 searchParams 的 code/token）。
//   管理台监听 message 事件提取 token；兜底：用户手工粘贴回跳网址。
//
// 存储：runtime/credentials/store.json（0600，原子写），runtime/ 本就在 .gitignore 内。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_AUTH_BASE = 'https://agent.teleai.com.cn/superCowork/sapi';
export const REFRESH_PATH = '/cowork/auth/token-refresh';
export const REFRESH_TIMEOUT_MS = 10_000;

/** 桌面端 snt() 映射：win32→Windows，darwin→macOS，其余原样（linux 官方 deb 客户端即此值）。 */
export function osTypeFor(platform = process.platform) {
  if (platform === 'win32') return 'Windows';
  if (platform === 'darwin') return 'macOS';
  return platform || 'unknown';
}

/** FEt 复刻：换发请求头。顺序无关，但字段名/取值语义必须与桌面端一致。 */
export function refreshHeaders({ token, deviceId, appVersion, osType, cookie, now = Date.now(), nonce = crypto.randomUUID() }) {
  if (!token) throw new Error('refreshHeaders: token 为空');
  const headers = {
    'Content-Type': 'application/json',
    'X-Token': token,
    'X-Timestamp': Math.floor(now / 1000).toString(),
    'X-Nonce': nonce,
    'X-App-Version': appVersion ?? '',
    'X-OS-Type': osType ?? '',
    'X-SuperAgent-Device-Id': deviceId || '',
  };
  // Cookie 会话对（operToken/operationToken）是服务器定位换发会话的要素之一。
  const cookieStr = typeof cookie === 'string' ? cookie.trim() : cookieToHeader(cookie);
  if (cookieStr) headers['Cookie'] = cookieStr;
  return headers;
}

/** { operToken, operationToken } → Cookie 头字符串；空值跳过。 */
export function cookieToHeader(cookie) {
  if (!cookie || typeof cookie !== 'object') return '';
  return ['operToken', 'operationToken']
    .filter((k) => cookie[k])
    .map((k) => `${k}=${cookie[k]}`)
    .join('; ');
}

/**
 * 从桌面端 owner partition 的 Cookies 库读平台 Cookie 对（明文 value 列）。
 * Electron partition 目录：Partitions/owner%3A<ownerDir>/Network/Cookies。
 * 需要 node:sqlite（Node 22.13+ 免 flag；更早版本/不可用时返回 null，调用方降级到 store.json）。
 */
export async function readPlatformCookies({ deviceDataRoot, ownerDir }) {
  if (!deviceDataRoot || !ownerDir) return null;
  const dbPath = path.join(deviceDataRoot, 'Partitions', `owner%3A${ownerDir}`, 'Network', 'Cookies');
  if (!fs.existsSync(dbPath)) return null;
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    return null; // node:sqlite 不可用
  }
  try {
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const rows = db
        .prepare("SELECT name, value FROM cookies WHERE host_key LIKE '%teleai.com.cn' AND name IN ('operToken','operationToken')")
        .all();
      const out = {};
      for (const r of rows) {
        if (r.value && r.value.trim()) out[r.name] = r.value.trim();
      }
      return out.operToken || out.operationToken ? out : null;
    } finally {
      db.close();
    }
  } catch {
    // 库被锁（桌面版正在写）等情况：复制到临时文件再试一次
    try {
      const tmp = path.join(os.tmpdir(), `ta-cookies-copy-${process.pid}-${Date.now()}.db`);
      fs.copyFileSync(dbPath, tmp);
      const db = new DatabaseSync(tmp, { readOnly: true });
      try {
        const rows = db
          .prepare("SELECT name, value FROM cookies WHERE host_key LIKE '%teleai.com.cn' AND name IN ('operToken','operationToken')")
          .all();
        const out = {};
        for (const r of rows) {
          if (r.value && r.value.trim()) out[r.name] = r.value.trim();
        }
        return out.operToken || out.operationToken ? out : null;
      } finally {
        db.close();
        fs.rmSync(tmp, { force: true });
      }
    } catch {
      return null;
    }
  }
}

/** 从换发响应的 Set-Cookie 数组提取平台 Cookie 对（换发成功后服务器会下发新的一代）。 */
export function parseSetCookies(setCookies) {
  const out = {};
  for (const raw of Array.isArray(setCookies) ? setCookies : []) {
    const first = String(raw).split(';')[0];
    const eq = first.indexOf('=');
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if ((name === 'operToken' || name === 'operationToken') && value) out[name] = value;
  }
  return Object.keys(out).length ? out : null;
}

/** OEt/aI 复刻：按业务码 / HTTP 状态分类。terminal → 需重新登录；retryable → 下个周期重试。 */
const TERMINAL_CODES = {
  40112: 'missing_token',
  40113: 'signature_invalid',
  40114: 'token_expired',
  40115: 'session_not_found',
  40116: 'session_absolute_expired',
};
export function classifyRefresh(httpStatus, code) {
  if (code != null && TERMINAL_CODES[code]) {
    return { category: TERMINAL_CODES[code], code, terminal: true, retryable: false };
  }
  if (code === 50005) {
    return { category: 'temporarily_unavailable', code, terminal: false, retryable: true };
  }
  if (httpStatus === 401) return { category: 'unauthorized', code: code ?? null, terminal: true, retryable: false };
  if (httpStatus === 403) return { category: 'forbidden', code: code ?? null, terminal: false, retryable: false };
  if (httpStatus === 404 || httpStatus === 405) return { category: 'unsupported', code: code ?? null, terminal: true, retryable: false };
  if (httpStatus != null && httpStatus >= 500) return { category: 'server_error', code: code ?? null, terminal: false, retryable: true };
  return { category: code != null || httpStatus != null ? 'unknown' : 'network_error', code: code ?? null, terminal: false, retryable: true };
}

/** PEt：业务码可能是 number 或纯数字字符串。 */
function parseCode(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

/**
 * GEt/WEt/HEt 复刻：解析换发响应。
 * data 里有 accessToken → 用 data 层；否则顶层兜底。absoluteExpiresAt 秒/毫秒均可，不可解析则记 null（保留 token）。
 */
export function parseRefreshResponse(text) {
  let root = null;
  try {
    root = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid-json', code: null, accessToken: null, expiresIn: null, absoluteExpiresAt: null };
  }
  const data = root && typeof root === 'object' ? root.data : undefined;
  const layer = data && typeof data === 'object' && 'accessToken' in data ? data : root;
  const code = parseCode(root?.responseCode) ?? parseCode(root?.code);
  const accessToken = typeof layer?.accessToken === 'string' ? layer.accessToken.trim() : '';
  let expiresIn = typeof layer?.expiresIn === 'number' && Number.isFinite(layer.expiresIn) && layer.expiresIn > 0 ? layer.expiresIn : null;
  let absoluteExpiresAt = null;
  const abs = layer?.absoluteExpiresAt;
  if (typeof abs === 'number' && Number.isFinite(abs) && abs > 0) {
    const ms = abs < 1e11 ? abs * 1000 : abs; // 桌面端 HEt：小于 1e11 视为秒
    absoluteExpiresAt = ms > Date.now() ? ms : null;
  }
  if (!accessToken || !expiresIn) {
    return { ok: false, reason: 'missing-accessToken-or-expiresIn', code, accessToken: null, expiresIn, absoluteExpiresAt };
  }
  return { ok: true, code, accessToken, expiresIn, absoluteExpiresAt };
}

/** 完成一次换发调用（不发任何多余字段，失败不重试——重试节奏由调用方/定时器决定）。 */
export async function refreshToken({
  token,
  deviceId,
  cookie,
  authBase = DEFAULT_AUTH_BASE,
  appVersion = '',
  osType = osTypeFor(),
  timeoutMs = REFRESH_TIMEOUT_MS,
  fetchImpl = globalThis.fetch,
}) {
  if (!token) return { status: 'failed', category: 'no-token', terminal: true, retryable: false, httpStatus: null };
  const url = `${authBase.replace(/\/$/, '')}${REFRESH_PATH}`;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: refreshHeaders({ token, deviceId, appVersion, osType, cookie }),
      body: '',
      signal: ctl.signal,
    });
    const text = await res.text();
    const parsed = parseRefreshResponse(text);
    const setCookies = typeof res.headers?.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    const cls = classifyRefresh(res.status, parsed.code);
    // 桌面端 JEt 的判定顺序：OEt（业务码分类，含终态）先于 HTTP !ok 检查——
    // 2xx 带终态业务码同样按「需重新登录」处理。
    if (parsed.code != null && cls.terminal) {
      return { status: 'failed', ...cls, httpStatus: res.status, parsed };
    }
    if (res.status === 404 || res.status === 405) {
      return { status: 'unsupported', ...cls, httpStatus: res.status, parsed };
    }
    if (!res.ok) {
      return { status: 'failed', ...cls, httpStatus: res.status, parsed };
    }
    if (!parsed.ok) {
      // 2xx 但载荷不合法：按不可解析处理，保留旧 token（桌面端同策略），标 retryable 等下轮
      return { status: 'failed', category: 'invalid_response', code: parsed.code, terminal: false, retryable: true, httpStatus: res.status, parsed };
    }
    return {
      status: 'succeeded',
      token: parsed.accessToken,
      expiresIn: parsed.expiresIn,
      absoluteExpiresAt: parsed.absoluteExpiresAt,
      setCookies,           // 服务器下发的新一代 Cookie 对（parseSetCookies 提取后落库自持）
      httpStatus: res.status,
      code: parsed.code,
    };
  } catch (err) {
    const aborted = err?.name === 'AbortError';
    return { status: 'failed', category: aborted ? 'timed_out' : 'network_error', terminal: false, retryable: true, httpStatus: null, error: err?.message };
  } finally {
    clearTimeout(timer);
  }
}

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

/** JWT exp → ms（无法解析返回 null）。 */
export function jwtExpiresAt(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    return typeof payload?.exp === 'number' ? payload.exp * 1000 : null;
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

// ---------------------------------------------------------------- 续期循环

function localDay(ts = Date.now()) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 与桌面端同节奏的自续期循环：启动补偿 + 每 6h 定时（同一自然日只尝试一次，可 force）。
 *
 * - getToken：当前生效 token 的读取口（DPAPI 或自管库都行）；
 * - onRenewed：换发成功（调用方负责更新 authState + 重启内核 + 落库）；
 * - onNeedLogin：终态失败（40112~40116 / 401）→ 管理台亮「请重新登录」；
 * - retryable 失败不记「当天已尝试」，下个间隔自动重试。
 */
export function startRenewalLoop({
  runtimeRoot,
  getToken,
  getCookies,
  deviceId,
  authBase = process.env.TA_AUTH_BASE_URL || DEFAULT_AUTH_BASE,
  appVersion = process.env.TA_AUTH_APP_VERSION || '3.1.1.000',
  osType = osTypeFor(),
  intervalMs,
  startupDelayMs,
  onRenewed,
  onNeedLogin,
  onAttempt,
  logger = console,
  fetchImpl = globalThis.fetch,
} = {}) {
  // 禁用语义：TA_RENEW_INTERVAL_MS=0/off/false → 不建定时器、不做启动补偿；
  // 只保留手动续期入口（管理台按钮 / loop.tick(true)）。
  const rawInterval = process.env.TA_RENEW_INTERVAL_MS;
  const disabled = intervalMs !== undefined ? intervalMs <= 0 : rawInterval === '0' || rawInterval === 'off' || rawInterval === 'false';
  const effIntervalMs = disabled ? 0 : intervalMs ?? Number(process.env.TA_RENEW_INTERVAL_MS || 6 * 60 * 60 * 1000);
  const effStartupDelay = disabled ? null : startupDelayMs ?? Number(process.env.TA_RENEW_STARTUP_DELAY_MS || 15_000);
  let generation = loadCredentialStore(runtimeRoot)?.generation ?? 0;
  let running = false;
  let stopped = false;
  let lastResult = null;

  async function tick(force = false) {
    if (stopped || running) return lastResult ?? { status: 'skipped', reason: 'busy' };
    const token = getToken?.() ?? '';
    if (!token) {
      onNeedLogin?.('尚未登录');
      return { status: 'skipped', reason: 'no-token' };
    }
    const store = loadCredentialStore(runtimeRoot);
    const today = localDay();
    if (!force && store?.lastAttemptDay === today) {
      return { status: 'skipped', reason: 'already-attempted-today' };
    }
    running = true;
    try {
      saveCredentialStore(runtimeRoot, { lastAttemptDay: today });
      let cookie = null;
      try {
        cookie = (typeof getCookies === 'function' ? await getCookies() : null) ?? null;
      } catch (err) {
        logger.warn?.(`[teleagent] 读取平台 Cookie 失败（将不带 Cookie 换发，可能 40115）：${err.message}`);
      }
      const result = await refreshToken({ token, deviceId, cookie, authBase, appVersion, osType, fetchImpl });
      if (result.status === 'succeeded') {
        generation += 1;
        const patch = {
          token: result.token,
          tokenIssuedAt: Date.now(),
          tokenExpiresAt: result.expiresIn ? Date.now() + result.expiresIn * 1000 : jwtExpiresAt(result.token),
          absoluteExpiresAt: result.absoluteExpiresAt ?? null,
          generation,
          source: 'renewal',
        };
        // 换发成功后服务器 Set-Cookie 下发新一代 Cookie 对——落库自持（NAS 关键路径）。
        const nextCookies = parseSetCookies(result.setCookies);
        if (nextCookies) patch.cookies = { ...(store?.cookies ?? {}), ...nextCookies };
        saveCredentialStore(runtimeRoot, patch);
        lastResult = { at: Date.now(), ok: true, generation, expiresIn: result.expiresIn, httpStatus: result.httpStatus };
        onRenewed?.({ token: result.token, expiresIn: result.expiresIn, absoluteExpiresAt: patch.absoluteExpiresAt, generation, source: 'renewal' });
        logger.log?.(`[teleagent] 凭据已续期：generation=${generation} · TTL=${Math.round((result.expiresIn || 0) / 3600)}h${nextCookies ? ' · Cookie 已更新' : ''}`);
      } else {
        lastResult = { at: Date.now(), ok: false, category: result.category, code: result.code ?? null, httpStatus: result.httpStatus ?? null, terminal: result.terminal === true };
        if (result.retryable) {
          // 允许下个间隔重试：清掉「今天已尝试」标记
          saveCredentialStore(runtimeRoot, { lastAttemptDay: '' });
          logger.warn?.(`[teleagent] 凭据续期失败（可重试）：${result.category}${result.code != null ? ` code=${result.code}` : ''}`);
        } else {
          logger.warn?.(`[teleagent] 凭据续期失败（终态）：${result.category}${result.code != null ? ` code=${result.code}` : ''} → 需要重新登录`);
          onNeedLogin?.(`凭据已失效（${result.category}），请在管理台重新登录`);
        }
      }
      onAttempt?.(lastResult);
      return lastResult;
    } finally {
      running = false;
    }
  }

  const startupTimer = effStartupDelay != null
    ? setTimeout(() => {
        tick().catch((err) => logger.error?.(`[teleagent] 续期异常：${err.message}`));
      }, Math.max(0, effStartupDelay))
    : null;
  startupTimer?.unref?.();
  const timer = effIntervalMs > 0
    ? setInterval(() => {
        tick().catch((err) => logger.error?.(`[teleagent] 续期异常：${err.message}`));
      }, Math.max(60_000, effIntervalMs))
    : null;
  timer?.unref?.();

  return {
    tick,
    stop() {
      stopped = true;
      if (startupTimer) clearTimeout(startupTimer);
      if (timer) clearInterval(timer);
    },
    status() {
      return { generation, lastResult, intervalMs: effIntervalMs, disabled };
    },
  };
}
