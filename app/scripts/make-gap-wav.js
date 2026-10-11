/* 造"说话 + 句中 3 秒静音 + 说话"的 WAV：验 VAD 对**句中停顿**的作用
   （首尾静音会被应用自己的能量裁剪掐掉，所以只有句中停顿能体现 VAD 的增量） */
const fs = require('fs');
const path = require('path');

const src = path.join(process.env.TEMP, 'asr-test.wav');
const dst = path.join(process.env.TEMP, 'asr-gap.wav');
const b = fs.readFileSync(src);

let off = 12, dataOff = -1, dataLen = 0, rate = 16000, ch = 1;
while (off + 8 <= b.length) {
  const id = b.toString('ascii', off, off + 4);
  const sz = b.readUInt32LE(off + 4);
  if (id === 'fmt ') { ch = b.readUInt16LE(off + 8 + 2); rate = b.readUInt32LE(off + 8 + 4); }
  if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
  off += 8 + sz + (sz % 2);
}
const frame = 2 * ch;
const speech = b.slice(dataOff, dataOff + dataLen);
const half = Math.floor(speech.length / 2 / frame) * frame;          // 对齐到帧
const gap = Buffer.alloc(Math.round(rate * 3) * frame, 0);           // 句中 3 秒静音
const out = Buffer.concat([b.slice(0, dataOff), speech.slice(0, half), gap, speech.slice(half)]);
out.writeUInt32LE(out.length - dataOff, dataOff - 4);
out.writeUInt32LE(out.length - 8, 4);
fs.writeFileSync(dst, out);
console.log('产出: ' + path.basename(dst) + '  ' + Math.round(out.length / 1024) + 'KB  （说话 2.9s + 静音 3s + 说话 2.9s）');
