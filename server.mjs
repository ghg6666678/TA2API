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
import { resolveOwner, accountDir, tokenFile, readJson, kernelVersion, ensureTeleAgentLayout, LOCAL_STATE_FILE } from './lib/paths.mjs';
import { loadAuthState, deviceMeta, parseJwt } from './lib/auth.mjs';
import {
  ensureDeviceIdentity,
  loadCredentialStore,
  saveCredentialStore,
  extractLoginResult,
  exchangeCodeForToken,
  jwtExpiresAt,
  tokenIat,
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
  console.error('请先安装并登录 TeleAgent 桌面端（至少打开过一次对话）。');
  process.exit(1);
}
if (missing.length > fatalMissing.length) {
  console.warn('[teleagent] 无桌面端 Local State：DPAPI 通道不可用，将依赖凭据库或管理台登录。');
}

const owner = resolveOwner();
const runtimeRoot = path.join(here, 'runtime');

// 登录入口 = 官方网页版登录页。
//
// 为什么不走桌面端的 OAuth 直链（.../cowork/auth?source=01）：
//   那条链授权完成后停在回执页 .../cowork/auth?appVersion=&code=ucc.…，
//   页面会立刻尝试唤起 teleagent:// 客户端，且 code 在浏览器加载那一刻就被消费，
//   既来不及复制、复制来也换不出 token（2026-11-21 三次实测均为 400 get token error）。
//
// 现在的主通道是「用 Cookie 登录」：网页版登录完成后浏览器里会有
//   operToken + operationToken（= `<tenant>:<accessToken>`，其中 accessToken 与凭据库的
//   token 逐字节相同），把它粘贴进管理台即可同时完成「登录 + 续期凭据导入」。
// 网页版登录页登录后会进 https://agent.teleai.com.cn/teleagent —— 这是预期行为，Cookie 已生成。
//
// TA_LOGIN_PAGE_URL 可覆盖（官方改域名时用）。
const DEFAULT_LOGIN_PAGE_URL = 'https://agent.teleai.com.cn/meter/teleagent-login/login';

// 凭据来源：桌面版登录态（dpapi）为权威——桌面版每次换发都会重写 token.json，
// 下面的跟随 watcher 检测到变化就热换核。自管换发已移除（服务端只认官方客户端，
// 第三方进程一律 40115，见 docs/nas-docker.md）。

// 凭据来源优先级：桌面版 token.json（dpapi）> 自管凭据库（管理台粘 Cookie 登录写入的）。
// store.json 里的 token 在桌面版换发后会滞后，不能遮蔽 dpapi 这条权威来源；
// 两者皆无也允许启动——管理台登录后即可拉起内核。
const device = ensureDeviceIdentity(runtimeRoot, deviceMeta());
let storedCredentials = loadCredentialStore(runtimeRoot);
let auth = null;
let authSource = 'none';
async function loadPrimaryAuth() {
  try {
    const a = await loadAuthState({ tokenFile: tokenFile(owner) });
    if (a?.token) return { auth: a, source: 'dpapi' };
  } catch (err) {
    console.warn(`[teleagent] 桌面版登录态不可用（${err.message}），回退自管凭据库`);
  }
  if (storedCredentials?.token) {
    return {
      auth: { token: storedCredentials.token, tenant: '', claims: parseJwt(storedCredentials.token) },
      source: 'credentials',
    };
  }
  return { auth: null, source: 'none' };
}
({ auth, source: authSource } = await loadPrimaryAuth());
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

