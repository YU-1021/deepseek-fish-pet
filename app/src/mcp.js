/* MCP 客户端（最小可用版）
 *
 * 【为什么要它】2026-10-10 实测：她的 app **完全没有 MCP 支持** ✗；
 *   而 MCP 的价值是「★挂新 server 不用再改她的代码★」✓ —— 这一步是铺路 ✓。
 *
 * 【协议】JSON-RPC 2.0，★换行分隔的 JSON✗★（**不是** Content-Length 头 ✗）。
 *   已实测通过的标准三步：
 *     initialize（protocolVersion 2025-06-18）→ notifications/initialized → tools/list
 *   实测 @playwright/mcp v1.64.0-alpha 返回 25 个工具 ✓。
 *
 * 【Windows 上的坑（实测）】★ spawn 一个 .cmd 必须 shell:true ✗★，
 *   否则报 EINVAL ✓；而且 shell:true 时★路径里有空格会被拆✗★
 *   （写 C:\Program Files\nodejs\npx.cmd 会变成「C:\Program 不是内部或外部命令」✓），
 *   所以走 PATH 里的 npx ✓。
 *
 * 【环境现实（如实说明 ✗）】
 *   本机 python.exe 是 Windows 应用商店占位符（返回 9009 ✗）、没有 uvx、没有 go ✓ ——
 *   ★ 所以能用 MCP server 只剩 **Node 写的** ✗✓★。
 *   视觉类 server（Windows-MCP / computer-control-mcp / agent-eyes / pov-desktop）**全是 Python** ✗；
 *   screenshooter-mcp 是 Go ✗。
 *   → ★★ **MCP 对本机真正有用的场景是【网页】**✓（@playwright/mcp ✓）★★；
 *     桌面和游戏仍然要用她自己的 uia_* / 模板 / OCR ✓。
 */
'use strict';
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

/* ★★ 2026-10-10：按窗口截图那条路的入口解析 ★★
   为什么要有这个函数（而不是写死一个路径）：
     · ★首选 app/node_modules 里那份★ ✓ —— 她自己的依赖目录，打包/搬家都不会丢 ✓；
     · 试验目录 C:\deepseek\mcptry2 那份只当**回落** ✗→✓（那是当时试装留下的 ✓，
       主人哪天清掉它也不该把她的能力带走 ✓）。
   ★实测★：app/node_modules/@cool-mcp/desktop-automation/dist/index.js 装好后
     与 mcptry2 那份是同一个版本（1.0.9），★两条路的工具一模一样 ✓★。
   为什么用 `node` 而不是 electron 自身 ✗：这个 server 是 ESM + napi 原生模块 ✓，
     用 electron 的 ELECTRON_RUN_AS_NODE 跑也能活，但没必要多担一层 ✗ ——
     `npx`（playwright 那台）已经证明她的进程里 PATH 上有 node ✓。 */
function pickDesktopEntry() {
  const cands = [
    path.join(__dirname, '..', 'node_modules', '@cool-mcp', 'desktop-automation', 'dist', 'index.js'),
    'C:/deepseek/mcptry2/node_modules/@cool-mcp/desktop-automation/dist/index.js',
  ];
  for (const c of cands) { try { if (fs.existsSync(c)) return c; } catch (e) {} }
  return cands[0];
}

