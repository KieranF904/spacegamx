/**
 * @contract client.ui.escape
 * owns:       the one HTML escaper for client UI strings (element content and either-quote attributes)
 * needs:      nothing
 * invariants: escapes & < > " ' and a local copy fails the test — client/src/ui/escape.test.ts
 * extend:     there is nothing to extend: do not define a local copy
 */

/**
 * The one HTML escaper for the client UI: & < > " ' (so text is safe in element content and in attributes
 * delimited by either quote). Takes anything and stringifies it. Don't define a local copy: escape.test.ts fails if you do.
 */
export function esc(s: unknown): string {
  return String(s).replace(/[&<>"']/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;'));
}
