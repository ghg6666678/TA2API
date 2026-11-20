#!/usr/bin/env node
// TeleAgent → 本地 OpenAI 兼容反代（kernel 模式）
//
// 用法：
//   node server.mjs                    # 监听 127.0.0.1:8787
//   TA_PORT=9000 node server.mjs       # 换端口
//   TA_API_KEY=sk-local node server.mjs # 要求客户端带 Bearer
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveOwner, accountDir, tokenFile, readJson, kernelVersion, ensureTeleAgentLayout, LOCAL_STATE_FILE, DEVICE_DATA_ROOT } from './lib/paths.mjs';
import { loadAuthState, deviceMeta, parseJwt } from './lib/auth.mjs';
import {
  ensureDeviceIdentity,
  loadCredentialStore,
  saveCredentialStore,
  startRenewalLoop,
  extractLoginResult,
  jwtExpiresAt,
  readPlatformCookies,
  parseSetCookies,
} from './lib/credentials.mjs';
import { startKernel, NEUTRAL_AGENT_PROMPT } from './lib/kernel.mjs';
import { createToolBridge } from './lib/toolbridge.mjs';
import { resetSessions as resetResponsesSessions } from './lib/responses.mjs';
import { createShim } from './lib/shim.mjs';
import { createKeyStore } from './lib/keystore.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const missing = ensureTeleAgentLayout();
// Local State 只服务于 DPAPI 解密（桌面端兼容通道）——NAS 登录优先路径没有它也能跑，
// 不能因为缺它而拒绝启动（凭据库/管理台登录才是 NAS 主通道）。
const fatalMissing = missing.filter((f) => f !== LOCAL_STATE_FILE);
if (fatalMissing.length > 0) {
  console.error('找不到 TeleAgent 安装/内核信息：\n  ' + fatalMissing.join('\n  '));
  console.error('请先安装 TeleAgent（或按 docker/DEPLOY-GUIDE.md 准备容器载荷）。');
  process.exit(1);
}
if (missing.length > fatalMissing.length) {
  console.warn('[teleagent] 无桌面端 Local State：DPAPI 通道不可用，将依赖凭据库或管理台登录。');
}

const owner = resolveOwner();
const runtimeRoot = path.join(here, 'runtime');

// 凭据来源优先级：自管凭据库（runtime/credentials/store.json，支持自动续期，NAS/容器主通道）
// > 桌面端 DPAPI token.json（Windows 兼容通道）。两者皆无也允许启动——管理台登录后即可拉起内核。
const device = ensureDeviceIdentity(runtimeRoot, deviceMeta());
let storedCredentials = loadCredentialStore(runtimeRoot);
let auth = null;
let authSource = 'none';
if (storedCredentials?.token) {
  auth = { token: storedCredentials.token, tenant: '', claims: parseJwt(storedCredentials.token) };
  authSource = 'credentials';
} else {
  try {
    auth = await loadAuthState({ tokenFile: tokenFile(owner) });
    if (auth?.token) authSource = 'dpapi';
  } catch (err) {
    console.warn(`[teleagent] 桌面端登录态不可用（${err.message}）`);
  }
}
if (!auth?.token) {
  console.warn('[teleagent] 尚未登录：内核暂不启动。请打开管理台完成登录，或在 PC 上完成一次桌面端登录。');
}

const catalog = readJson(path.join(accountDir(owner), 'model-catalog.json'), null);
const models = (catalog?.state?.catalog?.groups ?? [])
  .flatMap((g) => g.models ?? [])
  .map((m) => ({ id: m.modelID, name: m.displayName, context: m.limits?.context, output: m.limits?.output }));

if (models.length === 0) {
  console.error('模型目录为空：先在 TeleAgent 桌面端打开一次对话。');
  process.exit(1);
}

console.log(`[teleagent] 账号 ${auth?.claims?.accountName ?? '?'} · kernel ${kernelVersion()} · 凭据来源 ${authSource}`);

const authState = { token: auth?.token ?? '', deviceId: device.deviceId, installId: device.installId };

/**
 * 当前内核实际采用的提示词来源（`/healthz` 与日志都读它）。
 *
 * 「模型又自报星辰」几乎只有两种原因：内核根本没吃进客户端提示词，或者客户端
 * 提示词压根没发过来。把「谁在生效」变成可读字段，就不用再靠猜。
 */