const DEFAULTS = {
  'playwright': {
    command: 'npx',
    /* ★ 必须加 --headless ✗→✓（2026-10-10 实测）★
       ★ 不加的话 @playwright/mcp 会**真的弹一个浏览器窗口**给用户看 ✗ ——
         她是在后台干活的桌宠 ✓，不该往主人脸上弹窗口 ✓。
       实测加 --headless 后：★浏览器进程 0、可见窗口 0 ✓★，而 25 个工具和
         browser_navigate（真读到 Page URL / Page Title ✓）都照常工作 ✓。 */
    args: ['-y', '@playwright/mcp', '--headless'],
    enabled: false,
    note: '浏览器自动化（25 个工具，含 browser_find：在可访问性快照里搜文字，点元素不需要坐标 ✓）',
  },
  /* ★ 第二个 server：网页可访问性树（2026-10-10 装上并验证 ✓）★
     ★ 它的 get_accessibility_tree / query_accessibility_tree / get_interactive_elements
       返回的是**节点 + ARIA 角色 + 可访问名** ✓ —— ★ 不需要坐标 ✓★。
     ⚠️ 它走 Chrome 的 CDP ✓（要 Chrome 带 --remote-debugging-port ✓），
        ★★ 也就是说它**只管网页**✗ —— ★ 桌面/游戏它帮不上 ✓（与 playwright 同一条限制 ✓）★ */
  'a11y': {
    command: 'npx',
    args: ['-y', 'mcp-accessibility-bridge'],
    enabled: false,
    note: '网页可访问性树（CDP）：按 ARIA 角色/可访问名找元素，不需要坐标 ✓（只管网页）',
  },
  /* ★★ 第三个 server：★桌面/游戏窗口★ —— 2026-10-10 接上（主人："按 DSH 的方式重做视觉"）★★
     ★它补的正是前两台补不了的那一格✗★：前两台（playwright / a11y）★只管网页✗★，
     而主人的痛点是**游戏画面 + 桌面窗口** ✓。
     ★这台是 Node 写的 ✓ → 本机能跑 ✓（python 是商店占位符、没有 uvx/go ✓）。
     它给的最关键两件（实测 1.0.9，23 个工具 ✓）：
       ① bot_screenshot：★按【进程】截那一个窗口★，返回图 + **windowBounds** ✓；
       ② bot_click：★支持窗口内 bbox 0~1000 归一化坐标★（配合 windowBounds）✓
          —— 于是"在窗口里量到的位置"可以直接喂回去点，不用再换算整屏绝对坐标 ✓。
     ⚠️ ★诚实标注（真机测过，别信想象）✗★：
        · 它截的是**整屏图 + 按窗口矩形裁** ✓（不是 PrintWindow 那种"窗口自绘"通道 ✓）——
          所以**别的窗口盖在上面时，遮挡仍然会被拍进去** ✗。
          要拿到干净画面：先 bot_activate_window 把它提到最前 ✓（见 win_shot|进程名|activate ✓）。
        · 它返回的是 **JPEG** ✗（内部是先拿无损 PNG → 裁 → 最后编码 JPEG ✓）——
          想要接近无损就传 quality=100 且别让它缩放 ✓（win_shot 已经这么做了 ✓）。 */
  'desktop-auto': {
    command: 'node',
    args: [pickDesktopEntry()],
    enabled: true,
    note: '★按进程截那个窗口★（bot_screenshot → 图 + windowBounds）+ 窗口内 bbox 0~1000 点击（bot_click）。Node 写的，本机能跑 ✓；⚠️ 是"整屏裁窗口矩形"，遮挡要先 activate 才干净 ✗',
  },
};

const PROTOCOL = '2025-06-18';
const CALL_TIMEOUT = 30000;
const START_TIMEOUT = 90000;   // npx 第一次要下载包，给足时间 ✓

let servers = Object.assign({}, DEFAULTS);
const live = {};   // name -> { child, buf, idSeq, pending, ready, tools, stderr, starting }

function dbg(msg) { try { require('./debug').log('[mcp] ' + msg); } catch (e) {} }

/* ★ 配置覆盖默认（config.mcpServers ✓）；默认 enabled:false ✗
   为什么默认关✗：@playwright/mcp 会拉起浏览器 ✓ —— 不该每次开机都拉 ✓ */
function configure(fromConfig) {
  const c = fromConfig && typeof fromConfig === 'object' ? fromConfig : {};
  Object.keys(DEFAULTS).forEach((k) => {
    servers[k] = Object.assign({}, DEFAULTS[k], c[k] || {});
    if (c[k] && typeof c[k].enabled === 'boolean') servers[k].enabled = c[k].enabled;
  });
  return servers;
}

function status() {
  const out = {};
  Object.keys(servers).forEach((k) => {
    const s = servers[k];
    const l = live[k];
    out[k] = {
      enabled: !!s.enabled,
      running: !!(l && l.child && !l.child.killed),
      ready: !!(l && l.ready),
      tools: l && l.tools ? l.tools.length : 0,
      starting: !!(l && l.starting),
      note: s.note || '',
    };
  });
  return out;
}

