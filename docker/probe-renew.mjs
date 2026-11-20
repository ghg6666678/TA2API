/**
 * 换发请求的 UA / 指纹对照探测（一次性诊断，不参与构建）。
 *
 * 背景：官方客户端用 Electron 的 session.fetch() 发换发请求，天然带 Chromium 的
 * UA 与 sec-* 指纹；反代用 Node 的 fetch，默认没有 UA。若服务端按客户端身份
 * 分流，就会表现为「会话不存在（40115）」而不是签名错误。
 *
 * 用法：node docker/probe-renew.mjs
 * 说明：会真实调用换发接口。成功时服务端会轮转 token（这是判断依据本身）。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const storePath = process.argv[2] || path.join(import.meta.dirname, 'data/runtime/credentials/store.json');
const store = JSON.parse(fs.readFileSync(storePath, 'utf8'));
const token = store.token;
const cookies = store.cookies ?? {};
const cookieHeader = ['operToken', 'operationToken']
  .filter((k) => cookies[k])
  .map((k) => `${k}=${cookies[k]}`)
  .join('; ');
const device = JSON.parse(fs.readFileSync(path.join(path.dirname(storePath), 'device.json'), 'utf8'));
const deviceId = device.deviceId;

const URL_ = 'https://agent.teleai.com.cn/superCowork/sapi/cowork/auth/token-refresh';

const VARIANTS = [
  { name: '无 UA（当前实现）', ua: null },
  {
    name: 'Electron/TeleAgent UA',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) TeleAgent/3.1.1 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36',
  },
  {
    name: 'Chrome UA + sec-ch-ua',
    ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.6613.186 Safari/537.36',
    extra: {
      'sec-ch-ua': '"Chromium";v="128", "Not;A=Brand";v="24"',
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"Windows"',
      Accept: '*/*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
    },
  },
];

const base = {
  'Content-Type': 'application/json',
  'X-Token': token,
  'X-App-Version': '3.1.1',
  'X-OS-Type': 'windows',
  'X-SuperAgent-Device-Id': deviceId,
};
if (cookieHeader) base.Cookie = cookieHeader;

for (const v of VARIANTS) {
  const headers = { ...base, ...(v.extra ?? {}) };
  if (v.ua) headers['User-Agent'] = v.ua;
  headers['X-Timestamp'] = Math.floor(Date.now() / 1000).toString();
  headers['X-Nonce'] = crypto.randomUUID();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(URL_, { method: 'POST', headers, body: '', signal: ctl.signal });
    const text = await res.text();
    const setCookie = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie().length : 0;
    let code = null;
    try {
      const j = JSON.parse(text);
      code = j.code ?? j.responseCode ?? j.data?.code ?? null;
    } catch {}
    console.log(
      `[${v.name}] http=${res.status} code=${code ?? '-'} setCookie=${setCookie} body=${text.slice(0, 160)}`,
    );
  } catch (err) {
    console.log(`[${v.name}] 请求失败：${err?.name} ${err?.message}`);
  } finally {
    clearTimeout(timer);
  }
  await new Promise((r) => setTimeout(r, 800));
}
