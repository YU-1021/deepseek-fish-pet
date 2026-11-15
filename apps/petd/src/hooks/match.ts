/** 钩子规则匹配：名字 glob + 参数包含。 */

/** 把 glob（支持 * 和 ?）转成锚定正则；其它字符按字面量处理。 */
export function globToRegExp(pattern: string): RegExp {
  let out = '^';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += ch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  out += '$';
  return new RegExp(out);
}

const cache = new Map<string, RegExp>();

function compiled(pattern: string): RegExp {
  let re = cache.get(pattern);
  if (re === undefined) {
    re = globToRegExp(pattern);
    if (cache.size > 500) cache.clear();
    cache.set(pattern, re);
  }
  return re;
}

/** 名字是否命中任一 glob。 */
export function matchAnyName(patterns: readonly string[], name: string): boolean {
  for (const p of patterns) {
    if (compiled(p).test(name)) return true;
  }
  return false;
}

/** 参数 JSON 是否包含片段（不区分大小写）。 */
export function argsInclude(args: Record<string, unknown> | undefined, needle: string): boolean {
  if (args === undefined || needle === '') return true;
  let text: string;
  try {
    text = JSON.stringify(args);
  } catch {
    return false;
  }
  return text.toLowerCase().includes(needle.toLowerCase());
}
