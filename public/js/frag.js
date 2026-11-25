/**
 * frag.js — HTML 片段的同源地址
 *
 * 为什么不直接用 srcdoc：网关给页面加了 CSP `script-src 'self'`，
 * srcdoc 会继承父页面的 CSP，片段里的 <script> 会被直接拦掉，
 * 交互（hover 以外的点击、定时逻辑）全都失效。
 * 把片段 POST 到服务端换成同源地址后，iframe 不再继承页面 CSP。
 */

const cache = new Map();       // key -> url
const inflight = new Map();    // key -> Promise

function hash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36) + '_' + str.length.toString(36);
}

/** 返回可以直接塞进 iframe src 的相对地址 */
export async function fragUrl(html, css, js) {
  const key = hash(`${html || ''}\u0000${css || ''}\u0000${js || ''}`);
  if (cache.has(key)) return cache.get(key);
  if (inflight.has(key)) return inflight.get(key);

  const task = (async () => {
    try {
      const res = await fetch('api/frag', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ html, css, js }),
      });
      if (!res.ok) throw new Error(`fragment ${res.status}`);
      const data = await res.json();
      const url = data.url || `frag/${data.id}`;
      cache.set(key, url);
      return url;
    } catch {
      // 服务端不可用时退回 srcdoc 的等价物，至少样式还在
      const fallback = 'data:text/html;charset=utf-8,' + encodeURIComponent(
        `<!DOCTYPE html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}*{box-sizing:border-box}${css || ''}</style></head><body>${html || ''}</body></html>`,
      );
      cache.set(key, fallback);
      return fallback;
    } finally {
      inflight.delete(key);
    }
  })();

  inflight.set(key, task);
  return task;
}
