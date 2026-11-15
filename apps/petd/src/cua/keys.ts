/** 键名 ↔ Windows 虚拟键码；以及 key 工具的参数解析。 */

const LETTERS: Record<string, number> = {
  a: 0x41, b: 0x42, c: 0x43, d: 0x44, e: 0x45, f: 0x46, g: 0x47, h: 0x48, i: 0x49,
  j: 0x4a, k: 0x4b, l: 0x4c, m: 0x4d, n: 0x4e, o: 0x4f, p: 0x50, q: 0x51, r: 0x52,
  s: 0x53, t: 0x54, u: 0x55, v: 0x56, w: 0x57, x: 0x58, y: 0x59, z: 0x5a,
};

const NAMED: Record<string, number> = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, meta: 0x5b,
  enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b, space: 0x20,
  backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, ins: 0x2d,
  home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27,
  capslock: 0x14, numlock: 0x90, scrolllock: 0x91, printscreen: 0x2c,
  pause: 0x13, menu: 0x5d, apps: 0x5d,
  semicolon: 0xba, ';': 0xba, equal: 0xbb, '=': 0xbb, comma: 0xbc, ',': 0xbc,
  minus: 0xbd, '-': 0xbd, period: 0xbe, '.': 0xbe, slash: 0xbf, '/': 0xbf,
  backtick: 0xc0, '`': 0xc0, bracketleft: 0xdb, '[': 0xdb, backslash: 0xdc, '\\': 0xdc,
  bracketright: 0xdd, ']': 0xdd, quote: 0xde, "'": 0xde,
};

/** 给模型看的键名说明（按 Windows 习惯） */
export const KEY_HELP =
  '键名用 Windows 习惯：a–z、0–9、enter、tab、esc、space、backspace、delete、insert、home、end、pageup、pagedown、up/down/left/right、f1–f12、ctrl、shift、alt、win、以及 ; , . / - = [ ] \\ \' `。';

export function vkOf(name: string): number | null {
  const key = name.trim().toLowerCase();
  if (!key) return null;
  if (LETTERS[key] !== undefined) return LETTERS[key]!;
  if (NAMED[key] !== undefined) return NAMED[key]!;
  if (/^[0-9]$/.test(key)) return 0x30 + Number(key);
  if (/^f([1-9]|1[0-2])$/.test(key)) return 0x70 + (Number(key.slice(1)) - 1);
  return null;
}

export interface ParsedChords {
  /** 每个组合内部的键码（+ 表示同按） */
  chords: number[][];
  /** 按住（只允许单组合） */
  hold: boolean;
}

/** 解析 "ctrl+s"、"ctrl+shift+esc"、"win+r"、"按空格分隔多个组合" */
export function parseChords(text: string): ParsedChords {
  const groups = text
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (groups.length === 0) throw new Error('keys 不能为空');
  const chords: number[][] = [];
  for (const group of groups) {
    const parts = group.split('+').filter((p) => p.length > 0);
    if (parts.length === 0) throw new Error(`无法解析按键组合：${group}`);
    const vks: number[] = [];
    for (const part of parts) {
      const vk = vkOf(part);
      if (vk === null) throw new Error(`不认识的键：${part}`);
      vks.push(vk);
    }
    chords.push(vks);
  }
  const hold = chords.length === 1 && chords[0]!.length === 1;
  return { chords, hold };
}

/** 按住组合时只允许一个键 */
export function parseHoldChord(text: string): number {
  const parsed = parseChords(text);
  if (parsed.chords.length !== 1 || parsed.chords[0]!.length !== 1) {
    throw new Error('hold 只支持单个键，例如 key { keys: "a", hold: true }');
  }
  return parsed.chords[0]![0]!;
}
