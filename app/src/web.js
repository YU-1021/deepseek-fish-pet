// 网页操控：Playwright 驱动一个受控浏览器（懒加载，未安装时报错不崩溃）
const path = require('path');
let packed = false;
try { packed = require('electron').app.isPackaged; } catch {}
const browsersPath = packed && process.resourcesPath
  ? path.join(process.resourcesPath, '.pw-browsers')
  : path.join(__dirname, '..', '.pw-browsers');
process.env.PLAYWRIGHT_BROWSERS_PATH = process.env.PLAYWRIGHT_BROWSERS_PATH || browsersPath;

let browser = null, page = null;

async function ensure() {
  if (page && browser && !page.isClosed() && browser.isConnected()) return;
  /* 以前只判 page 是否非空，而且 launch 之后直接 newContext/newPage：
     - newContext/newPage 抛错时 browser 已经被赋值，下次调用又 launch 一个，
       旧的那个引用被覆盖 → **headless Chromium 永久泄漏**（退出时 close() 只关最后一个）；
     - 页面被站点关掉/崩了以后 page 仍然非空 → 之后所有 web_* 永久报 "Target closed"，无法自愈。
     现在：先判存活，再收干净旧的，launch 之后失败就回滚。 */
  await close();
  const { chromium } = require('playwright');
  const b = await chromium.launch({ headless: true });
  try {
    const ctx = await b.newContext({ viewport: { width: 1280, height: 860 }, locale: 'zh-CN' });
    page = await ctx.newPage();
    browser = b;
  } catch (e) {
    try { await b.close(); } catch {}
    browser = null; page = null;
    throw e;
  }
}

async function close() {
  try { await browser?.close(); } catch {}
  browser = null; page = null;
}

async function describe() {
  const title = await page.title().catch(() => '');
  const url = page.url();
  const text = await page.evaluate(() => (document.body && document.body.innerText) || '').catch(() => '');
  const clean = String(text).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim().slice(0, 1800);
  return `🌐 ${title}\n${url}\n\n${clean}`;
}

async function run(tool, arg) {
  await ensure();
  if (tool === 'web_open') {
    let url = String(arg || '').trim();
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25000 });
    await page.waitForTimeout(700);
    return describe();
  }
  if (tool === 'web_click') {
    await page.click(String(arg || '').trim(), { timeout: 8000 });
    await page.waitForTimeout(900);
    return describe();
  }
  if (tool === 'web_type') {
    const s = String(arg || '');
    const i = s.indexOf('||');
    const sel = i > 0 ? s.slice(0, i).trim() : 'input';
    const text = i > 0 ? s.slice(i + 2) : s;
    await page.fill(sel, text, { timeout: 8000 });
    return `✅ 已在「${sel}」输入：${text}`;
  }
  if (tool === 'web_read') return describe();
  throw new Error('未知网页操作：' + tool);
}

module.exports = { run, close };
