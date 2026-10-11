/* 帧比对（像素级"界面变没变"）—— 用户点出的问题：她滚动了好几次、界面明明变了，她却说"没变"
 *
 * 【为什么必须做】她判断"界面变没变"用的是**视觉模型的总结** —— 而视觉模型会说谎：
 *   今天它谎报过"两个槽位分别是 12F 和伊内丝，都已进驻"（实际两个都是空的），
 *   也报过"滚了没变化"（实际列表滚上去了）。
 *   总结是概率性的；**像素比对是确定性的** —— 变了就是变了，没变就是没变，还能告诉变在哪一块。
 *
 * 【为什么不用 vision】1 次视觉调用 1~3 秒 + 花钱 + 会说谎；纯像素比对几毫秒、免费、不会说谎。
 *
 * 【本模块只做纯计算】吃两张同尺寸的 BGRA buffer（nativeImage.toBitmap() 的输出），
 *   输出"变了多少、变在哪"。electron 相关的取图/缩放放在 assistant.js 里 —— 这样本模块能纯 Node 测。
 */
'use strict';

const DEF = {
  /* 单个像素算不算"变了"：BGRA 四个通道的差值之和超过这个阈值才算。
     取 24 是实测折中：低于它主要是 JPEG/缩放噪声，高于它就是真实的界面变化。 */
  pixelThreshold: 24,
  /* 变化像素占比超过这个比例才算"界面变了"。0.2% 用来滤掉抗锯齿/风扇式抖动。 */
  changedRatio: 0.002,
};

/* a、b 是同尺寸的 BGRA buffer（长度 = w*h*4）。
 * 返回 { changed, ratio, changedPixels, total, box?, meanDelta } */
function diffBgra(a, b, w, h, opts) {
  const o = Object.assign({}, DEF, opts || {});
  const total = w * h;
  if (!a || !b || a.length < total * 4 || b.length < total * 4) {
    return { ok: false, error: 'buffer 尺寸不对（期望 ' + (total * 4) + ' 字节，拿到 ' + (a ? a.length : 'null') + '/' + (b ? b.length : 'null') + '）' };
  }
  let changed = 0, sum = 0;
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let i = 0, p = 0; i < total; i++, p += 4) {
    const d = Math.abs(a[p] - b[p]) + Math.abs(a[p + 1] - b[p + 1]) + Math.abs(a[p + 2] - b[p + 2]) + Math.abs(a[p + 3] - b[p + 3]);
    sum += d;
    if (d > o.pixelThreshold) {
      changed++;
      const x = i % w, y = (i - x) / w;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  const ratio = total ? changed / total : 0;
  const box = maxX >= 0 ? { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 } : null;
  return {
    ok: true,
    changed: ratio >= o.changedRatio,
    ratio: Math.round(ratio * 10000) / 10000,     // 0.0123 = 1.23%
    changedPixels: changed,
    total,
    box,
    meanDelta: Math.round((sum / (total || 1)) * 100) / 100,
    threshold: o.changedRatio,
  };
}

/* 把"变化区域"按原图比例还原（比对用的是缩小的图） */
function scaleBox(box, k) {
  if (!box) return null;
  return { x: Math.round(box.x * k), y: Math.round(box.y * k), w: Math.round(box.w * k), h: Math.round(box.h * k) };
}

/* 给模型/人看的一句话 */
function summarize(r, secs, scale) {
  if (!r.ok) return '⚠️ 帧比对失败：' + r.error;
  const pct = (r.ratio * 100).toFixed(2) + '%';
  if (!r.changed) {
    return '📊 对比 ' + secs + ' 秒前后的两帧：**界面没有变化**（差异 ' + pct + '，低于阈值 '
      + (r.threshold * 100).toFixed(1) + '%，属于噪声）。'
      + '说明你刚才那一下**没生效** —— 换个做法：换坐标、先点一下让目标窗口拿到焦点、或者用 drag 拖动。**不要再用同一个动作重复。**';
  }
  let where = '';
  if (r.box) {
    const b = scale ? scaleBox(r.box, scale) : r.box;
    where = '，变化主要集中在整屏 (' + b.x + ',' + b.y + ') - (' + (b.x + b.w) + ',' + (b.y + b.h) + ') 这一块';
  }
  return '📊 对比 ' + secs + ' 秒前后的两帧：**界面变了**（差异 ' + pct + '，约 ' + r.changedPixels + ' 个像素' + where + '）。'
    + '说明你刚才那一下**生效了** —— 接着做下一步（先 screen_look 看清变成什么样了）。';
}

module.exports = { diffBgra, summarize, scaleBox, DEFAULTS: DEF };
