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

function isLoopback(req) {
  const addr = req.socket?.remoteAddress ?? '';
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
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
    if (!isLoopback(req)) {
      if (!remoteAllowed || tokenOf(req) !== adminToken) {
        json(res, 403, {
          error:
            '管理台仅允许本机访问；远程访问需 TA_ADMIN_ALLOW_REMOTE=1 且携带 TA_ADMIN_TOKEN（?token= 或 x-admin-token）',
        });
        return true;
      }
    } else if (adminToken && isApi && tokenOf(req) !== adminToken) {
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

    // ---- 登录态 / 自动续期（NAS 自给自足通道）----
    if (authApi && req.method === 'GET' && pathname === '/admin/api/auth') {
      json(res, 200, authApi.status());
      return true;
    }

    if (authApi && req.method === 'POST' && pathname === '/admin/api/auth/login') {
      const body = await readJsonBody(req).catch(() => null);
      if (!body || typeof body.url !== 'string' || !body.url.trim()) {
        json(res, 400, { error: '缺少 url（登录页回跳网址）' });
        return true;
      }
      const result = await authApi.login(String(body.url).trim());
      json(res, result?.ok ? 200 : 400, result);
      return true;
    }

    if (authApi && req.method === 'POST' && pathname === '/admin/api/auth/cookies') {
      const body = await readJsonBody(req).catch(() => null);
      if (!body || typeof body.cookie !== 'string' || !body.cookie.trim()) {
        json(res, 400, { error: '缺少 cookie（浏览器登录页请求头里的完整 Cookie 字符串）' });
        return true;
      }
      const result = authApi.setCookies(String(body.cookie));
      json(res, result?.ok ? 200 : 400, result);
      return true;
    }

    if (authApi && req.method === 'POST' && pathname === '/admin/api/auth/renew') {
      json(res, 200, await authApi.renew());
      return true;
    }

    json(res, 404, { error: `not found: ${req.method} ${pathname}` });
    return true;
  };
}