let kernelInfo = { client: 'default', promptChars: 0, promptSha: null, verified: null };

/**
 * 启动/切换内核后回读 `/config`，确认 `agent.build.prompt` 真的是我们下发的版本。
 * 读不到（接口变动）只记 `verified: null`，不阻断请求。
 */
async function verifyKernelPrompt(target, expected) {
  const want = (expected ?? '').trim();
  let got = null;
  try {
    const res = await target.call('GET', '/config', null, { timeoutMs: 8000 });
    got = res.json?.agent?.build?.prompt ?? null;
  } catch {
    // 读不到就保持未校验；不影响代理本身
  }
  const actual = (got ?? '').trim();
  const verified = got === null ? null : want ? actual === want : true;
  if (verified === false) {
    console.warn(
      `[teleagent] ⚠ 内核没有采用我们下发的 prompt：期望 ${want.length} 字符，实际 ${actual.length} 字符`,
    );
  }
  if (actual.includes('星辰超级智能体')) {
    console.warn('[teleagent] ⚠ 内核正在使用自带「星辰」人设：检查 TA_BUILTIN_PROMPT 是否被设成了 1');
  }
  return {
    promptChars: actual.length,
    promptSha: actual ? crypto.createHash('sha1').update(actual).digest('hex').slice(0, 12) : null,
    verified,
  };
}


// API Key 表：默认 runtime/config/api-keys.json（TA_KEYS_FILE 可改），管理台在这里增删
const keystore = createKeyStore({ file: process.env.TA_KEYS_FILE || path.join(runtimeRoot, 'config', 'api-keys.json') });
const adminToken = process.env.TA_ADMIN_TOKEN || null;

console.log('[teleagent] 正在启动 kernel（首次约需 1–2 分钟）…');
let kernel = null;
if (authState.token) {
  kernel = await startKernel({ runtimeRoot, auth: authState, catalog });
  await kernel.waitReady({ timeoutMs: 90000 });
  kernelInfo = { client: 'neutral', ...(await verifyKernelPrompt(kernel, NEUTRAL_AGENT_PROMPT)) };
  console.log(`[teleagent] 内核提示词：中性兜底 · ${kernelInfo.promptChars} 字符 · 校验 ${kernelInfo.verified === true ? '通过' : kernelInfo.verified === null ? '不可读' : '未通过'}`);
} else {
  console.warn('[teleagent] 跳过内核预启动（未登录）——管理台登录完成后将自动拉起。');
}

const bridge = await createToolBridge({ kernel });

/**
 * 按客户端切换 kernel 的 agent prompt。
 *
 * kernel 内置的系统提示词把模型钉死成「星辰超级智能体」，对话里怎么声明自己是 Codex 都没用
 * （实测会被拒绝）。唯一生效的办法是启动时用 `agent.build.prompt` 替换它，
 * 所以这里按「客户端类型 + 提示词指纹」维护一个当前 kernel：变了就换内核。
 */
let kernelKey = 'default';
let resetSessions = () => {};

/** 最近一次请求想用的 key/prompt：看门狗复活内核时要照着原样起。 */
let lastAsk = { key: 'default', prompt: null };
/** 切换必须串行：并发请求各自 close 会杀掉对方正在预热的内核。 */
let switchChain = Promise.resolve();

/**
 * 内核进程是否已经不在了。
 *
 * 进程被 TerminateProcess 掉（`proc.kill()`）时 JS 对象仍在、`call()` 也还在，
 * 只是每一次请求都会毫秒级 `fetch failed`。所以「同 key 直接复用」必须加存活判断。
 */
function kernelDead() {
  return !kernel?.proc || kernel.proc.exitCode !== null;
}

/**
 * 起一个新内核并换下旧的。
 *
 * 顺序是「先起新的、等 ready、再关旧的」。旧实现先 `close()` 再 `startKernel()`，
 * 新内核一旦起不来（端口冲突 / 二进制被占用 / DB 初始化失败），代理就被钉死在
 * 一个已关闭的端口上，且因为 key 没变永远等不到重启——2026-11-20 18:19 那次
 * 「重试不到 3 秒就 fetch failed、怎么重试都不行」就是这么来的。
 */
