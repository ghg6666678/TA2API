/**
 * 换发请求的传输层特征对照（一次性诊断）。
 *
 * 已排除：token、Cookie（含新 jwtInfoId）、deviceId、UA、双客户端竞争。
 * 桌面版能成功、Node 不能，差异只剩请求的传输层特征。
 *
 * 用法：node docker/probe2-renew.mjs
 * 注意：会真实调用换发接口。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const dir = path.join(import.meta.dirname, 'data/runtime/credentials');
const store = JSON.parse(fs.readFileSync(path.join(dir, 'store.json'), 'utf8'));
const device = JSON.parse(fs.readFileSync(path.join(dir, 'device.json'), 'utf8'));
const c = store.cookies ?? {};

const URL_ = 'https://agent.teleai.com.cn/superCowork/sapi/cowork/auth/token-refresh';
const cookieNormal = `operToken=${c.operToken}; operationToken=${c.operationToken}`;
const cookieReversed = `operationToken=${c.operationToken}; operToken=${c.operToken}`;

const base = () => ({
  'Content-Type': 'application/json',
  'X-Token': store.token,
  'X-Timestamp': Math.floor(Date.now() / 1000).toString(),
  'X-Nonce': crypto.randomUUID(),
  'X-App-Version': '3.1.1',
  'X-OS-Type': 'windows',
  'X-SuperAgent-Device-Id': device.deviceId,
});

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) TeleAgent/3.1.1 Chrome/128.0.6613.186 Electron/32.2.7 Safari/537.36';

const VARIANTS = [
  { name: '基线：仅六头 + Cookie', h: { Cookie: cookieNormal } },
  { name: '+ UA', h: { Cookie: cookieNormal, 'User-Agent': UA } },
  {
    name: '+ UA + Origin/Referer',
    h: {
      Cookie: cookieNormal,
      'User-Agent': UA,
      Origin: 'https://agent.teleai.com.cn',
      Referer: 'https://agent.teleai.com.cn/teleagent',
    },
  },
  {
    name: '+ UA + Accept 族 + Cookie 反序',
    h: {
      Cookie: cookieReversed,
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      'Accept-Language': 'zh-CN,zh;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
    },
  },
];

for (const v of VARIANTS) {
  const headers = { ...base(), ...v.h };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const res = await fetch(URL_, { method: 'POST', headers, body: '', signal: ctl.signal });
    const text = await res.text();
    let code = null;
    try {
      code = JSON.parse(text).code ?? null;
    } catch {}
    console.log(`[${v.name}] http=${res.status} code=${code ?? '-'} ${text.slice(0, 120)}`);
  } catch (err) {
    console.log(`[${v.name}] 失败：${err?.name} ${err?.message}`);
  } finally {
    clearTimeout(timer);
  }
  await new Promise((r) => setTimeout(r, 600));
}
