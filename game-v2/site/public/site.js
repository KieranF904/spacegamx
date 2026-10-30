// Space Game website: the small bits of behaviour (no framework). Every page
// works without this; it adds the live shoutbox, in-place votes, the live pilot
// count, relative times and the admin editor's preview and uploads.
(() => {
  'use strict';
  const csrf = document.querySelector('meta[name="csrf-token"]')?.content ?? '';
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  async function post(url, body, opts = {}) {
    const r = await fetch(url, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'X-CSRF-Token': csrf, Accept: 'application/json', ...(opts.raw ? { 'Content-Type': opts.type } : { 'Content-Type': 'application/json' }) },
      body: opts.raw ? body : JSON.stringify(body),
    });
    let data = {};
    try { data = await r.json(); } catch { /* not JSON */ }
    if (!r.ok) throw new Error(data.error || `Something went wrong (${r.status})`);
    return data;
  }

  // ---------------------------------------------------------------- relative times
  function ago(iso) {
    const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
    if (s < 45) return 'just now';
    const m = Math.round(s / 60); if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60); if (h < 24) return `${h} h ago`;
    const d = Math.round(h / 24); if (d < 30) return `${d} ${d === 1 ? 'day' : 'days'} ago`;
    return new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }
  const refreshTimes = () => $$('time[data-rel]').forEach((t) => { t.textContent = ago(t.dateTime); });
  setInterval(refreshTimes, 30_000);

  // ---------------------------------------------------------------- live pilots
  function setLive(players, online) {
    $$('[data-live]').forEach((el) => {
      el.classList.remove('live-on', 'live-idle', 'live-offline');
      el.classList.add(!online ? 'live-offline' : players > 0 ? 'live-on' : 'live-idle');
      const text = $('[data-live-text]', el);
      if (text) text.textContent = !online ? 'Server offline' : `${players} ${players === 1 ? 'pilot' : 'pilots'} online`;
    });
  }
  if ($('[data-live]')) {
    const poll = async () => {
      if (document.hidden) return;
      try { const r = await fetch('/api/v1/status', { headers: { Accept: 'application/json' } }); const d = await r.json(); setLive(d.players, d.online); } catch { /* keep the last */ }
    };
    setInterval(poll, 20_000);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) poll(); });
  }

  // ---------------------------------------------------------------- shoutbox
  const box = $('[data-shoutbox]');
  if (box) {
    const list = $('[data-shouts]', box);
    const emptyNote = $('[data-shouts-empty]', box);
    const state = $('[data-sb-state]', box);
    const admin = box.dataset.admin === '1';
    const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 60;
    const toBottom = () => { list.scrollTop = list.scrollHeight; };

    const line = (s, fresh) => {
      const li = document.createElement('li');
      li.dataset.id = s.id;
      if (fresh) li.className = 'fresh';
      const name = document.createElement('span');
      name.className = 'sh-name' + (s.admin ? ' admin' : '');
      name.textContent = s.name;
      const text = document.createElement('span');
      text.className = 'sh-text';
      text.textContent = s.text;
      const time = document.createElement('time');
      time.dateTime = s.at; time.dataset.rel = ''; time.title = new Date(s.at).toUTCString(); time.textContent = ago(s.at);
      li.append(name, text, time);
      if (admin) {
        const del = document.createElement('button');
        del.type = 'button'; del.className = 'sh-del'; del.textContent = 'delete';
        del.setAttribute('aria-label', `Delete ${s.name}'s message`);
        del.addEventListener('click', async () => {
          try { await post(`/shoutbox/${s.id}/delete`, {}); li.remove(); showEmpty(); } catch (e) { alert(e.message); }
        });
        li.append(del);
      }
      return li;
    };
    const showEmpty = () => { if (emptyNote) emptyNote.hidden = list.children.length > 0; };

    if ('EventSource' in window) {
      const es = new EventSource('/shoutbox/stream');
      es.addEventListener('history', (ev) => {
        const items = JSON.parse(ev.data);
        list.replaceChildren(...items.map((s) => line(s, false)));
        showEmpty(); toBottom();
      });
      es.addEventListener('shout', (ev) => {
        const s = JSON.parse(ev.data);
        if (list.querySelector(`[data-id="${CSS.escape(String(s.id))}"]`)) return;
        const stick = nearBottom();
        list.append(line(s, true));
        while (list.children.length > 80) list.firstElementChild.remove();
        showEmpty();
        if (stick) toBottom();
      });
      es.addEventListener('delete', (ev) => {
        const { id } = JSON.parse(ev.data);
        list.querySelector(`[data-id="${CSS.escape(String(id))}"]`)?.remove();
        showEmpty();
      });
      es.onopen = () => { if (state) { state.textContent = 'live'; state.classList.remove('off'); } };
      es.onerror = () => { if (state) { state.textContent = 'reconnecting'; state.classList.add('off'); } };
    } else toBottom();

    const form = $('[data-shout-form]', box);
    if (form) {
      const input = $('input[name="text"]', form);
      const count = $('[data-count]', form);
      const err = $('[data-shout-error]', form);
      const max = Number(input.maxLength) || 280;
      const upd = () => { const left = max - input.value.length; count.textContent = left; count.classList.toggle('low', left < 30); };
      input.addEventListener('input', upd);
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        const btn = $('button[type="submit"]', form);
        btn.disabled = true; err.hidden = true;
        try {
          const r = await post('/shoutbox', { text });
          input.value = ''; upd();
          if (r.shout && !list.querySelector(`[data-id="${CSS.escape(String(r.shout.id))}"]`)) { list.append(line(r.shout, true)); showEmpty(); }
          toBottom();
        } catch (e) { err.textContent = e.message; err.hidden = false; }
        finally { btn.disabled = false; input.focus(); }
      });
    }
  }

  // ---------------------------------------------------------------- votes
  $$('form[data-vote]').forEach((form) => {
    form.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const btn = $('button', form);
      const onField = $('input[name="on"]', form);
      const on = onField.value === '1';
      btn.disabled = true;
      try {
        const r = await post(form.action, { on });
        const n = $('[data-votes]', btn);
        n.textContent = r.votes;
        btn.classList.toggle('voted', r.voted);
        btn.setAttribute('aria-pressed', String(r.voted));
        btn.setAttribute('aria-label', `${r.voted ? 'Remove your vote' : 'Vote for this'} (${r.votes} ${r.votes === 1 ? 'vote' : 'votes'})`);
        btn.title = r.voted ? 'Remove your vote' : 'Vote for this';
        onField.value = r.voted ? '0' : '1';
        btn.classList.remove('bump'); void btn.offsetWidth; btn.classList.add('bump');
      } catch (e) { alert(e.message); }
      finally { btn.disabled = false; }
    });
  });

  // ---------------------------------------------------------------- confirmations
  $$('form[data-confirm]').forEach((f) => f.addEventListener('submit', (ev) => { if (!confirm(f.dataset.confirm)) ev.preventDefault(); }));
  $$('form[data-confirm-delete]').forEach((f) => {
    const want = f.dataset.confirmDelete.toLowerCase();
    const input = $('[data-confirm-input]', f);
    const btn = $('[data-confirm-button]', f);
    const upd = () => { btn.disabled = input.value.trim().toLowerCase() !== want; };
    input.addEventListener('input', upd); upd();
  });
  $$('[data-copy]').forEach((b) => b.addEventListener('click', async () => {
    const src = $('[data-copy-src]', b.parentElement);
    try { await navigator.clipboard.writeText(src.value); b.textContent = 'Copied'; } catch { src.select(); }
  }));

  // ---------------------------------------------------------------- admin editor
  const editor = $('[data-editor]');
  if (editor) {
    const src = $('[data-md-source]', editor);
    const out = $('[data-md-preview]', editor);
    let timer = 0, seq = 0;
    const preview = async () => {
      const mine = ++seq;
      try {
        const r = await post('/api/v1/preview', { body: src.value });
        // (sanitised on the server, as it will be published)
        if (mine === seq) out.innerHTML = r.html;
      } catch { /* keep the last preview */ }
    };
    src.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(preview, 250); });

    const file = $('[data-upload]', editor);
    const status = $('[data-upload-status]', editor);
    file?.addEventListener('change', async () => {
      const f = file.files?.[0];
      if (!f) return;
      status.textContent = `Uploading ${f.name}…`;
      try {
        const r = await post('/api/v1/uploads', f, { raw: true, type: f.type || 'application/octet-stream' });
        const alt = f.name.replace(/\.[a-z0-9]+$/i, '').replace(/[-_]+/g, ' ');
        const md = `\n![${alt}](${r.url})\n`;
        const at = src.selectionStart ?? src.value.length;
        src.setRangeText(md, at, src.selectionEnd ?? at, 'end');
        src.dispatchEvent(new Event('input'));
        src.focus();
        status.textContent = `Uploaded ${f.name}: ${r.url}`;
      } catch (e) { status.textContent = e.message; }
      file.value = '';
    });
  }
})();
