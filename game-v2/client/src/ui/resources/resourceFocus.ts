/**
 * Open the field guide's Resources entry for one item from anywhere (the build views' "3 alloy plate short" links).
 * The game menu registers how to open itself; the dictionary takes the pending id when it draws and opens that row.
 */

let opener: ((id: string) => void) | null = null;
let pending: string | null = null;

/** The game registers how to open the guide on the Resources tab (once, when the menu exists) */
export function setResourceOpener(fn: ((id: string) => void) | null): void {
  opener = fn;
}

/** Open the Resources entry for `id`; false if the menu isn't there to do it */
export function openResource(id: string): boolean {
  if (!opener) return false;
  pending = id;
  opener(id);
  return true;
}

/** The id waiting to be shown (read once by the dictionary) */
export function takePendingResource(): string | null {
  const id = pending;
  pending = null;
  return id;
}
