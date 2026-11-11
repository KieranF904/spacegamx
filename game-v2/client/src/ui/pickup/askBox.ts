/**
 * A small box asking for one value (a target amount, a template's name) next to where it was asked for: Enter or OK
 * gives it, Esc or a click away drops it. One at a time.
 */

let open: HTMLDivElement | null = null;
let styled = false;

function injectStyles(): void {
  if (styled) return;
  styled = true;
  const css = document.createElement('style');
  css.textContent = `
.sga { position: fixed; z-index: 1300; display: flex; gap: 6px; align-items: center; padding: 6px 8px; border-radius: 8px; background: rgba(9, 15, 28, 0.98);
  border: 1px solid rgba(125, 211, 252, 0.5); box-shadow: 0 6px 20px rgba(0, 0, 0, 0.55); font: 12px 'Segoe UI', sans-serif; color: #c9d4e5; }
.sga input { width: 120px; padding: 3px 6px; border-radius: 5px; background: rgba(4, 8, 16, 0.8); border: 1px solid rgba(140, 170, 220, 0.35); color: #e8f0fb; font: inherit; }
.sga input[type=number] { width: 70px; }
.sga button { all: unset; cursor: pointer; padding: 3px 10px; border-radius: 999px; border: 1px solid rgba(125, 211, 252, 0.45); color: #bae6fd; }
.sga button:hover { background: rgba(125, 211, 252, 0.15); }
`;
  document.head.appendChild(css);
}

export function closeAsk(): void {
  open?.remove();
  open = null;
}

/** Ask for a value at (x, y); `done` gets it trimmed (nothing for an empty answer) */
export function askValue(x: number, y: number, label: string, kind: 'number' | 'text', initial: string, done: (v: string) => void): void {
  injectStyles();
  closeAsk();
  const box = document.createElement('div');
  box.className = 'sga';
  const l = document.createElement('span');
  l.textContent = label;
  const input = document.createElement('input');
  input.type = kind;
  if (kind === 'number') input.min = '1';
  else input.maxLength = 32;
  input.value = initial;
  const ok = document.createElement('button');
  ok.type = 'button';
  ok.textContent = 'OK';
  const give = () => { const v = input.value.trim(); closeAsk(); if (v) done(v); };
  ok.onclick = give;
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); give(); } else if (e.key === 'Escape') closeAsk();
  });
  box.append(l, input, ok);
  document.body.appendChild(box);
  const r = box.getBoundingClientRect();
  box.style.left = `${Math.max(8, Math.min(x, innerWidth - r.width - 8))}px`;
  box.style.top = `${Math.max(8, Math.min(y, innerHeight - r.height - 8))}px`;
  open = box;
  input.focus();
  input.select();
  const away = (e: MouseEvent) => { if (open && !open.contains(e.target as Node)) { closeAsk(); window.removeEventListener('mousedown', away); } };
  setTimeout(() => window.addEventListener('mousedown', away), 0);
}
