// Space Game website: the small bits of behaviour (no framework). Every page
// works without this; it adds the live shoutbox, in-place votes, the image viewer, the live pilot
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

  // ---------------------------------------------------------------- image viewer
  // Images in a post open large in a dialog, with that image's comments beside them. The comments are read from the
  // post's own list (so the page and the viewer never disagree); a new one is posted with fetch and added to both.
  const prose = $('.post .prose');
  // (The post's cover opens too: first, unless it's one of the body's own images, which it then opens at)
  const bodyPics = prose && 'HTMLDialogElement' in window ? $$('.pic > img', prose) : [];
  const coverImg = 'HTMLDialogElement' in window ? $('.post-cover-lg img[data-cover]') : null;
  const coverTwin = coverImg ? bodyPics.find((img) => img.getAttribute('src') === coverImg.getAttribute('src')) : null;
  const pics = coverImg && !coverTwin ? [coverImg, ...bodyPics] : bodyPics;
  const list = $('[data-comment-list]');
  if (pics.length && list) {
    const emptyNote = $('[data-comments-empty]');
    const total = $('[data-comment-total]');
    const srcOf = (img) => img.getAttribute('src');
    const commentsOn = (src) => $$('.comment[data-image]', list).filter((li) => li.dataset.image === src);
    const bubble = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12v8H8l-3 3v-3H2z" fill="currentColor"/></svg>';
    const arrow = (d) => `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="${d}" fill="none" stroke="currentColor" stroke-width="2"/></svg>`;

    // The count badge on each image
    const refreshBadges = () => pics.forEach((img) => {
      const mine = commentsOn(srcOf(img));
      let badge = $('.pic-count', img.parentElement);
      if (!mine.length) { badge?.remove(); return; }
      if (!badge) { badge = document.createElement('a'); badge.className = 'pic-count'; img.after(badge); }
      const label = `${mine.length} ${mine.length === 1 ? 'comment' : 'comments'} on this image`;
      badge.href = `#${mine[0].id}`;
      badge.title = label;
      badge.setAttribute('aria-label', label);
      badge.innerHTML = `${bubble}<span>${mine.length}</span>`;
    });

    const dlg = document.createElement('dialog');
    dlg.className = 'lb';
    dlg.setAttribute('aria-label', 'Image viewer');
    dlg.innerHTML = `<div class="lb-shell">
      <div class="lb-main">
        <div class="lb-bar">
          <span class="lb-count" data-lb-count aria-live="polite"></span>
          <button type="button" class="btn btn-sm" data-lb-zoom hidden>Full size</button>
          <button type="button" class="btn btn-sm" data-lb-close autofocus>Close</button>
        </div>
        <div class="lb-frame" data-lb-frame><img class="lb-img" alt="" draggable="false" data-lb-img></div>
        <button type="button" class="btn lb-nav lb-prev" data-lb-step="-1" aria-label="Previous image">${arrow('M10 2 4 8l6 6')}</button>
        <button type="button" class="btn lb-nav lb-next" data-lb-step="1" aria-label="Next image">${arrow('M6 2l6 6-6 6')}</button>
        <p class="lb-caption" data-lb-caption></p>
      </div>
      <aside class="lb-side" aria-labelledby="lb-side-h">
        <h2 id="lb-side-h">Comments <span class="dim" data-lb-n></span></h2>
        <p class="lb-empty" data-lb-empty>No comments on this image yet.</p>
        <ol class="comment-list lb-comments" data-lb-comments></ol>
        <div data-lb-form></div>
      </aside>
    </div>`;
    const q = (sel) => $(sel, dlg);
    const frame = q('[data-lb-frame]'), img = q('[data-lb-img]'), caption = q('[data-lb-caption]'), count = q('[data-lb-count]');
    const zoomBtn = q('[data-lb-zoom]'), shown = q('[data-lb-comments]'), none = q('[data-lb-empty]'), num = q('[data-lb-n]'), slot = q('[data-lb-form]');
    $$('[data-lb-step]', dlg).forEach((b) => { b.hidden = pics.length < 2; });
    let cur = 0, openedAt = 0, from = null, zoomed = false, dragged = false;

    // Zoom: click the image (or the button) for its full size, then drag or scroll to look around
    const syncZoom = () => {
      if (!zoomed) frame.classList.toggle('can-zoom', img.naturalWidth > img.clientWidth + 2 || img.naturalHeight > img.clientHeight + 2);
      zoomBtn.hidden = !zoomed && !frame.classList.contains('can-zoom');
    };
    const setZoom = (on, at) => {
      const r = img.getBoundingClientRect();
      const fx = at && r.width ? (at.x - r.left) / r.width : 0.5, fy = at && r.height ? (at.y - r.top) / r.height : 0.5;
      zoomed = on;
      frame.classList.toggle('zoomed', on);
      frame.classList.remove('dragging');
      zoomBtn.textContent = on ? 'Fit to screen' : 'Full size';
      // (the point that was clicked stays about where it was)
      frame.scrollLeft = on ? fx * img.offsetWidth - frame.clientWidth / 2 : 0;
      frame.scrollTop = on ? fy * img.offsetHeight - frame.clientHeight / 2 : 0;
      syncZoom();
    };
    img.addEventListener('load', syncZoom);
    window.addEventListener('resize', () => { if (dlg.open) syncZoom(); });
    img.addEventListener('click', (ev) => {
      if (dragged) return;
      if (zoomed) setZoom(false);
      else if (frame.classList.contains('can-zoom')) setZoom(true, { x: ev.clientX, y: ev.clientY });
    });
    img.addEventListener('pointerdown', (ev) => {
      // (a finger scrolls the frame by itself; the mouse drags it)
      if (!zoomed || ev.pointerType !== 'mouse' || ev.button !== 0) return;
      const x = ev.clientX, y = ev.clientY, left = frame.scrollLeft, top = frame.scrollTop;
      dragged = false;
      img.setPointerCapture(ev.pointerId);
      const move = (e) => {
        if (!dragged && Math.hypot(e.clientX - x, e.clientY - y) < 4) return;
        dragged = true;
        frame.classList.add('dragging');
        frame.scrollLeft = left - (e.clientX - x);
        frame.scrollTop = top - (e.clientY - y);
      };
      const end = () => {
        img.removeEventListener('pointermove', move);
        img.removeEventListener('pointerup', end);
        img.removeEventListener('pointercancel', end);
        frame.classList.remove('dragging');
        setTimeout(() => { dragged = false; }); // (after the click that ends the drag)
      };
      img.addEventListener('pointermove', move);
      img.addEventListener('pointerup', end);
      img.addEventListener('pointercancel', end);
      ev.preventDefault();
    });

    // This image's comments, copied from the post's list, and the form to add one
    const renderComments = () => {
      const mine = commentsOn(srcOf(pics[cur]));
      shown.replaceChildren(...mine.map((li) => {
        const c = li.cloneNode(true);
        c.removeAttribute('id'); c.removeAttribute('data-image');
        $$('.c-thumb, .inline-mod', c).forEach((x) => x.remove());
        return c;
      }));
      none.hidden = mine.length > 0;
      num.textContent = mine.length || '';
    };
    const tpl = $('template[data-image-form]');
    if (tpl) slot.append(tpl.content.cloneNode(true));
    const form = $('form', slot);
    const field = form && $('textarea', form), imageField = form && $('input[name="image"]', form), err = form && $('[data-form-error]', form);
    const drafts = new Map();
    const addComment = (itemHtml) => {
      const t = document.createElement('template');
      t.innerHTML = itemHtml.trim(); // (sanitised on the server, as the page's own comments are)
      const li = t.content.firstElementChild;
      if (!li) return;
      list.append(li);
      if (emptyNote) emptyNote.hidden = true;
      if (total) total.textContent = $$('.comment', list).length;
      refreshBadges();
      renderComments();
      shown.lastElementChild?.scrollIntoView({ block: 'nearest' });
    };
    form?.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      const body = field.value.trim();
      if (!body) return;
      const btn = $('button[type="submit"]', form);
      btn.disabled = true; err.hidden = true;
      try {
        const r = await post(form.action, { body, image: imageField.value });
        field.value = ''; drafts.delete(imageField.value);
        addComment(r.item);
      } catch (e) { err.textContent = e.message; err.hidden = false; }
      finally { btn.disabled = false; field.focus(); }
    });

    const show = (i) => {
      if (form) { drafts.set(imageField.value, field.value); }
      cur = (i + pics.length) % pics.length;
      const el = pics[cur];
      setZoom(false);
      frame.classList.remove('can-zoom');
      img.alt = el.alt;
      img.src = srcOf(el);
      caption.textContent = el.alt;
      caption.hidden = !el.alt;
      count.textContent = pics.length > 1 ? `Image ${cur + 1} of ${pics.length}` : '';
      if (form) { imageField.value = srcOf(el); field.value = drafts.get(imageField.value) ?? ''; err.hidden = true; }
      renderComments();
    };
    const open = (i, opener) => {
      from = opener; openedAt = i;
      if (!dlg.isConnected) document.body.append(dlg);
      document.documentElement.classList.add('lb-open');
      dlg.showModal(); // (focus moves into it, and Esc closes it)
      show(i);
    };
    dlg.addEventListener('close', () => {
      document.documentElement.classList.remove('lb-open');
      // Focus goes back to what opened it, or to the image it was left on
      (cur === openedAt && from?.isConnected ? from : pics[cur]).focus();
    });
    dlg.addEventListener('click', (ev) => {
      const t = ev.target;
      const step = t.closest('[data-lb-step]');
      if (step) { show(cur + Number(step.dataset.lbStep)); return; }
      if (t.closest('[data-lb-close]')) { dlg.close(); return; }
      if (t.closest('[data-lb-zoom]')) { setZoom(!zoomed); return; }
      // Outside the image and the comments
      if (!dragged && (t === dlg || t.matches('.lb-shell, .lb-main, .lb-frame, .lb-bar, .lb-caption'))) dlg.close();
    });
    dlg.addEventListener('keydown', (ev) => {
      if ((ev.key !== 'ArrowLeft' && ev.key !== 'ArrowRight') || ev.altKey || ev.ctrlKey || ev.metaKey || ev.shiftKey) return;
      if (ev.target.closest('textarea, input')) return;
      ev.preventDefault();
      show(cur + (ev.key === 'ArrowRight' ? 1 : -1));
    });

    // What opens it: an image, its badge, the thumbnail on a comment
    pics.forEach((el) => {
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      el.setAttribute('aria-label', el.alt ? `View larger: ${el.alt}` : 'View larger');
      el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(pics.indexOf(el), el); } });
    });
    const plain = (ev) => ev.button === 0 && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey;
    prose.addEventListener('click', (ev) => {
      const pic = ev.target.closest('.pic');
      if (!pic || !plain(ev)) return;
      ev.preventDefault();
      open(pics.indexOf($('img', pic)), ev.target.closest('a') || $('img', pic));
    });
    // (The cover: itself, or the body image it repeats)
    if (coverImg) {
      const at = () => pics.indexOf(coverTwin ?? coverImg);
      coverImg.tabIndex = 0; coverImg.setAttribute('role', 'button'); coverImg.setAttribute('aria-label', 'View larger');
      coverImg.addEventListener('click', (ev) => { if (!plain(ev)) return; ev.preventDefault(); open(at(), coverImg); });
      if (coverTwin) coverImg.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); open(at(), coverImg); } });
    }
    list.addEventListener('click', (ev) => {
      const link = ev.target.closest('[data-open-image]');
      const i = link && pics.findIndex((p) => srcOf(p) === link.closest('.comment').dataset.image);
      if (!link || !plain(ev) || i < 0) return;
      ev.preventDefault();
      open(i, link);
    });
  }

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