async function spawnAndSwap({ key, prompt, reason }) {
  const client = key.split(':')[0];
  const next = await startKernel({ runtimeRoot, auth: authState, catalog, agentPrompt: prompt });
  try {
    await next.waitReady({ timeoutMs: 90000 });
  } catch (err) {
    try {
      next.close();
    } catch {}
    throw new Error(`新内核未就绪：${err.message}`);
  }
  const prev = kernel;
  kernel = next;
  kernelKey = key;
  kernelInfo = { client, ...(await verifyKernelPrompt(next, prompt)) };
  if (prev && prev !== next) {
    try {
      prev.close();
    } catch {}
  }
  bridge.attach(next);
  resetSessions();
  console.log(
    `[teleagent] 内核已就绪：${client} · ${kernelInfo.promptChars} 字符 · ${next.origin} · 校验 ${
      kernelInfo.verified === true ? '通过' : kernelInfo.verified === null ? '不可读' : '未通过'
    }${reason ? ` · ${reason}` : ''}`,
  );
  return next;
}

/**
 * 凭据更新后的强制换核（走与提示词切换相同的串行链）。
 * startKernel 在被调用那一刻才读取 authState，所以「先改 authState.token 再 forceRestart」即可生效。
 */
function forceRestartKernel(reason) {
  if (bridge.hasCalls()) throw new Error('工具调用挂起中，已推迟内核重启');
  const run = () => spawnAndSwap({ key: lastAsk.key || kernelKey, prompt: lastAsk.prompt ?? null, reason });
  const task = switchChain.then(run, run);
  switchChain = task.catch(() => {});
  return task;
}

async function getKernel({ key, prompt }) {
  lastAsk = { key, prompt };
  if (key === kernelKey && !kernelDead()) return kernel;
  if (bridge.hasCalls()) return kernel; // 工具循环进行中，先不换，避免打断挂起调用
  const reason = kernelDead()
    ? `原内核已退出，自动重启（${kernelKey.split(':')[0]}）`
    : `切换提示词 ${kernelKey.split(':')[0]} → ${key.split(':')[0]}`;
  const run = async () => {
    if (key === kernelKey && !kernelDead()) return kernel;
    try {
      return await spawnAndSwap({ key, prompt, reason });
    } catch (err) {
      console.error(`[teleagent] 内核启动失败：${err.message}`);
      if (!kernelDead()) return kernel; // 旧内核还活着就别动它
      throw err;
    }
  };
  const task = switchChain.then(run, run);
  switchChain = task.catch(() => {});
  return task;
}

/**
 * 看门狗：空闲时内核死了也要自己起来。
 *
 * NAS 无人值守的前提——不能指望用户在报错后手动「换个提示词」把内核顶起来。
 */
let watchdogRunning = false;
const watchdogMs = Number(process.env.TA_WATCHDOG_MS || 15000);
const watchdog = setInterval(async () => {
  if (watchdogRunning || closing || !authState.token || !kernelDead()) return;
  if (bridge.hasCalls()) return; // 工具调用挂起中，重启会把它彻底打断
  watchdogRunning = true;
  try {
    console.warn('[teleagent] 看门狗：内核进程已退出，正在自动重启…');
    await getKernel({ key: lastAsk.key, prompt: lastAsk.prompt });
  } catch (err) {
    console.error(`[teleagent] 看门狗重启失败：${err.message}（${Math.round(watchdogMs / 1000)}s 后重试）`);
  } finally {
    watchdogRunning = false;
  }
}, watchdogMs);
watchdog.unref?.();

/* ----------------------------------------------------------------
 * 凭据续期（官方 token-refresh 协议复刻）—— NAS 7×24 自给自足的核心。
 * 有 token 才轮询；换发成功后落库 + 热替换 authState + 换核。
 * 节奏与桌面端一致：启动补偿 + 每 6h，同一自然日只尝试一次。
 * 完全禁用：设 TA_RENEW_INTERVAL_MS=0。
 * ---------------------------------------------------------------- */
let authStatus = {
  source: authSource,
  generation: storedCredentials?.generation ?? (auth?.token ? 1 : 0),
  tokenExpiresAt: storedCredentials?.tokenExpiresAt ?? (auth?.claims?.exp ? auth.claims.exp * 1000 : null),
  absoluteExpiresAt: storedCredentials?.absoluteExpiresAt ?? null,
  lastAttempt: null,
  needLogin: authState.token ? null : '尚未登录',
};

