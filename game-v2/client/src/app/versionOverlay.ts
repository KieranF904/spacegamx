/**
 * @contract client.app.versionOverlay
 * owns:       the full-screen "a new version is out" notice shown when the server speaks another protocol
 * needs:      the DOM only
 * invariants: shown at most once per page — none pinned
 * extend:     none (a fixed notice)
 */

/** The server speaks another protocol version: say so and offer a reload (no reconnecting) */
export function showVersionOverlay(): void {
  if (document.getElementById('version-overlay')) return;
  const el = document.createElement('div');
  el.id = 'version-overlay';
  el.style.cssText = `position: fixed; inset: 0; z-index: 100000; display: flex; align-items: center; justify-content: center;
    background: rgba(2, 6, 18, 0.88); font-family: 'Segoe UI', sans-serif; color: #e2e8f0;`;
  el.innerHTML = `<div style="text-align:center; padding:28px 36px; border:1px solid rgba(148,163,184,0.3); border-radius:10px; background:rgba(15,23,42,0.95); max-width:360px">
    <div style="font-size:18px; font-weight:700; letter-spacing:1px; margin-bottom:8px">A new version is out</div>
    <div style="font-size:13px; color:#94a3b8; margin-bottom:18px">This page is older (or newer) than the server. Reload to get the current version.</div>
    <button style="font:600 14px 'Segoe UI', sans-serif; padding:8px 26px; border-radius:6px; border:none; background:#38bdf8; color:#04121f; cursor:pointer">Reload</button>
  </div>`;
  el.querySelector('button')!.addEventListener('click', () => location.reload());
  document.body.appendChild(el);
}
