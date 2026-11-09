/**
 * The station window's way into the gun range (any station's Overview): one button that asks the server to take you in
 * (gunRangeEnter; it checks you are berthed here, and says why not in gunRangeState.error).
 */

import type { ClientMessage } from '@space-game/common';

export function gunRangeButton(send: (m: ClientMessage) => void, sound: (id: string, v?: number) => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = 'sgw-btn';
  b.textContent = 'Gun range';
  b.title = 'Try any weapon you can fit on a range ship, against idle drones, a big soft-hulled wreck and a heavy Mammoth. Your own ship waits here untouched; nothing from the range comes back with you';
  b.onclick = () => {
    b.disabled = true;
    send({ type: 'gunRangeEnter' });
    sound('ui_click', 0.5);
    // (The station screen closes once the server takes you in; a refusal comes back as a toast)
    setTimeout(() => { b.disabled = false; }, 1500);
  };
  return b;
}