/**
 * 换发会话 Cookie 对（operToken/operationToken）——2026-11-20 实证：只发 X-Token 不带这对
 * Cookie 会被服务器判 40115 session_not_found（桌面端 Electron net.fetch 自动携带）。
 * 优先级：自管库（NAS 主通道）> 桌面端 partition Cookies 库（PC 兼容通道，每次重读——
 * 桌面版每次换发都会刷新它）。读到后回写自管库，PC 下次启动不再依赖 partition。
 */
let cookiesCache = storedCredentials?.cookies ?? null;
async function cookieForRenewal() {
  if (cookiesCache?.operToken || cookiesCache?.operationToken) return cookiesCache;
  try {
    const owner = resolveOwner();
    const fromDb = await readPlatformCookies({ deviceDataRoot: DEVICE_DATA_ROOT, ownerDir: owner.ownerDir });
    if (fromDb) {
      cookiesCache = fromDb;
      saveCredentialStore(runtimeRoot, { cookies: fromDb });
      console.log('[teleagent] 已从桌面端 partition 读取平台 Cookie 对（换发会话要素）');
      return fromDb;
    }
  } catch {
    // 未登录桌面通道（NAS）或读取失败：静默降级，换发仍会尝试（可能 40115）
  }
  return null;
}

const renewal = startRenewalLoop({
  runtimeRoot,
  deviceId: authState.deviceId,
  getToken: () => authState.token,
  getCookies: cookieForRenewal,
  onRenewed: ({ token, expiresIn, absoluteExpiresAt, generation }) => {
    authState.token = token; // startKernel 被调用时才读 authState → 之后任何 spawn/换核都带上新 token
    cookiesCache = loadCredentialStore(runtimeRoot)?.cookies ?? cookiesCache;
    authStatus = {
      ...authStatus,
      source: 'credentials',
      generation,
      tokenExpiresAt: expiresIn ? Date.now() + expiresIn * 1000 : authStatus.tokenExpiresAt,
      absoluteExpiresAt,
      needLogin: null,
    };
    if (bridge.hasCalls()) {
      console.warn('[teleagent] 凭据已续期，但工具调用挂起中——内核将在下次请求或看门狗周期换核生效');
      return;
    }
    forceRestartKernel('凭据已续期，换核加载新 token').catch((err) => {
      console.error(`[teleagent] 续期后换核失败：${err.message}`);
    });
  },
  onNeedLogin: (reason) => {
    authStatus = { ...authStatus, needLogin: reason };
  },
  onAttempt: (r) => {
    authStatus = { ...authStatus, lastAttempt: r };
  },
});

/** 管理台登录：接收登录页回跳网址（iframe postMessage 或手工粘贴），提取 token → 落库 → 换核。 */
async function handleAdminLogin(rawUrl) {
  const extracted = extractLoginResult(rawUrl);
  if (!extracted.ok) {
    return { ok: false, error: '这不是登录回跳网址：应包含 /cowork/auth 路径与 code/token 参数' };
  }
  if (!extracted.token) {
    return { ok: false, error: '回跳网址缺少 token 参数（只有 code）。请复制登录完成后浏览器地址栏的完整网址再试。' };
  }
  const next = saveCredentialStore(runtimeRoot, {
    token: extracted.token,
    tokenIssuedAt: Date.now(),
    tokenExpiresAt: jwtExpiresAt(extracted.token),
    absoluteExpiresAt: null,
    generation: (storedCredentials?.generation ?? 0) + 1,
    source: 'login',
    lastAttemptDay: '',
  });
  storedCredentials = next;
  authState.token = extracted.token;
  authSource = 'credentials';
  authStatus = {
    source: 'credentials',
    generation: next.generation,
    tokenExpiresAt: next.tokenExpiresAt,
    absoluteExpiresAt: null,
    lastAttempt: null,
    needLogin: null,
  };
  await forceRestartKernel('管理台登录成功，拉起内核');
  console.log(
    `[teleagent] 登录成功：generation=${next.generation} · token 到期 ${
      next.tokenExpiresAt ? new Date(next.tokenExpiresAt).toLocaleString() : '未知'
    }`,
  );
  return {
    ok: true,
    generation: next.generation,
    tokenExpiresAt: next.tokenExpiresAt,
    // iframe 登录拿不到跨域 Cookie——换发还需要这对 Cookie，否则下次续期会 40115
    cookieHint: cookiesCache?.operToken || cookiesCache?.operationToken
      ? null
      : '换发还需要平台 Cookie 对：请在浏览器登录页按 F12 → Network → 任选一个 teleai.com.cn 请求 → 复制请求头里的完整 Cookie，粘贴到管理台「导入 Cookie」框',
  };
}

