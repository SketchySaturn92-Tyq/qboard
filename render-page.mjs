#!/usr/bin/env node
/**
 * render-page.mjs — 用无头 Chrome（CDP）真渲染一个网页，抽出可读正文和链接。
 *
 * 用法：node render-page.mjs <url> [--scroll] [--wait 3000]
 * 输出：JSON { ok, url, title, text, links[], shots? }
 *
 * 为什么需要它：静态 HTML 抓取只能拿到初始骨架，
 * 单页应用、懒加载列表、需要滚动才出现的正文都读不到。
 */

import { spawn } from 'node:child_process';

const url = process.argv[2];
const doScroll = process.argv.includes('--scroll');
// canvas / WebGL 这类效果只有画面能说清楚，文字抓不到
const wantShot = process.argv.includes('--shot');
const waitIdx = process.argv.indexOf('--wait');
const waitMs = waitIdx > 0 ? Math.max(500, Number(process.argv[waitIdx + 1]) || 2600) : 2600;

if (!/^https?:\/\//i.test(url || '')) {
  console.log(JSON.stringify({ ok: false, error: 'BAD_URL' }));
  process.exit(0);
}

const PORT = 9600 + Math.floor(Math.random() * 300);
const CHROME = process.env.QB_CHROME || '/usr/bin/google-chrome';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let chrome;
try {
  chrome = spawn(CHROME, [
    '--headless=new', '--no-sandbox',
    /* 很多背景效果是 WebGL 画的。以前加了 --disable-gpu，
       canvas 一片黑，截出来的就是纯色 —— 等于没看到画面。
       这里改用 SwiftShader 软件渲染，无 GPU 也能出图。 */
    '--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
    '--disable-dev-shm-usage',
    '--hide-scrollbars', '--disable-background-timer-throttling',
    '--no-first-run', `--user-data-dir=/tmp/qb-render-${Date.now()}`,
    `--remote-debugging-port=${PORT}`, '--window-size=1440,900', 'about:blank',
  ], { stdio: 'ignore' });
} catch (e) {
  console.log(JSON.stringify({ ok: false, error: 'CHROME_LAUNCH_FAILED', message: e.message }));
  process.exit(0);
}

const fail = (code, msg) => {
  try { chrome.kill(); } catch { /* ignore */ }
  console.log(JSON.stringify({ ok: false, error: code, message: msg || '' }));
  process.exit(0);
};

// 兜底：无论发生什么都在 60 秒内给结果，避免把服务端挂住
const hardTimer = setTimeout(() => fail('TIMEOUT', '渲染超时'), 60000);
hardTimer.unref?.();

async function connect() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) {
        const j = await r.json();
        if (j.webSocketDebuggerUrl) return j.webSocketDebuggerUrl;
      }
    } catch { /* 还没起来 */ }
    await sleep(200);
  }
  return null;
}

const wsUrl = await connect();
if (!wsUrl) fail('CHROME_UNREACHABLE', '无头浏览器没启动起来');

let mid = 0;
const pending = new Map();
const ws = new WebSocket(wsUrl);
await new Promise((resolve) => ws.addEventListener('open', resolve, { once: true }));
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id);
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message || 'cdp error'));
    else p.resolve(m.result);
  }
});
const send = (method, params = {}, sessionId) => {
  const id = ++mid;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params, sessionId }));
  });
};

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
const { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Page.enable', {}, S);
await send('Runtime.enable', {}, S);
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }, S);

/* 在页面脚本跑起来之前挂个钩子，拦下站点写剪贴板的内容。
   有些站点的「Copy for AI」只在用户手势里写剪贴板，
   我们去读剪贴板经常拿到空；直接拦写入稳得多。 */
try {
  await send('Page.addScriptToEvaluateOnNewDocument', {
    source: `(() => {
      window.__qbCopied = [];
      const keep = (t) => {
        try {
          const s = String(t || '');
          if (s && window.__qbCopied[window.__qbCopied.length - 1] !== s) window.__qbCopied.push(s);
        } catch (e) {}
      };
      try {
        const clip = navigator.clipboard;
        if (clip && clip.writeText) {
          const orig = clip.writeText.bind(clip);
          navigator.clipboard.writeText = (t) => { keep(t); try { return orig(t); } catch (e) { return Promise.resolve(); } };
        }
      } catch (e) {}
      // 老式 execCommand('copy') 走选区
      document.addEventListener('copy', () => {
        try { const s = String(window.getSelection() || ''); if (s) keep(s); } catch (e) {}
      }, true);
    })();`,
  }, S);
} catch { /* 注入失败就退回读剪贴板 */ }

