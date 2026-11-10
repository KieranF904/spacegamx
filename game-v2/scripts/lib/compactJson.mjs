// JSON for data files: indent 1, but a number array, or an array of number arrays (an outline of [x,y] points), sits on
// one line. JSON.parse of the result equals JSON.parse of JSON.stringify(v), only far fewer lines.
const isNum = (x) => typeof x === 'number';
const flat = (a) => Array.isArray(a) && a.length > 0 && (a.every(isNum) || a.every((r) => Array.isArray(r) && r.length > 0 && r.every(isNum)));

export function compactJson(value) {
  const out = (v, pad) => {
    if (flat(v)) return JSON.stringify(v).replace(/\],\[/g, '], [');
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      const p = `${pad} `;
      return `[\n${v.map((x) => p + out(x, p)).join(',\n')}\n${pad}]`;
    }
    if (v !== null && typeof v === 'object') {
      const keys = Object.keys(v).filter((k) => v[k] !== undefined);
      if (!keys.length) return '{}';
      // (a small record of plain values stays on one line)
      if (keys.every((k) => v[k] === null || typeof v[k] !== 'object' || flat(v[k]))) {
        const one = `{ ${keys.map((k) => `${JSON.stringify(k)}: ${out(v[k], '')}`).join(', ')} }`;
        if (one.length <= 110) return one;
      }
      const p = `${pad} `;
      return `{\n${keys.map((k) => `${p}${JSON.stringify(k)}: ${out(v[k], p)}`).join(',\n')}\n${pad}}`;
    }
    return JSON.stringify(v) ?? 'null';
  };
  return out(value, '') + '\n';
}
