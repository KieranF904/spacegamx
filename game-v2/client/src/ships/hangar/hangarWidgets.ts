/** Little DOM helpers for the hangar's panels and bar */

export function btnCss(bg: string): string {
  return `background:${bg}; color:#fff; border:1px solid rgba(255,255,255,0.15); border-radius:6px; padding:6px 10px; cursor:pointer; font:12px 'Segoe UI', sans-serif; flex:1;`;
}

export function label(text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.textContent = text;
  s.style.color = '#8ea0bd';
  return s;
}

/** A section heading that folds its section away (▸ folded, ▾ open) */
export function foldHeading(text: string, folded: boolean, onToggle: () => void): HTMLDivElement {
  const d = heading(`${folded ? '▸' : '▾'} ${text}`);
  d.style.cursor = 'pointer';
  d.onclick = onToggle;
  return d;
}

export function heading(text: string): HTMLDivElement {
  const d = document.createElement('div');
  d.textContent = text.toUpperCase();
  d.style.cssText = 'color:#ffb547; font-weight:bold; letter-spacing:1px; margin: 2px 0 5px; font-size: 11px;';
  return d;
}

export function button(text: string, onClick: () => void, bg = '#1a2540'): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = text;
  b.style.cssText = `background:${bg}; color:#e5ecf7; border:1px solid #2a3a5a; border-radius:4px; padding:5px 10px; cursor:pointer;`;
  b.onclick = onClick;
  return b;
}

export function chip(text: string, active: boolean, color: string, onClick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.innerHTML = `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${color};margin-right:5px;vertical-align:-1px"></span>${text}`;
  b.style.cssText = `background:${active ? '#24406b' : '#0f1626'}; color:#cfd8e6; border:1px solid ${active ? '#5fd4c4' : '#2a3a5a'};
    border-radius:4px; padding:3px 7px; cursor:pointer; font-size: 11px;`;
  b.onclick = onClick;
  return b;
}

export function checkbox(text: string, value: boolean, onChange: (v: boolean) => void): HTMLLabelElement {
  const l = document.createElement('label');
  l.style.cssText = 'display:block; margin-bottom:4px; cursor:pointer;';
  const i = document.createElement('input');
  i.type = 'checkbox';
  i.checked = value;
  i.style.marginRight = '6px';
  i.onchange = () => onChange(i.checked);
  l.append(i, text);
  return l;
}
