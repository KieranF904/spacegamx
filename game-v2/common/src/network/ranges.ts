/**
 * A list of whole numbers as runs of one-more-than-the-last: [start, count, start, count, ...]. A list that mostly
 * counts up (a system's asteroid ids and indices) is a few numbers; any other list still round trips, just longer.
 */
export function packRanges(values: readonly number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < values.length;) {
    let j = i;
    while (j + 1 < values.length && values[j + 1] === values[j] + 1) j++;
    out.push(values[i], j - i + 1);
    i = j + 1;
  }
  return out;
}

/** The list packRanges made (`max` caps its length, against a bad message) */
export function unpackRanges(runs: readonly number[], max = 1 << 20): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < runs.length; i += 2) {
    const start = runs[i], n = runs[i + 1];
    for (let k = 0; k < n && out.length < max; k++) out.push(start + k);
  }
  return out;
}
