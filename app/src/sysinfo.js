/* 系统信息（B4）—— 她不知道这台机器现在什么状况
 *
 * 【为什么需要】主人会问"我电脑还剩多少电""C 盘还有空间吗""内存够不够" ——
 *   她现在完全答不了（只能看屏幕截图去猜 ✗，而托盘里的电量小字 OCR 经常读不准 ✓）。
 *
 * 【怎么取】分两层：
 *   · 纯 Node 的 os 模块：内存 / CPU / 开机时长 —— 零依赖、最快 ✓
 *   · PowerShell 的 CIM：电池 / 磁盘 / 网卡 —— 这些 Node 拿不到 ✓
 *     ⚠️ 输出走 base64 ✓（PS 5.1 的 stdout 默认 GBK，中文/路径会乱码 ——
 *        今天在 Get-Content、剪贴板、常驻 shell 上各踩过一次 ✓）
 */
'use strict';

const os = require('os');
const { execFileSync } = require('child_process');

function psJson(script, timeoutMs) {
  /* ★ 让 PS 把结果以 base64 交出来，避开 stdout 编码问题 ★ */
  const wrapped = '[Console]::OutputEncoding = [Text.Encoding]::UTF8; '
    + '$r = (' + script + ' | ConvertTo-Json -Compress -Depth 4); '
    + '[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$r))';
  const out = execFileSync('powershell.exe', ['-NoProfile', '-Sta', '-Command', wrapped],
    { encoding: 'utf8', timeout: timeoutMs || 12000, windowsHide: true });
  const txt = Buffer.from(String(out || '').trim(), 'base64').toString('utf8');
  if (!txt.trim()) return null;
  try { return JSON.parse(txt); } catch (e) { return null; }
}

function arr(x) { return x == null ? [] : (Array.isArray(x) ? x : [x]); }

function gb(n) { return Math.round(Number(n) / 1024 / 1024 / 1024 * 10) / 10; }

/* what: 空=全查；battery/disk/net/mem 只查那一项 ——
   ★第一版写成"先 collect() 全部再过滤"，于是单项还是要 2 秒 ✗
     而工具描述里我又承诺了"单项几百毫秒" —— 那是假话，必须让实现追上描述 ✓ */
function collect(what) {
  const k = String(what || '').toLowerCase();
  const want = (name) => !k || k === 'all' || k === name
    || (name === 'battery' && (k === '电池' || k === '电量'))
    || (name === 'disk' && (k === '磁盘' || k === '空间'))
    || (name === 'net' && k === '网络')
    || (name === 'mem' && (k === 'memory' || k === '内存'))
    || (name === 'mem' && k === 'cpu');
  const r = { ok: true, parts: [], warn: [] };

  /* ── 内存 / CPU / 开机时长（Node 直接拿） ── */
  if (want('mem')) try {
    const total = os.totalmem(), free = os.freemem();
    r.mem = { totalGB: gb(total), freeGB: gb(free), usedPct: Math.round((1 - free / total) * 100) };
    r.parts.push('内存 ' + r.mem.usedPct + '% 已用（剩 ' + r.mem.freeGB + ' / ' + r.mem.totalGB + ' GB）');
  } catch (e) { r.warn.push('内存读取失败'); }

  if (want('mem')) try {
    const cpus = os.cpus() || [];
    const load = os.loadavg ? os.loadavg()[0] : 0;
    r.cpu = { model: (cpus[0] && cpus[0].model || '').trim(), cores: cpus.length, load1: Math.round(load * 100) / 100 };
    r.parts.push('CPU ' + r.cpu.cores + ' 核' + (r.cpu.model ? ('（' + r.cpu.model.slice(0, 40) + '）') : ''));
  } catch (e) { r.warn.push('CPU 读取失败'); }

  if (want('mem')) try {
    const up = Math.round(os.uptime() / 60);
    r.uptimeMin = up;
    r.parts.push('开机 ' + (up >= 1440 ? (Math.round(up / 144) / 10 + ' 天') : (up >= 60 ? (Math.round(up / 6) / 10 + ' 小时') : (up + ' 分钟'))));
  } catch (e) {}

  /* ── 电池（台式机没有就跳过） ── */
  if (want('battery')) try {
    const b = psJson('Get-CimInstance Win32_Battery | Select-Object EstimatedChargeRemaining,BatteryStatus,Name');
    const list = arr(b).filter((x) => x && x.EstimatedChargeRemaining != null);
    if (list.length) {
      r.battery = list.map((x) => ({
        name: String(x.Name || '').slice(0, 40),
        pct: Number(x.EstimatedChargeRemaining),
        charging: Number(x.BatteryStatus) === 2,      // 2 = 正在充电 ✓
      }));
      const b0 = r.battery[0];
      r.parts.push('电池 ' + b0.pct + '%' + (b0.charging ? '（充电中）' : ''));
    }
  } catch (e) { r.warn.push('电池读取失败（台式机可能本来就没有）'); }

  /* ── 磁盘（只看固定盘） ── */
  if (want('disk')) try {
    const d = psJson('Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | Select-Object DeviceID,Size,FreeSpace,VolumeName');
    const list = arr(d).filter((x) => x && x.Size);
    if (list.length) {
      r.disks = list.map((x) => ({
        drive: String(x.DeviceID || ''),
        totalGB: gb(x.Size), freeGB: gb(x.FreeSpace),
        freePct: Math.round(Number(x.FreeSpace) / Number(x.Size) * 100),
        label: String(x.VolumeName || '').slice(0, 20),
      }));
      r.parts.push('磁盘 ' + r.disks.map((x) => x.drive + ' 剩 ' + x.freeGB + 'GB/' + x.totalGB + 'GB').join('，'));
    }
  } catch (e) { r.warn.push('磁盘读取失败'); }

  /* ── 网络（有连着且不是回环/虚拟的就报） ── */
  if (want('net')) try {
    const n = psJson('Get-NetAdapter | Where-Object { $_.Status -eq "Up" } | Select-Object Name,LinkSpeed,InterfaceDescription');
    const list = arr(n).filter((x) => x && x.Name);
    if (list.length) {
      r.net = list.map((x) => ({ name: String(x.Name).slice(0, 30), speed: String(x.LinkSpeed || '') }));
      r.parts.push('网络 ' + r.net.map((x) => x.name + (x.speed ? ('(' + x.speed + ')') : '')).join('，'));
    } else {
      r.parts.push('网络：没有连接中的网卡');
    }
  } catch (e) { r.warn.push('网卡读取失败'); }

  return r;
}

/* 只查某一项的快路径 —— 实测全量要 3.7 秒（4 次 PS 调用），
   而主人多半只问一件事（"还剩多少电"），没必要每次把磁盘网卡都查一遍 ✓ */
function only(what) {
  const k = String(what || '').toLowerCase();
  if (!k || k === 'all') return collect();
  return collect(k);
}

/* 给她看的一行摘要 */
function summary() {
  const r = collect();
  return '🖥 ' + r.parts.join('；') + (r.warn.length ? ('\n（' + r.warn.join('；') + '）') : '');
}

module.exports = { collect, only, summary };