console.log(
  `[teleagent] 账号 ${auth?.claims?.accountName ?? '?'} · kernel ${kernelVersion()} · 凭据来源 ${authSource}`,
);

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
  const p = kernel?.proc;
  if (!p) return true;
  // 注意：被信号杀死（SIGKILL/SIGSEGV，Linux 容器里 OOM 常见）时 Node 只设
  // `signalCode`，`exitCode` 仍为 null。只看 exitCode 会把死进程当活的，
  // 于是看门狗不触发、请求全部毫秒级 fetch failed（2026-11-21 Docker 实测）。
  return p.exitCode !== null || p.signalCode != null;
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
  // 未登录（刚启动 / 管理台退出登录后）时别去起一个没有凭据的内核——
  // 那样只会拿上游的 40108 invalid token 当答案，看不出真正原因。
  if (!authState.token) {
    const err = new Error('尚未登录：请在管理台 /admin 点「登录账号」完成一次登录');
    err.status = 401;
    err.code = 'need_login';
    throw err;
  }
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
 * 登录态（管理台「登录态」面板读这里）。
 * token 由桌面版刷新，本进程只跟随（followDesktopToken）；自管换发已移除，
 * 原因见 docs/nas-docker.md：服务端只认官方桌面客户端，第三方进程一律 40115。
 * ---------------------------------------------------------------- */
let authStatus = {
  source: authSource,
  generation: storedCredentials?.generation ?? (auth?.token ? 1 : 0),
  tokenExpiresAt: storedCredentials?.tokenExpiresAt ?? (auth?.claims?.exp ? auth.claims.exp * 1000 : null),
  absoluteExpiresAt: storedCredentials?.absoluteExpiresAt ?? null,
  needLogin: authState.token ? null : '尚未登录',
};

// 平台 Cookie 对（operToken/operationToken）：只作登录通道的副产品保存与展示，
// 不再参与任何换发（换发能力已移除）。
let cookiesCache = storedCredentials?.cookies ?? null;

/* ----------------------------------------------------------------
 * 跟随 watcher：桌面版每次换发成功都会重写 token.json，
 * watcher 定期对比文件指纹；变化才走 DPAPI 解密并按 JWT iat 比较——
 * 「谁新用谁」：管理台刚登录的新 token（iat 更大）不会被桌面版旧 token 覆盖。
 * 采用后热换核（与用户手动重启反代等效，但无感）。
 * ---------------------------------------------------------------- */
let followedFingerprint = null;
async function followDesktopToken() {
  const tf = tokenFile(owner);
  const obj = readJson(tf, null);
  const fp = obj ? crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex').slice(0, 16) : null;
  if (followedFingerprint === null) {
    followedFingerprint = fp; // 首轮只记基线，不触发换核
    return false;
  }
  if (fp === followedFingerprint) return false;
  followedFingerprint = fp;
  try {
    const a = await loadAuthState({ tokenFile: tf });
    if (!a?.token || a.token === authState.token) return false;
    const newIat = tokenIat(a.token);
    const curIat = tokenIat(authState.token);
    if (newIat != null && curIat != null && newIat <= curIat) {
      console.log('[teleagent] 桌面版 token.json 已变化，但代际不新于当前 token，跳过');
      return false;
    }
    authState.token = a.token;
    authSource = 'dpapi';
    authStatus = {
      ...authStatus,
      source: 'dpapi',
      tokenExpiresAt: jwtExpiresAt(a.token),
      needLogin: null,
      followedAt: Date.now(),
    };
    console.log(
      `[teleagent] 跟随桌面版换发：token 已更新（iat ${curIat ? new Date(curIat).toLocaleTimeString() : '?'} → ${new Date(newIat).toLocaleTimeString()}）`,
    );
    if (bridge.hasCalls()) {
      console.warn('[teleagent] 工具调用挂起中——内核将在下次请求或看门狗周期换核生效');
      return true;
    }
    forceRestartKernel('桌面版 token 已更新，跟随换核').catch((err) => {
      console.error(`[teleagent] 跟随换核失败：${err.message}`);
    });
    return true;
  } catch (err) {
    console.warn(`[teleagent] 跟随桌面版 token 失败：${err.message}`);
    return false;
  }
}
const follower = setInterval(() => {
  followDesktopToken().catch(() => {});
}, Math.max(30_000, Number(process.env.TA_FOLLOW_INTERVAL_MS || 60_000)));
follower.unref?.();