function send(name, method, params) {
  const l = live[name];
  if (!l || !l.child) return Promise.reject(new Error('服务器没在跑：' + name));
  const id = l.idSeq++;
  const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params: params || {} });
  l.child.stdin.write(msg + '\n');
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      if (l.pending[id]) { delete l.pending[id]; reject(new Error('MCP 调用超时（' + method + '，' + CALL_TIMEOUT + 'ms）')); }
    }, CALL_TIMEOUT);
    l.pending[id] = { resolve, reject, timer: t, method };
  });
}

function notify(name, method, params) {
  const l = live[name];
  if (!l || !l.child) return;
  l.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params: params || {} }) + '\n');
}

async function start(name) {
  const s = servers[name];
  if (!s) throw new Error('没有这个服务器：' + name + '（可用：' + Object.keys(servers).join(', ') + '）');
  if (live[name] && live[name].child && !live[name].child.killed) return live[name];
  const l = live[name] = { child: null, buf: '', idSeq: 1, pending: {}, ready: false, tools: null, stderr: [], starting: true };
  const cmd = s.command || 'npx';
  const args = Array.isArray(s.args) ? s.args : [];
  dbg('启动 ' + name + ': ' + cmd + ' ' + args.join(' '));
  /* ★ shell:true 是为了能在 Windows 上 spawn .cmd ✗→✓（否则 EINVAL ✓）★ */
  const child = spawn(cmd, args, { shell: true, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  l.child = child;

  child.stdout.on('data', (d) => {
    l.buf += d.toString('utf8');
    let i;
    while ((i = l.buf.indexOf('\n')) >= 0) {
      const line = l.buf.slice(0, i).trim();
      l.buf = l.buf.slice(i + 1);
      if (!line) continue;
      let m = null;
      try { m = JSON.parse(line); } catch (e) { continue; }   // ★非 JSON 行忽略（server 有时会打印日志 ✓）★
      if (m.id && l.pending[m.id]) {
        const p = l.pending[m.id];
        delete l.pending[m.id];
        clearTimeout(p.timer);
        if (m.error) p.reject(new Error(String(m.error.message || JSON.stringify(m.error)).slice(0, 300)));
        else p.resolve(m.result);
      }
    }
  });
  child.stderr.on('data', (d) => {
    const t = d.toString('utf8').trim();
    if (t) { l.stderr.push(t.slice(0, 300)); if (l.stderr.length > 20) l.stderr.shift(); }
  });
  child.on('exit', (code) => { dbg(name + ' 退出 code=' + code); l.ready = false; });
  child.on('error', (e) => { dbg(name + ' 起不来：' + e.message); l.ready = false; l.stderr.push('spawn 失败：' + e.message); });

  /* ★ 握手：initialize → notifications/initialized ✓（标准三步的前两步 ✓）★ */
  const info = await Promise.race([
    send(name, 'initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'dayu-pet', version: '0.1.0' },
    }),
    new Promise((_, rej) => setTimeout(() => rej(new Error('握手超时（' + START_TIMEOUT + 'ms）—— npx 第一次下载包可能很慢，重试一次通常就好 ✓')), START_TIMEOUT)),
  ]);
  notify(name, 'notifications/initialized', {});
  l.ready = true;
  l.starting = false;
  l.serverInfo = (info && info.serverInfo) || null;
  dbg(name + ' 就绪：' + JSON.stringify(l.serverInfo));
  return l;
}

async function listTools(name) {
  const l = await start(name);
  if (l.tools) return l.tools;
  const r = await send(name, 'tools/list', {});
  l.tools = (r && r.tools) || [];
  return l.tools;
}

async function callTool(name, toolName, args) {
  await start(name);
  const r = await send(name, 'tools/call', { name: toolName, arguments: args || {} });
  return r;
}

function stop(name) {
  const l = live[name];
  if (!l || !l.child) return false;
  try { l.child.kill(); } catch (e) {}
  l.ready = false;
  l.child = null;
  return true;
}
function stopAll() { Object.keys(live).forEach(stop); }

module.exports = {
  DEFAULTS, PROTOCOL, configure, status, start, listTools, callTool, stop, stopAll,
  servers: () => servers,
  stderrOf: (name) => (live[name] ? live[name].stderr.slice(-5) : []),
};