try {
  await send('Page.navigate', { url }, S);
} catch { /* 导航异常交给下面取内容判断 */ }

await sleep(waitMs);

// 滚动加载：很多站要滚到底才把正文渲染出来
if (doScroll) {
  try {
    await send('Runtime.evaluate', {
      expression: `(async () => {
        const step = Math.round(window.innerHeight * 0.9);
        for (let y = 0; y < 8; y++) {
          window.scrollTo(0, step * (y + 1));
          await new Promise(r => setTimeout(r, 350));
        }
        window.scrollTo(0, 0);
        return document.body.scrollHeight;
      })()`,
      awaitPromise: true,
    }, S);
    await sleep(700);
  } catch { /* 滚动失败不影响取内容 */ }
}

/* ── 像人一样点按钮，把页面自带的信息拿走 ────────────────
   组件站通常有一个「Copy for AI」下拉，里面分几项：
     Copy prompt            —— 只是安装说明，没有实现
     Copy configured code   —— 带当前参数的调用示例
     Copy component source  —— 真正的实现（含 shader）
     Copy install command   —— 装包命令

   用户抱怨"点了也没拿到真东西"，原因就是我们只点了第一项就收工。
   这里改成：把菜单里每一项都点一遍，逐个收回剪贴板内容，
   最后挑信息量最大的那份当依据。 */

let promptText = '';
let promptKind = '';
let codeBlocks = [];
const copies = [];

/** 用真实鼠标事件点一个坐标；JS 的 click() 打不开这类下拉菜单 */
async function clickAt(x, y) {
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, S).catch(() => {});
  await sleep(80);
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 }, S).catch(() => {});
  await sleep(40);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 }, S).catch(() => {});
}

/** 读走当前剪贴板里被我们钩住的内容 */
async function readCopied() {
  const hooked = await send('Runtime.evaluate', {
    expression: `(() => {
      const arr = (window.__qbCopied || []).filter(Boolean);
      return arr.length ? String(arr[arr.length - 1]) : '';
    })()`,
    returnByValue: true,
  }, S).catch(() => null);

  let got = String(hooked?.result?.value || '').trim();
  if (got.length < 30) {
    const clip = await send('Runtime.evaluate', {
      expression: `navigator.clipboard.readText().catch(() => '')`,
      awaitPromise: true,
      returnByValue: true,
    }, S).catch(() => null);
    got = String(clip?.result?.value || '').trim();
  }
  return got;
}