/**
 * 管理台登录：接收登录回跳网址，提取 token → 落库 → 换核。
 *
 * 浏览器拿到的回执常常**只有 code 没有 token**（服务端把签发那一跳交给桌面客户端）。
 * 此时按桌面端身份自己请求一次回执地址，逐跳找 token——见 exchangeCodeForToken。
 */
async function applyLoginToken(token, { via = 'login' } = {}) {
  const next = saveCredentialStore(runtimeRoot, {
    token,
    tokenIssuedAt: Date.now(),
    tokenExpiresAt: jwtExpiresAt(token),
    absoluteExpiresAt: null,
    generation: (storedCredentials?.generation ?? 0) + 1,
    source: via,
    lastAttemptDay: '',
  });
  storedCredentials = next;
  authState.token = token;
  authSource = 'credentials';
  authStatus = {
    source: 'credentials',
    generation: next.generation,
    tokenExpiresAt: next.tokenExpiresAt,
    absoluteExpiresAt: null,
    lastAttempt: null,
    needLogin: null,
  };
  await forceRestartKernel(`token 已更新（${via}），拉起内核`);
  console.log(
    `[teleagent] ${via} 成功：generation=${next.generation} · token 到期 ${
      next.tokenExpiresAt ? new Date(next.tokenExpiresAt).toLocaleString() : '未知'
    }`,
  );
  return next;
}

async function handleAdminLogin(rawUrl) {
  const extracted = extractLoginResult(rawUrl);
  if (!extracted.ok) {
    return { ok: false, error: '这不是登录回跳网址：应包含 /cowork/auth 路径与 code/token 参数' };
  }
  if (!extracted.token) {
    console.log('[teleagent] 回执只有 code，按桌面端身份尝试换取 token…');
    const ex = await exchangeCodeForToken(rawUrl, {
      deviceId: authState.deviceId,
      appVersion: kernelVersion() || '',
      osType: process.platform === 'win32' ? 'Windows' : process.platform === 'darwin' ? 'macOS' : process.platform,
    });
    if (!ex.ok) {
      return {
        ok: false,
        error:
          `回执里只有 code，反代按桌面端身份换取 token 失败（${ex.reason}）` +
          (ex.detail ? `：${ex.detail}` : '') +
          '。该 code 很可能已被浏览器那次访问消费掉——请在登录授权后不要等待页面加载，' +
          '立刻复制地址栏网址（或在新窗口登录后直接复制，不要刷新）。',
      };
    }
    console.log(`[teleagent] 用 code 换到 token（via ${ex.via}${ex.hops ? ` / ${ex.hops} 跳` : ''}）`);
    extracted.token = ex.token;
  }
  const next = await applyLoginToken(extracted.token, { via: 'login' });
  return {
    ok: true,
    generation: next.generation,
    tokenExpiresAt: next.tokenExpiresAt,
  };
}

/**
 * 管理台退出登录：清空 token（保留 Cookie 对），停掉内核，回到「待登录」态。
 *
 * 用途：① 验证登录流程是否真能走通（不必先手工删文件）；② 换账号；
 * ③ 凭据异常时重置到干净状态。Cookie 对保留是因为它属于浏览器会话，
 * 换 token 时仍可复用（重新登录后若失效，再导入一次即可）。
 */
function handleAdminLogout() {
  const had = Boolean(authState.token);
  if (bridge.hasCalls()) bridge.cancel('退出登录');
  authState.token = '';
  storedCredentials = saveCredentialStore(runtimeRoot, {
    token: '',
    tokenIssuedAt: 0,
    tokenExpiresAt: 0,
    absoluteExpiresAt: null,
    source: 'logged-out',
  });
  authSource = 'none';
  authStatus = {
    ...authStatus,
    source: 'none',
    tokenExpiresAt: null,
    absoluteExpiresAt: null,
    needLogin: '已退出登录：请用「登录账号」重新登录',
  };
  // 没有 token 时内核无法提供服务，留着只会让请求 401 并被看门狗反复重起
  try {
    kernel?.close();
  } catch {}
  kernel = null;
  kernelKey = 'default';
  kernelInfo = { client: 'default', promptChars: 0, promptSha: null, verified: null };
  resetSessions();
  console.log('[teleagent] 已退出登录：凭据已清空，内核已停机，等待重新登录');
  return { ok: true, hadToken: had, status: { ...authStatus, hasToken: false } };
}

