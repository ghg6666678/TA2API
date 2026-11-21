// 管理台：/admin 静态页 + /admin/api/* 管理接口
//
// 安全约束：
//   1. 只接受回环地址（服务本身也只绑 127.0.0.1，这里是第二道闸）
//   2. 设了 TA_ADMIN_TOKEN 时，所有管理接口都要带 token（Authorization / x-admin-token / ?token=）
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const ADMIN_HTML = path.join(here, '..', 'web', 'admin.html');

function json(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

async function readJsonBody(req) {
  const raw = await readBody(req);
  if (!raw.trim()) return {};
  return JSON.parse(raw);
}

/**
 * 远程访问未带令牌时的提示页（NAS 场景）：返回一个输入框而不是裸 JSON。
 * 提交后 ?token=xxx 随 URL 带上，服务端校验通过即进入管理台。
 */
const TOKEN_PROMPT_HTML = `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>管理台 · 需要令牌</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
         font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif;
         background:#f6f7f9; color:#1b1d21; }
  @media (prefers-color-scheme: dark) { body { background:#14161a; color:#e6e8ec; } }
  .box { width:min(420px,92vw); padding:28px; border-radius:16px; background:#fff;
         box-shadow:0 8px 32px rgba(0,0,0,.10); }
  @media (prefers-color-scheme: dark) { .box { background:#1c1f25; box-shadow:0 8px 32px rgba(0,0,0,.5); } }
  h1 { margin:0 0 6px; font-size:17px; }
  p { margin:0 0 16px; font-size:13px; opacity:.72; }
  input { width:100%; box-sizing:border-box; padding:10px 12px; border-radius:10px;
          border:1px solid rgba(128,128,128,.45); background:transparent; color:inherit;
          font:13px/1.4 ui-monospace,Consolas,monospace; }
  button { width:100%; margin-top:12px; padding:10px; border:0; border-radius:10px;
           background:#2f6feb; color:#fff; font-size:14px; cursor:pointer; }
  button:hover { background:#2860cf; }
  code { font:12px ui-monospace,Consolas,monospace; }
  .tip { margin-top:14px; font-size:12px; opacity:.6; }
</style>
<form class="box" method="get" action="">
  <h1>需要管理令牌</h1>
  <p>这个管理台不是从本机打开的，服务端要求携带 <code>TA_ADMIN_TOKEN</code>。</p>
  <input name="token" type="password" placeholder="粘贴管理令牌" autocomplete="current-password" autofocus>
  <button type="submit">进入管理台</button>
  <p class="tip">若提示「远程访问未开启」，请在服务端设置 <code>TA_ADMIN_ALLOW_REMOTE=1</code> 与
  <code>TA_ADMIN_TOKEN</code> 后重启容器；只想本机访问则改绑 <code>127.0.0.1:8787:8787</code>
  并设置 <code>TA_ADMIN_LOCAL_ONLY=1</code>。</p>
</form>
</html>`;

function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

/**
 * 容器里「宿主的 127.0.0.1」和「局域网另一台机器」在 socket 层是同一个东西
 * （都表现为网桥网关地址，如 172.17.0.1），没法靠 IP 分辨。
 *
 * 所以给一个显式声明：TA_ADMIN_LOCAL_ONLY=1 表示「这个端口只绑在宿主回环上，
 * 能连上来的必然是操作者本人」——此时跳过来源检查（等价本机）。
 * 前提是端口绑定写成「回环:端口」（如 `127.0.0.1:8787:8787`），两者必须成对使用。
 * 绑定 0.0.0.0 时不要开这个开关，否则局域网任何人都能无令牌打开管理台。
 */
function adminLocalOnly() {
  return process.env.TA_ADMIN_LOCAL_ONLY === '1';
}

function tokenOf(req) {
  const auth = req.headers.authorization ?? '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  const header = req.headers['x-admin-token'];
  if (header) return String(header).trim();
  const url = new URL(req.url, 'http://127.0.0.1');
  return url.searchParams.get('token') ?? '';
}

/**
 * @param {object} args
 * @param {import('./keystore.mjs').KeyStore} args.keystore
 * @param {() => object} args.info 网关状态（地址、模型、kernel、鉴权模式）
 * @param {string|null} args.adminToken
 */
export function createAdmin({ keystore, info, adminToken = null, authApi = null }) {
  let html = null;
  try {
    html = fs.readFileSync(ADMIN_HTML, 'utf8');
  } catch {
    html = '<!doctype html><meta charset="utf-8"><h1>管理页缺失</h1><p>找不到 web/admin.html</p>';
  }
  const snapshot = () => ({
    gateway: info(),
    settings: keystore.settings,
    stats: keystore.stats(),
    keys: keystore.list(),
  });

  return async function handleAdmin(req, res, pathname) {
    // 远程访问（NAS 局域网）需同时满足：TA_ADMIN_ALLOW_REMOTE=1 + 已设 TA_ADMIN_TOKEN + 请求带对令牌；
    // 未设令牌时保持「仅本机」的旧约束不变。远程模式下页面与接口都要求令牌（?token= 即可打开页面）。
    const remoteAllowed = process.env.TA_ADMIN_ALLOW_REMOTE === '1' && adminToken != null;
    const isApi = pathname.startsWith('/admin/api/');
    // 本机模式（容器 + 端口只绑宿主回环）：来源不可区分，按本机放行，页面与接口都免令牌
    const localOnly = adminLocalOnly();
    if (!localOnly && !isLoopback(req)) {
      if (!remoteAllowed || tokenOf(req) !== adminToken) {
        if (!isApi) {
          // 页面：给令牌输入页（NAS 上从另一台设备打开时不再是一片 JSON 错误）
          res.writeHead(403, {
            'content-type': 'text/html; charset=utf-8',
            'cache-control': 'no-store',
            'content-length': Buffer.byteLength(TOKEN_PROMPT_HTML),
          });
          res.end(TOKEN_PROMPT_HTML);
          return true;
        }
        json(res, 403, {
          error:
            '管理台仅允许本机访问；远程访问需 TA_ADMIN_ALLOW_REMOTE=1 且携带 TA_ADMIN_TOKEN（?token= 或 x-admin-token）。' +
            '若你是从宿主机浏览器访问容器，且端口仅绑定 127.0.0.1，可设 TA_ADMIN_LOCAL_ONLY=1 解除该限制。',
        });
        return true;
      }
    } else if (!localOnly && adminToken && isApi && tokenOf(req) !== adminToken) {
      json(res, 401, { error: '需要管理令牌', needToken: true });
      return true;
    }

    // ---- 页面 ----
    if (!isApi) {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-cache',
        'content-length': Buffer.byteLength(html),
      });
      res.end(html);
      return true;
    }

    if (req.method === 'GET' && pathname === '/admin/api/state') {
      json(res, 200, snapshot());
      return true;
    }

    if (req.method === 'POST' && pathname === '/admin/api/keys') {
      const body = await readJsonBody(req).catch(() => null);
      if (!body) {
        json(res, 400, { error: '请求体不是合法 JSON' });
        return true;
      }
      const name = String(body.name ?? '').trim();
      const created = keystore.create({
        name,
        note: String(body.note ?? ''),
        count: body.count,
        expiresInDays: body.expiresInDays,
      });
      json(res, 200, { created, state: snapshot() });
      return true;
    }

    const bulkMatch = pathname.match(/^\/admin\/api\/keys\/bulk$/);
    if (bulkMatch && req.method === 'POST') {
      const body = await readJsonBody(req).catch(() => null);
      if (!body) {
        json(res, 400, { error: '请求体不是合法 JSON' });
        return true;
      }
      const ids = Array.isArray(body.ids) ? body.ids.filter((x) => typeof x === 'string') : [];
      if (!ids.length) {
        json(res, 400, { error: '未选择任何密钥' });
        return true;
      }
      const result = keystore.bulk(String(body.action ?? ''), ids);
      if (result.error) {
        json(res, 400, result);
        return true;
      }
      json(res, 200, { ...result, state: snapshot() });
      return true;
    }

    const oneMatch = pathname.match(/^\/admin\/api\/keys\/([A-Za-z0-9_-]+)$/);
    if (oneMatch) {
      const id = oneMatch[1];
      if (req.method === 'PATCH' || req.method === 'PUT') {
        const body = await readJsonBody(req).catch(() => null);
        if (!body) {
          json(res, 400, { error: '请求体不是合法 JSON' });
          return true;
        }
        const updated = keystore.update(id, body);
        if (!updated) {
          json(res, 404, { error: '密钥不存在' });
          return true;
        }
        json(res, 200, { state: snapshot() });
        return true;
      }
      if (req.method === 'DELETE') {
        const removed = keystore.remove([id]);
        if (!removed) {
          json(res, 404, { error: '密钥不存在' });
          return true;
        }
        json(res, 200, { removed, state: snapshot() });
        return true;
      }
    }

    if (req.method === 'POST' && pathname === '/admin/api/settings') {
      const body = await readJsonBody(req).catch(() => null);
      if (!body) {
        json(res, 400, { error: '请求体不是合法 JSON' });
        return true;
      }
      keystore.setSettings(body);
      json(res, 200, { state: snapshot() });
      return true;
    }

    // ---- 登录态（只读：token 由桌面版提供，管理台不做登录动作）----
    if (authApi && req.method === 'GET' && pathname === '/admin/api/auth') {
      json(res, 200, authApi.status());
      return true;
    }

    json(res, 404, { error: `not found: ${req.method} ${pathname}` });
    return true;
  };
}
