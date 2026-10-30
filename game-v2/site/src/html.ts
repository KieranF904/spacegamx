/**
 * Templating that escapes by default: every value put into an html`` template
 * is escaped unless it is already SafeHtml (another html`` result, or raw(),
 * which only trusted code builds: the sanitised Markdown, fixed markup).
 */

export class SafeHtml {
  constructor(readonly value: string) {}
  toString(): string { return this.value; }
}

/** Trusted markup as is (never user text) */
export const raw = (s: string): SafeHtml => new SafeHtml(s);

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' };

/** Escape text for an element body or a quoted attribute */
export function esc(v: unknown): string {
  return String(v ?? '').replace(/[&<>"'`]/g, (c) => ESC[c]);
}

function part(v: unknown): string {
  if (v === null || v === undefined || v === false || v === true) return '';
  if (v instanceof SafeHtml) return v.value;
  if (Array.isArray(v)) return v.map(part).join('');
  return esc(v);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): SafeHtml {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += part(values[i]) + strings[i + 1];
  return new SafeHtml(out);
}

/** A JSON value safe inside a data- attribute */
export function jsonAttr(v: unknown): string {
  return esc(JSON.stringify(v));
}
