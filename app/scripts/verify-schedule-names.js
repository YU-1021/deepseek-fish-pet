/* 把"我从排班图上读到的名字"逐个拿去和真实的 429 位干员总表核对
 * 为什么要它：图上的小字容易看错（铝/钼、珊/栅…），而干员总表是权威的。
 * 读错一个名字，排班就会排错人 —— 所以宁可花一次核对，也不许把错名字交出去。
 * 跑法：node app/scripts/verify-schedule-names.js
 */
const fs = require('fs');
const path = require('path');

const table = path.join(process.env.APPDATA, 'dayu-pet', 'skills', '干员图鉴', '干员总表.md');
const text = fs.readFileSync(table, 'utf8');
/* 表行形如：| 艾雅法拉 | 6 | 远程 | 输出, 削弱 | */
const known = new Map();
for (const line of text.split('\n')) {
  const m = line.match(/^\|\s*([^|]+?)\s*\|\s*([1-6])\s*\|/);
  if (m) known.set(m[1].trim(), { star: m[2], line });
}
console.log('总表里共 ' + known.size + ' 位干员');

/* 我从图上读到的（按设施） */
const readOff = {
  '控制中枢': ['冰酿', '寒芒克洛丝', '暴雨', '阿米娅', 'Mon3tr'],
  '贸易站1': ['但书', '古米', '月见夜'],
  '贸易站2': ['可露希尔', '夜刀', '空爆'],
  '制造站1': ['清流', '砾', '结城理'],
  '制造站2': ['机械师', '红豆', '酒神'],
  '制造站3': ['娜斯提', '杰西卡', '铅踝'],
  '制造站4': ['夜烟', '斑点', '苍苔'],
  '发电站1': ['埃癸斯'],
  '发电站2': ['格蕾伊'],
  '发电站3': ['海霓'],
  '会客室': ['伊内丝', '12F'],
  '办公室': ['斥罪'],
  '宿舍1': ['岳羽由加莉', '焰狐龙梓兰', '明椒', '慕斯', '缠丸'],
  '宿舍2': ['虎狼丸', '芬', '克洛丝', '泡普卡', '铝铅'],
  '宿舍3': ['杏仁', '白面鸮', '香草', 'GALLUS2', '伺夜'],
  '宿舍4': ['珊比'],
};

/* 常见形近字（把可能看错的字替换掉，找出真正的候选） */
const CONFUSE = {
  '铝': ['钼', '铅', '钢'],
  '铅': ['铝', '钼'],
  '珊': ['栅', '删', '姗', '跚'],
  '比': ['此', '比'],
};
function variants(name) {
  const out = new Set([name]);
  for (let i = 0; i < name.length; i++) {
    const ch = name[i];
    for (const alt of (CONFUSE[ch] || [])) {
      out.add(name.slice(0, i) + alt + name.slice(i + 1));
    }
  }
  return Array.from(out);
}

let bad = 0;
const flat = [];
for (const [fac, names] of Object.entries(readOff)) {
  for (const n of names) {
    flat.push(n);
    if (known.has(n)) continue;
    bad++;
    /* 找一个形近的候选 */
    const cands = variants(n).filter((v) => known.has(v));
    console.log('  ❓ 「' + n + '」(' + fac + ') 不在总表里'
      + (cands.length ? ' → 是不是「' + cands.join(' / ') + '」？' : ' → 没有形近候选，需要重新看图'));
  }
}

/* 反向来一手：把图上读到的名字做一次模糊匹配，看有没有唯一解 */
console.log('');
console.log('=== 逐个确认（在总表里的）===');
for (const [fac, names] of Object.entries(readOff)) {
  const line = names.map((n) => (known.has(n) ? (n + '(' + known.get(n).star + '★)') : ('❓' + n))).join(' / ');
  console.log('  ' + fac.padEnd(10) + ' ' + line);
}
console.log('');
console.log('  图上一共 ' + flat.length + ' 个位置有人，其中 ' + (flat.length - bad) + ' 个名字在总表里对得上，' + bad + ' 个需要修正');
process.exit(bad ? 1 : 0);
