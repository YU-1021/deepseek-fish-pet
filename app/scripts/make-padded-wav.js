/* 造一个"3秒静音 + 说话 + 3秒静音"的 16kHz 单声道 WAV，用来验 VAD */
const fs = require('fs');
const path = require('path');

const src = path.join(process.env.TEMP, 'asr-test.wav');
const dst = path.join(process.env.TEMP, 'asr-padded.wav');
const b = fs.readFileSync(src);

// 找 fmt / data
let off = 12, dataOff = -1, dataLen = 0, rate = 16000, ch = 1;
while (off + 8 <= b.length) {
  const id = b.toString('ascii', off, off + 4);
  const sz = b.readUInt32LE(off + 4);
  if (id === 'fmt ') { ch = b.readUInt16LE(off + 8 + 2); rate = b.readUInt32LE(off + 8 + 4); }
  if (id === 'data') { dataOff = off + 8; dataLen = sz; break; }
  off += 8 + sz + (sz % 2);
}
const frame = 2 * ch;
const secs = Number(process.argv[2] || 3);
const silence = Buffer.alloc(Math.round(rate * secs) * frame, 0);   // 前后各 N 秒静音
const speech = b.slice(dataOff, dataOff + dataLen);
const out = Buffer.concat([b.slice(0, dataOff), silence, speech, silence]);
out.writeUInt32LE(out.length - dataOff, dataOff - 4);
out.writeUInt32LE(out.length - 8, 4);

fs.writeFileSync(dst, out);
console.log('源:', Math.round(b.length / 1024) + 'KB  说话 ' + (dataLen / frame / rate).toFixed(1) + 's');
console.log('产出:', Math.round(out.length / 1024) + 'KB  总计 ' + ((silence.length * 2 + dataLen) / frame / rate).toFixed(1) + 's（前后各 3s 静音）');
console.log('路径:', dst);