/** 管理台导入 Cookie 对：粘贴浏览器登录页的 Cookie 头（operToken=...; operationToken=...）。 */
function parseCookieHeader(raw) {
  const out = {};
  for (const part of String(raw).split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if ((name === 'operToken' || name === 'operationToken') && value) out[name] = value;
  }
  return out;
}
function handleCookieImport(raw) {
  const parsed = parseCookieHeader(raw);
  if (!parsed.operToken && !parsed.operationToken) {
    return {
      ok: false,
      error: '未找到 operToken / operationToken：请在登录页（teleai.com.cn 域）的请求头里复制完整 Cookie 再试',
    };
  }
  cookiesCache = { ...(cookiesCache ?? {}), ...parsed };
  const next = saveCredentialStore(runtimeRoot, { cookies: cookiesCache });
  storedCredentials = next;
  return { ok: true, imported: Object.keys(parsed), cookies: cookieStatus() };
}
function cookieStatus() {
  return {
    operToken: Boolean(cookiesCache?.operToken),
    operationToken: Boolean(cookiesCache?.operationToken),
    source: cookiesCache ? 'store' : null,
  };
}

const shim = await createShim({
  getKernel,
  kernelStatus: () => ({ origin: kernel?.origin ?? null, ...kernelInfo }),
  bridge,
  models,
  apiKey: process.env.TA_API_KEY || null,
  keystore,
  adminToken,
  host: process.env.TA_HOST || '127.0.0.1',
  authApi: {
    status: () => ({
      ...authStatus,
      renewal: renewal.status(),
      hasToken: Boolean(authState.token),
      // deviceId/installId 是设备标识不是凭据，管理台展示用
      deviceId: authState.deviceId,
      installId: authState.installId,
      // 换发会话 Cookie 对的存在性（不回显值）：NAS 判断「能否自续期」的关键指标
      platformCookies: cookieStatus(),
      // 官方登录页地址：环境变量 TA_LOGIN_PAGE_URL 配置（见 docker/DEPLOY-GUIDE.md）。
      // 未配置时管理台仍可用「粘贴回跳网址」通道完成登录。
      loginPageUrl: process.env.TA_LOGIN_PAGE_URL || null,
    }),
    login: handleAdminLogin,
    setCookies: handleCookieImport,
    renew: () => renewal.tick(true),
  },
  port: Number(process.env.TA_PORT || 8787),
});
resetSessions = () => {
  shim.resetSessions();
  resetResponsesSessions();
};

console.log(`[teleagent] OpenAI 兼容端点: ${shim.url}`);
console.log(`[teleagent] 模型: ${models.map((m) => m.id).join(', ')}`);
if (process.env.TA_API_KEY) console.log('[teleagent] 已启用 Bearer 校验（环境变量 TA_API_KEY）');
const keyStats = keystore.stats();
console.log(`[teleagent] API 密钥: ${keyStats.activeKeys} 启用 / ${keyStats.totalKeys} 总数 · ${keystore.file}`);
console.log(`[teleagent] 管理台: http://127.0.0.1:${shim.port}/admin${adminToken ? '（需要 TA_ADMIN_TOKEN）' : ''}`);
// start.cmd 会带上 TA_OPEN_ADMIN=1：服务就绪后自动打开管理台
if (process.env.TA_OPEN_ADMIN === '1') {
  const adminUrl = `http://127.0.0.1:${shim.port}/admin`;
  try {
    const child =
      process.platform === 'win32'
        ? spawn('cmd', ['/c', 'start', '', adminUrl], { windowsHide: true, stdio: 'ignore' })
        : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [adminUrl], { stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {}
}

if (!keystore.required(process.env.TA_API_KEY || null)) {
  console.log('[teleagent] 提示: 当前未开启鉴权，本机任意程序都可调用。可在管理台新建密钥或把鉴权设为「强制校验」。');
}

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  clearInterval(watchdog);
  console.log('\n[teleagent] 正在关闭…');
  keystore.flush();
  await shim.close();
  await bridge.close().catch(() => {});
  kernel.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  try {
    keystore.flush();
  } catch {}
  kernel.close();
});

