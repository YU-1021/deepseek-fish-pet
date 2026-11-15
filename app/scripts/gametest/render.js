/* render.js —— ★把 layout.js 渲染成**普通浏览器能开的** render.html（一个数字都不另写✗→✓）★
 * 为什么：Electron 在本机两边都起不来（环境问题 ✓）→ 测试屏必须能由浏览器渲染 ✓。
 * 铁律：坐标/尺寸/标签/分类**全部**来自 layout.js ✓（真值与画面同源 ✓）；
 *       普通 HTML/CSS 绝对定位 + 系统字体 + 不用 canvas/WebGL ✓ —— 浏览器原生渲染的文字最清晰，OCR 最好读 ✓。
 * 用法：node app\scripts\gametest\render.js   → 生成同目录 render.html
 */
'use strict';
const fs = require('fs');
const path = require('path');
const L = require('./layout');

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const FILL = { text: '#ffffff', icon: '#ffffff', dup: '#ffffff', small: '#ffffff', edge: '#ffffff' };
const BORDER = { text: '#1f3a5f', icon: '#1f5f3a', dup: '#7a3b12', small: '#5f1f3f', edge: '#3f3f1f' };

const parts = [];
for (const b of L.buttons) {
  const inner = b.kind === 'icon'
    ? '<svg width="' + Math.round(b.w * 0.55) + '" height="' + Math.round(b.h * 0.55) + '" viewBox="0 0 100 100">'
      + '<circle cx="50" cy="50" r="38" fill="#1f5f3a"/><rect x="18" y="42" width="64" height="14" fill="#7a3b12"/></svg>'
    : '<span>' + esc(b.label) + '</span>';
  parts.push('<div class="btn" id="' + b.id + '" data-kind="' + b.kind + '" style="left:' + b.x + 'px;top:' + b.y
    + 'px;width:' + b.w + 'px;height:' + b.h + 'px;font-size:' + (b.font || 28) + 'px;background:' + FILL[b.kind] + ';border:2px solid ' + BORDER[b.kind] + '">' + inner + '</div>');
}
/* 两个**不许放按钮**的区域（假阳性测试 ✓ 只放虚线框 + 纯文字区里放一行小字 ✓） */
for (const r of L.noButtonRegions) {
  parts.push('<div class="nobtn" style="left:' + r.x + 'px;top:' + r.y + 'px;width:' + r.w + 'px;height:' + r.h + 'px">'
    + (r.fill === 'text' ? '<span class="tiny">纯文字区域（无按钮）：ABC 123 甲乙丙丁</span>' : '') + '</div>');
}

const html = '<!doctype html><html lang="zh"><head><meta charset="utf-8">'
  + '<title>' + esc(L.title) + '</title><style>'
  + 'html,body{margin:0;padding:0;width:' + L.width + 'px;height:' + L.height + 'px;background:#f2f2f2;'
  + 'color:#111;font-family:"Microsoft YaHei","Segoe UI",sans-serif;overflow:hidden}'
  + '.btn{position:absolute;display:flex;align-items:center;justify-content:center;font-size:28px;'
  + 'color:#111;text-align:center;box-sizing:border-box;border-radius:6px}'
  + '.nobtn{position:absolute;border:1px dashed #b9b9b9;box-sizing:border-box;display:flex;align-items:center;justify-content:center}'
  + '.tiny{font-size:12px;color:#666}'
  + '#hud{position:absolute;left:8px;top:2px;font-size:11px;color:#999}'
  + '</style></head><body>' + parts.join('')
  + '<div id="hud">gametest screen · elements=' + L.buttons.length + ' · layout=' + path.basename(__filename, '.js') + ' truth</div>'
  + '</body></html>';

const out = path.join(__dirname, 'render.html');
fs.writeFileSync(out, html, 'utf8');
console.log('已生成 ' + out + '（' + html.length + ' 字节）');
console.log('布局真值：' + JSON.stringify(L.counts));