try {
  try {
    await send('Browser.grantPermissions', {
      origin: new URL(url).origin,
      permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'],
    });
  } catch { /* 没权限就靠钩子 */ }

  try { await send('Page.bringToFront', {}, S); } catch { /* 无所谓 */ }

  // 找触发按钮：Copy for AI / Copy / 复制
  const triggerRe = 'copy\\s*(for\\s*)?ai|copy\\s*prompt|copy\\s*(component\\s*)?(code|source)|复制(提示|代码|源码)';

  const triggers = await send('Runtime.evaluate', {
    expression: `(() => {
      const re = new RegExp(${JSON.stringify(triggerRe)}, 'i');
      const found = [];
      document.querySelectorAll('button,[role="button"],a').forEach((el) => {
        const r = el.getBoundingClientRect();
        if (r.width < 20 || r.height < 10) return;
        if (r.bottom < 0 || r.top > window.innerHeight) return;
        const t = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).replace(/\\s+/g, ' ').trim();
        if (!re.test(t)) return;
        if (t.length > 40) return;
        found.push({ label: t.slice(0, 40), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
      });
      window.__qbTriggers = found;
      return found.slice(0, 3);
    })()`,
    returnByValue: true,
  }, S).catch(() => null).then((r) => r?.result?.value || []);

  // 逐个触发按钮试：菜单结构可能不一样
  for (let ti = 0; ti < triggers.length && !promptText; ti++) {
    const trg = triggers[ti];

    /* 打开菜单。
       关键：scrollIntoView 会让元素位移，必须重新取坐标再点，
       否则点的是按钮旁边 —— 菜单当然打不开。 */
    const findTriggerPos = async () => {
      const r = await send('Runtime.evaluate', {
        expression: `(() => {
          const el = [...document.querySelectorAll('button,[role="button"],a')].find((n) => {
            const t = ((n.innerText || '') + ' ' + (n.getAttribute('aria-label') || '')).replace(/\\s+/g, ' ').trim();
            return t.includes(${JSON.stringify(trg.label.slice(0, 18))});
          });
          if (!el) return null;
          el.scrollIntoView({ block: 'center' });
          const b = el.getBoundingClientRect();
          const x = Math.round(b.left + b.width / 2);
          const y = Math.round(b.top + b.height / 2);
          for (let k = 0; k < 25; k++) {
            const top = document.elementFromPoint(x, y);
            if (!top || top === el || el.contains(top)) break;
            top.style.pointerEvents = 'none';
          }
          return { x, y };
        })()`,
        returnByValue: true,
      }, S).catch(() => null);
      return r?.result?.value || null;
    };

    const first = await findTriggerPos();
    if (!first) continue;
    await sleep(200);
    await clickAt(first.x, first.y);
    await sleep(700);

    // 收集菜单项（累积几帧，菜单可能渐次渲染）
    const seen = new Map();
    for (let k = 0; k < 8; k++) {
      const snap = await send('Runtime.evaluate', {
        expression: `(() => {
          const scopes = [...document.querySelectorAll('[role="menu"],[data-radix-popper-content-wrapper],[data-state="open"],[role="dialog"]')];
          let items = [];
          scopes.forEach((sc) => { items = items.concat([...sc.querySelectorAll('[role="menuitem"],[role="menuitemradio"],button,a,li,div[role="option"]')]); });
          if (!items.length) items = [...document.querySelectorAll('[role="menuitem"],button,a,li')];
          const out = [];
          items.forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width < 20 || r.height < 10) return;
            if (r.bottom < 0 || r.top > window.innerHeight) return;
            const t = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).replace(/\\s+/g, ' ').trim();
            if (!t || t.length > 44) return;
            out.push({ label: t, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
          });
          return out;
        })()`,
        returnByValue: true,
      }, S).catch(() => null);

      (snap?.result?.value || []).forEach((c) => { if (c?.label && !seen.has(c.label)) seen.set(c.label, c); });
      if (seen.size >= 3) break;
      await sleep(240);
    }

    /* 把菜单里每一项都点一遍。
       每次都要重开菜单，因为点完就关了。 */
    /* 按"信息量"排序，而不是按菜单顺序：
       组件源码 > 带参数的代码 > 提示词说明 > 安装命令。
       以前按菜单顺序点，第一项是说明，拿到 296 字符就以为成功了 ——
       那正是"照着一堆参数名瞎编"的来源。 */
    const rankOf = (label) => {
      const t = String(label).toLowerCase();
      if (/component\s*source|source\s*code|源码/.test(t)) return 0;
      if (/configured\s*code|copy\s*code|\bcode\b/.test(t)) return 1;
      if (/prompt/.test(t)) return 2;
      if (/install/.test(t)) return 3;
      return 4;
    };

    const items = [...seen.values()]
      .filter((c) => !/open\s*in|open\s*with|chatgpt|claude|\bv0\b|share|close/i.test(c.label))
      .sort((a, b) => rankOf(a.label) - rankOf(b.label));
    for (let ii = 0; ii < items.length; ii++) {
      const it = items[ii];

      // 重开菜单（坐标必须重新算）
      const again = await findTriggerPos();
      if (!again) continue;
      await clickAt(again.x, again.y);
      await sleep(620);

      // 重新取这一项的坐标（菜单每次弹出位置可能有细微差别）
      const now = await send('Runtime.evaluate', {
        expression: `(() => {
          const all = [...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],button,a,li,div[role="option"]')];
          const el = all.find((n) => {
            const r = n.getBoundingClientRect();
            if (r.width < 20 || r.height < 10) return false;
            if (r.bottom < 0 || r.top > window.innerHeight) return false;
            const t = ((n.innerText || '') + ' ' + (n.getAttribute('aria-label') || '')).replace(/\\s+/g, ' ').trim();
            return t === ${JSON.stringify(it.label)};
          });
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        })()`,
        returnByValue: true,
      }, S).catch(() => null);

      const pos = now?.result?.value;
      if (!pos) continue;

      await clickAt(pos.x, pos.y);
      await sleep(700);

      let got = await readCopied();

      /* 有些项不是复制到剪贴板，而是把代码摊在面板里。
         所以点完再扫一遍页面上可见的代码块，取最长的那段。 */
      if (got.length < 400) {
        const shown = await send('Runtime.evaluate', {
          expression: `(() => {
            let best = '';
            const push = (t) => { const s = String(t || '').trim(); if (s.length > best.length) best = s; };
            document.querySelectorAll('pre,code,textarea,[class*="code"],[class*="Code"]').forEach((el) => {
              const r = el.getBoundingClientRect();
              if (r.width < 60 || r.height < 30) return;
              push(el.value || el.innerText || el.textContent || '');
            });
            return best.slice(0, 60000);
          })()`,
          returnByValue: true,
        }, S).catch(() => null);

        const codeText = String(shown?.result?.value || '').trim();
        if (codeText.length > got.length) got = codeText;
      }

      if (got.length > 30) {
        copies.push({ label: it.label, len: got.length, text: got });
        // 源码到手就够了，不再点后面的
        if (rankOf(it.label) <= 1 || got.length > 4000) break;
      }
    }
  }

  /* 挑最有用的一份：
     含 shader / 绘制代码的优先（那才是实现），
     其次是体积大的，最后才退回说明。 */
  const codey = (t) => /(gl_FragColor|fragmentShader|vertexShader|createShader|getContext\(|requestAnimationFrame|uniform\s|useFrame|ShaderMaterial)/.test(t);

  const bySource = copies.filter((c) => codey(c.text));
  const best = bySource.sort((a, b) => b.len - a.len)[0]
    || copies.slice().sort((a, b) => b.len - a.len)[0]
    || null;

  if (best) {
    promptText = best.text.slice(0, 60000);
    promptKind = best.label;
  }

  /* ── 兜底：点页面自己的 Code 标签看源码 ──────────────────
     有些站的「Copy component source」不写剪贴板，而是切换代码视图。
     所以再补一步：如果还没拿到实现代码，就点一下页面上的 Code 按钮，
     把展开的代码块读走。这就是"自己按按钮拿信息"。 */
  const hasShaders = (t) => /(gl_FragColor|fragmentShader|vertexShader|createShader|ShaderMaterial)/.test(t || '');
  if (!hasShaders(promptText)) {
    const tabs = await send('Runtime.evaluate', {
      expression: `(() => {
        const out = [];
        document.querySelectorAll('button,[role="tab"],[role="button"],a,div[role="tab"]').forEach((el) => {
          const r = el.getBoundingClientRect();
          if (r.width < 20 || r.height < 10) return;
          const t = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
          if (!/^code$/i.test(t) && !/^源码$/.test(t) && !/^代码$/.test(t)) return;
          out.push({ label: t, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
        });
        return out.slice(0, 2);
      })()`,
      returnByValue: true,
    }, S).catch(() => null).then((r) => r?.result?.value || []);

    for (const tab of tabs) {
      await clickAt(tab.x, tab.y);
      await sleep(1200);

      const codeNow = await send('Runtime.evaluate', {
        expression: `(() => {
          let best = '';
          const take = (t) => { const s = String(t || '').trim(); if (s.length > best.length) best = s; };
          document.querySelectorAll('pre,code,textarea').forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width < 80 || r.height < 40) return;
            take(el.value || el.innerText || el.textContent || '');
          });
          return best.slice(0, 60000);
        })()`,
        returnByValue: true,
      }, S).catch(() => null);

      const t = String(codeNow?.result?.value || '').trim();
      if (t.length > promptText.length) {
        promptText = t;
        promptKind = `Code 视图（${tab.label}）`;
      }
      if (hasShaders(t)) break;
    }
  }

  /* 下拉对时序很敏感，第一次很可能什么都没点到。
     再补一轮：重新打开菜单，按顺序点，直到拿到像样的内容。 */
  if (!promptText || promptText.length < 200) {
    for (let retry = 0; retry < 2 && !promptText; retry++) {
      const t2 = triggers[0];
      if (!t2) break;
      const p2 = await findTriggerPos();
      if (!p2) break;
      await clickAt(p2.x, p2.y);
      await sleep(800);

      // 菜单里逐个点，取到就停
      const spots = await send('Runtime.evaluate', {
        expression: `(() => {
          const out = [];
          document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],button,a,li').forEach((el) => {
            const r = el.getBoundingClientRect();
            if (r.width < 24 || r.height < 12 || r.width > 700) return;
            const t = ((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
            if (!t || t.length > 44) return;
            if (/open\s*in|open\s*with|chatgpt|claude|\bv0\b|share|close/i.test(t)) return;
            out.push({ label: t, x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) });
          });
          return out.slice(0, 8);
        })()`,
        returnByValue: true,
      }, S).catch(() => null).then((r) => r?.result?.value || []);

      for (const sp of spots) {
        const again2 = await findTriggerPos();
        if (!again2) break;
        await clickAt(again2.x, again2.y);
        await sleep(700);

        const target = await send('Runtime.evaluate', {
          expression: `(() => {
            const el = [...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],button,a,li')].find((n) => {
              const r = n.getBoundingClientRect();
              if (r.width < 24 || r.height < 12 || r.width > 700) return false;
              const t = ((n.innerText || '') + ' ' + (n.getAttribute('aria-label') || '')).replace(/\s+/g, ' ').trim();
              return t === ${JSON.stringify('')} + ${'${JSON.stringify(sp.label)}'};
            });
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
          })()`,
          returnByValue: true,
        }, S).catch(() => null);

        const pos2 = target?.result?.value;
        if (!pos2) continue;
        await clickAt(pos2.x, pos2.y);
        await sleep(1100);

        const g2 = await readCopied();
        if (g2.length > 200) {
          promptText = g2.slice(0, 60000);
          promptKind = sp.label;
          break;
        }
      }
    }
  }

  // 页面上展开的代码块也顺手收走，作为补充
  const blocks = await send('Runtime.evaluate', {
    expression: `(() => {
      const out = [];
      document.querySelectorAll('pre, code, textarea').forEach((el) => {
        const t = (el.value || el.innerText || '').trim();
        if (t.length > 80) out.push(t.slice(0, 30000));
      });
      return [...new Set(out)].slice(0, 4);
    })()`,
    returnByValue: true,
  }, S).catch(() => null);
  codeBlocks = blocks?.result?.value || [];
} catch { /* 拿不到就当没有，不影响文字和截图 */ }

/* ── 清掉挡路的浮层 ─────────────────────────────────────
   很多站点一进去就弹升级提示、订阅框、Cookie 条、广告，
   截图只拍到这些，正文一个字看不到。

   这里不靠单一标记（role=dialog 只覆盖一小部分），而是按几何判定：
   遮住大半视口、又浮在上层的东西，就是挡路的，摘掉。
   同时清掉已知广告位和滚动锁，并尽量点掉"关闭"按钮。 */
try {
  await send('Runtime.evaluate', {
    expression: `(() => {
      const log = { overlays: 0, ads: 0, cookieBars: 0, clicked: 0, unlocked: 0 };
      const vw = window.innerWidth, vh = window.innerHeight;
      const area = vw * vh;

      const isOverlay = (el) => {
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden' || cs.opacity === '0') return false;
        if (cs.position !== 'fixed' && cs.position !== 'absolute') return false;
        const z = parseInt(cs.zIndex, 10);
        if (!(z >= 10)) return false;
        const r = el.getBoundingClientRect();
        if (r.width * r.height < area * 0.22) return false;
        // 必须盖住视口中心区域，贴在角落的小浮标不算
        const cx = r.left < vw / 2 && r.right > vw / 2;
        const cy = r.top < vh / 2 && r.bottom > vh / 2;
        return cx && cy;
      };

      const isAd = (el) => {
        const tag = el.tagName.toLowerCase();
        const idc = ((el.id || '') + ' ' + (el.className || '')).toLowerCase();
        if (tag === 'iframe') {
          const src = (el.getAttribute('src') || '').toLowerCase();
          if (/doubleclick|googlesyndication|adsbygoogle|adservice|amazon-ads|taboola|outbrain|adsystem/.test(src)) return true;
        }
        return /(^|[\s_-])(ad|ads|advert|adsbygoogle|sponsor|promo|banner-ad)([\s_-]|$)/.test(idc);
      };

      const isCookieBar = (el) => {
        const idc = ((el.id || '') + ' ' + (el.className || '')).toLowerCase();
        const txt = (el.innerText || '').slice(0, 120).toLowerCase();
        return /(cookie|consent|gdpr|privacy-banner)/.test(idc)
          || (/cookie/.test(txt) && /(accept|agree|同意|接受)/.test(txt));
      };

      // 先试"点关闭"，比直接删更接近真实用户行为，也不容易误伤
      const closeWords = /^(×|✕|✖|x|close|dismiss|关闭|知道了|稍后|以后再说|no thanks|skip)$/i;
      document.querySelectorAll('button,[role="button"],a,span[aria-label]').forEach((el) => {
        const label = ((el.getAttribute('aria-label') || '') + ' ' + (el.title || '') + ' ' + (el.innerText || '')).trim();
        if (!closeWords.test(label.slice(0, 20))) return;
        const box = el.getBoundingClientRect();
        if (box.width < 6 || box.height < 6) return;
        try { el.click(); log.clicked++; } catch {}
      });

      // 广告位
      document.querySelectorAll('iframe,ins,div,aside,section').forEach((el) => {
        if (isAd(el)) { try { el.remove(); log.ads++; } catch {} }
      });

      // Cookie 条
      document.querySelectorAll('div,section,aside').forEach((el) => {
        if (isCookieBar(el)) { try { el.remove(); log.cookieBars++; } catch {} }
      });

      // 遮住视口中心的大浮层（升级弹窗、订阅框、引导蒙层）
      [...document.body.querySelectorAll('*')].forEach((el) => {
        if (!isOverlay(el)) return;
        // 正文级容器不要动
        if (el === document.body || el === document.documentElement) return;
        if (el.contains(document.querySelector('main'))) return;
        try { el.remove(); log.overlays++; } catch {}
      });

      // 弹窗常把页面滚动锁死，解除它，否则滚动加载也拿不到
      [document.documentElement, document.body].forEach((el) => {
        if (!el) return;
        if (el.style.overflow === 'hidden' || el.style.position === 'fixed') log.unlocked++;
        el.style.overflow = '';
        el.style.position = '';
        el.style.height = '';
        el.style.paddingRight = '';
      });

      return log;
    })()`,
    returnByValue: true,
  }, S);
  await sleep(280);
} catch { /* 清不掉也不影响出图 */ }

const out = await send('Runtime.evaluate', {
  expression: `(() => {
    const pick = (sel) => document.querySelector(sel);
    const title = (document.title || '').trim();
    // 优先取语义化容器，读不到再退回整页 innerText
    const main = pick('main') || pick('article') || pick('[role=main]') || document.body;
    const text = (main?.innerText || document.body?.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
    const links = [...document.querySelectorAll('a[href]')]
      .map(a => ({ text: (a.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 80), href: a.href }))
      .filter(l => l.text && /^https?:/i.test(l.href))
      .slice(0, 80);
    return {
      title,
      text,
      html: (document.documentElement?.outerHTML || '').length,
      links,
      lang: document.documentElement.lang || '',
    };
  })()`,
  returnByValue: true,
}, S);

const val = out?.result?.value || {};
const text = String(val.text || '');

/* 截一张图交给能看图的模型。
   很多效果是画在 canvas 上的，innerText 里一个字都没有，
   只给文字等于让模型凭空猜 —— 这正是"照着网页做"做不像的原因。 */
let screenshot = '';
let shotBytes = 0;
if (wantShot) {
  try {
    // 等两帧再截，确保 canvas 至少完整画过一次
    await send('Runtime.evaluate', {
      expression: 'new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(1))))',
      awaitPromise: true,
    }, S).catch(() => {});
    await sleep(700);

    const cap = await send('Page.captureScreenshot', {
      format: 'jpeg', quality: 72, captureBeyondViewport: false,
    }, S);
    if (cap?.data) {
      screenshot = cap.data;
      shotBytes = Math.round(screenshot.length * 0.75);
    }
  } catch { /* 截图失败不影响文字结果 */ }
}

try { chrome.kill(); } catch { /* ignore */ }
clearTimeout(hardTimer);

const payload = JSON.stringify({
  ok: text.length > 20,
  url,
  title: val.title || '',
  text: text.slice(0, 40000),
  truncated: text.length > 40000,
  links: val.links || [],
  htmlBytes: val.html || 0,
  screenshot,
  shotBytes,
  // 页面自带的「复制提示词 / 代码」，优先于截图作为依据
  prompt: promptText,
  // 这次复制到的是"源码"还是"集成说明"，上层据此决定怎么用
  promptKind,
  codeBlocks,
});

/* 这段 JSON 可能有几百 KB（截图 + 提示词）。
   以前是先 console.log 再立刻 process.exit(0)：
   管道是异步写的，进程一退，没写完的尾巴就丢了，
   服务端收到半截 JSON 解析失败 —— 表现就是"提示词抓不到"。
   改成等 stdout 真正写完再退出；写失败也不拖住。 */
process.stdout.write(payload, () => {
  process.exit(0);
});
setTimeout(() => process.exit(0), 4000);
