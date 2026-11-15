/* layout.js —— ★假游戏测试屏的布局常量 = 测试真值★（完全确定 ✓ 无随机 ✓ 每次一样 ✓）
 * 规格（lead 指定）：带文字 40+ / 纯图形 30+ / 同名重复 4 组×3 / 小按钮 10+（24~40px）/ 贴边 6 /
 *                   + 纯背景区 + 纯文字区（里面**不许**放按钮 ✓ 用于假阳性测试 ✓）
 */
'use strict';
const buttons = [];
function add(kind, label, x, y, w, h, extra) {
  buttons.push(Object.assign({ id: 'B' + String(buttons.length + 1).padStart(3, '0'), kind, label, x, y, w, h }, extra || {}));
}

/* ① 带文字按钮 42 个（中文为主 + 少量英文/数字 ✓） */
const TEXTS = ['编辑队列', '进驻信息', '设施信息', '控制中枢', '会客室', '制造站', '贸易站', '发电站', '训练室', '宿舍',
  '加工站', '办公室', '采购中心', '线索交流', '干员信息', '基建概览', '任务', '仓库', '商店', '招募',
  '公开招募', '采购凭证', '信用商店', '好友', '档案', '设置', '确认', '取消', '返回', '关闭',
  'ALL', 'BASE', 'OK', 'CANCEL', 'Lv.1', 'Lv.2', '2/12', '3/3', 'PRTS', 'INFO', 'NEXT', 'PREV'];
TEXTS.forEach((t, i) => {
  const col = i % 7, row = Math.floor(i / 7);
  add('text', t, 20 + col * 268, 24 + row * 92, 240, 64);   // ★字号/尺寸调大✗→✓：14px 的字在 DIP 截图里 OCR 读不出来（第一版 42 个全"没找到" ✓）
});

/* ② 纯图形按钮 30 个（无任何文字 ✓ OCR 完全无效 ✓ 专考图标路线 ✓） */
for (let i = 0; i < 30; i++) {
  const col = i % 10, row = Math.floor(i / 10);
  add('icon', '', 60 + col * 175, 620 + row * 110, 72, 72, { shape: i % 5 });
}

/* ③ 同名重复按钮 4 组 × 3 个（★复现今晚"四处同名"的归属难题 ✓★） */
const DUP = ['编辑队列', '确认', '加号', '设置'];
DUP.forEach((t, g) => {
  for (let k = 0; k < 3; k++) add('dup', t, 1400, 100 + g * 210 + k * 62, 150, 44, { group: 'D' + (g + 1) });
});

/* ④ 小按钮 12 个（24~40px ✓ 专考坐标精度 ✓）
   ★字号随按钮尺寸成比例✗→✓（lead 划的界线 ✓）：24px 高的按钮配 12~14px 字 = **真实界面形态** ✓。
   第一版所有按钮都吃全局 28px ✗ → 字被按钮边框裁掉 ✗ = 布局 bug（不是考试难度 ✓）。 */
for (let i = 0; i < 12; i++) {
  const w = 24 + (i % 3) * 8, h = 24 + (i % 2) * 16;
  add('small', 'S' + (i + 1), 1000 + (i % 4) * 52, 100 + Math.floor(i / 4) * 52, w, h, { font: h >= 36 ? 14 : 12 });
}

/* ⑤ 贴边按钮 6 个（贴四边 ✓ 考夹取与边缘 ✓；字号同样随尺寸比例 ✓） */
add('edge', 'E-TL', 0, 0, 90, 36, { font: 15 }); add('edge', 'E-TR', 1830, 0, 90, 36, { font: 15 });
add('edge', 'E-BL', 0, 1044, 90, 36, { font: 15 }); add('edge', 'E-BR', 1830, 1044, 90, 36, { font: 15 });
add('edge', 'E-L', 0, 520, 40, 80, { font: 13 }); add('edge', 'E-R', 1880, 520, 40, 80, { font: 13 });

/* ⑥ 两个**不许放按钮**的区域（假阳性测试用 ✓） */
const noButtonRegions = [
  { id: 'blank', x: 1180, y: 620, w: 300, h: 200, fill: 'blank' },
  { id: 'textonly', x: 1500, y: 620, w: 340, h: 200, fill: 'text' },
];

module.exports = { width: 1920, height: 1080, title: 'DSH-GameTest', buttons, noButtonRegions,
  counts: {
    text: buttons.filter((b) => b.kind === 'text').length,
    icon: buttons.filter((b) => b.kind === 'icon').length,
    dup: buttons.filter((b) => b.kind === 'dup').length,
    small: buttons.filter((b) => b.kind === 'small').length,
    edge: buttons.filter((b) => b.kind === 'edge').length,
    total: buttons.length,
  } };