/** 管理台导入 Cookie：粘贴 Cookie 头、整段请求头、或 Application 面板里的单个值都行。 */
function parseCookieHeader(raw) {
  const text = String(raw ?? '').trim();
  const out = {};
  if (!text) return out;
  for (const part of text.split(/[;\n\r]/)) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim().replace(/^"|"$/g, '');
    if ((name === 'operToken' || name === 'operationToken') && value) out[name] = value;
    // 整段请求头粘贴：Cookie: operToken=...
    if (name.toLowerCase() === 'cookie') {
      Object.assign(out, parseCookieHeader(value));
    }
  }
  if (out.operToken || out.operationToken) return out;
  // 裸值：<tenant>:<jwt> 是 operationToken；单独一段 JWT 视长度区分
  const bare = text.replace(/^"|"$/g, '');
  if (/^[^:\s]+:eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(bare)) out.operationToken = bare;
  else if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(bare)) {
    if (bare.length >= 400) out.operationToken = bare; // accessToken 裸用，tenant 前缀缺失时下面兜底
    else out.operToken = bare;
  }
  return out;
}

/**
 * operationToken = `<tenant>:<accessToken>`，而 accessToken 与凭据库里的 token 完全一致
 * （2026-11-21 实测：639 字节逐字节相同）。因此只要拿到 operationToken 就等于拿到可用 token，
 * 不需要 OAuth code——这是 NAS 上唯一可行的登录通道。
 */
function accessTokenFromCookies(cookies) {
  const opt = cookies?.operationToken;
  if (!opt) return null;
  const i = opt.indexOf(':');
  const acc = i > 0 ? opt.slice(i + 1) : opt;
  return acc.startsWith('eyJ') && acc.split('.').length === 3 ? acc : null;
}

async function handleCookieImport(raw) {
  const parsed = parseCookieHeader(raw);
  const token = accessTokenFromCookies(parsed);
  if (!parsed.operToken && !parsed.operationToken) {
    return {
      ok: false,
      error:
        '未识别出 operToken / operationToken。可以粘贴三种形式之一：① 完整 Cookie 头（operationToken=xxx; operToken=yyy）' +
        '② F12 → Application → Cookies 里 operationToken 的整段值（形如 Em9xR4:eyJ…）③ 只有 access token 的 JWT。',
    };
  }
  cookiesCache = { ...(cookiesCache ?? {}), ...parsed };
  storedCredentials = saveCredentialStore(runtimeRoot, { cookies: cookiesCache });
  if (!token) {
    return {
      ok: true,
      imported: Object.keys(parsed),
      login: false,
      cookies: cookieStatus(),
      message:
        '已保存 Cookie 用于自动续期，但没能从中解析出 token。' +
        '请确认粘贴的是 operationToken 的完整值（带 `<租户>:<token>` 前缀）。',
    };
  }
  const next = await applyLoginToken(token, { via: 'cookie' });
  return {
    ok: true,
    imported: Object.keys(parsed),
    login: true,
    generation: next.generation,
    tokenExpiresAt: next.tokenExpiresAt,
    cookies: cookieStatus(),
  };
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
      hasToken: Boolean(authState.token),
      // deviceId/installId 是设备标识不是凭据，管理台展示用
      deviceId: authState.deviceId,
      installId: authState.installId,
      // 换发会话 Cookie 对的存在性（不回显值）：NAS 判断「能否自续期」的关键指标
      platformCookies: cookieStatus(),
      // 官方登录页地址：内置默认值，TA_LOGIN_PAGE_URL 可覆盖（官方换域名时无需改代码）。
      loginPageUrl: process.env.TA_LOGIN_PAGE_URL || DEFAULT_LOGIN_PAGE_URL,
    }),
    login: handleAdminLogin,
    logout: handleAdminLogout,
    setCookies: handleCookieImport,
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

