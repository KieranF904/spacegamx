// The step log: one block per lane and round (prompt, reply, what the reader and validator said, power, score, critic).

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const secs = (ms) => `${(ms / 1000).toFixed(1)} s`;
const fold = (title, body, open = false) => `<details${open ? ' open' : ''}><summary>${title}</summary><pre>${esc(body)}</pre></details>`;

export class StepLog {
  constructor(el, follow) {
    this.el = el; this.follow = follow; this.steps = new Map();
  }

  clear() { this.el.innerHTML = ''; this.steps.clear(); }

  step(lane, round) {
    const key = `${lane ?? ''}|${round ?? 0}`;
    let s = this.steps.get(key);
    if (!s) {
      s = document.createElement('details');
      s.className = 'step'; s.open = true;
      s.innerHTML = `<summary>${lane ? `<span class="muted">${esc(lane)}</span> ` : ''}${round ? `round ${round}` : 'run'}<span class="badges"></span></summary>`;
      this.el.appendChild(s);
      this.steps.set(key, s);
      // (Older rounds fold away)
      if (this.steps.size > 3) [...this.steps.values()].slice(0, -3).forEach((x) => { x.open = false; });
    }
    return s;
  }

  add(lane, round, html, cls = '') {
    const d = document.createElement('div');
    d.className = `ev ${cls}`; d.innerHTML = html;
    this.step(lane, round).appendChild(d);
    if (this.follow()) this.el.scrollTop = this.el.scrollHeight;
  }

  badge(lane, round, text, cls) {
    this.step(lane, round).querySelector('.badges').insertAdjacentHTML('beforeend', `<span class="badge ${cls ?? ''}">${esc(text)}</span>`);
  }

  event(e) {
    const L = e.lane, R = e.round;
    switch (e.type) {
      case 'start':
        this.add(L, 0, `<b>${esc(e.mode)}</b> with ${esc(e.models?.join(' vs ') ?? e.model)}${e.critic ? `, critic ${esc(e.critic)}` : ''}; role ${esc(e.role ?? 'none')}; ${esc(e.contract)} replies; mirror ${e.mirror === false ? 'off' : 'on'}${e.build === 'staged' ? '; staged build' : ''}`);
        break;
      case 'concept': this.add(L, 0, `<b>concept</b>${e.note ? ` <span class="muted">(${esc(e.note)})</span>` : ''}: ${esc(e.line)}`, 'good'); break;
      case 'brief':
        this.add(L, 0, fold(`brief (${e.legendCodes} codes, system prompt ${e.promptChars} chars)`, e.text));
        break;
      case 'prompt':
        this.add(L, R, (e.system ? fold(`system prompt (${e.system.length} chars)`, e.system) : '') + fold(`prompt: ${e.messages} messages, ${e.chars} chars`, e.user));
        break;
      case 'reply':
        this.add(L, R, fold(`reply in ${secs(e.ms)}${e.outputTokens ? `, ${e.outputTokens} tokens` : ''}${e.tokensPerSec ? ` at ${e.tokensPerSec}/s` : ''}${e.structured ? ' (schema)' : ''}`, e.text));
        break;
      case 'grid':
        if (e.partial) break;
        if (!e.text) this.add(L, R, `unreadable: ${esc(e.errors.map((x) => x.message).join('; '))}`, 'err');
        else this.add(L, R, `read ${e.parts} parts (${esc(e.via)})${e.errors.length ? `<ul class="err">${e.errors.slice(0, 8).map((x) => `<li>${x.row !== undefined ? `row ${x.row}${x.col !== undefined ? ` col ${x.col}` : ''}: ` : ''}${esc(x.message)}</li>`).join('')}</ul>` : ''}${e.warnings.length ? `<ul class="note">${e.warnings.slice(0, 5).map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : ''}`, e.errors.length ? 'err' : '');
        if (e.errors.length || !e.text) this.badge(L, R, 'unreadable', 'bad');
        break;
      case 'check': {
        const r = e.result, p = r.power;
        const errs = r.errors.length ? `<ul>${r.errors.slice(0, 8).map((x) => `<li>${esc(x.message)}</li>`).join('')}${r.errors.length > 8 ? `<li>... ${r.errors.length - 8} more</li>` : ''}</ul>` : '';
        const pw = p ? `power: ${p.generation} E/s made, ${p.storage} E stored; cruise ${p.thrust.cruisePct}%, boost ${p.thrust.boostPct}%; ${p.unpowered.length} unpowered, ${p.bottlenecks.length} bottlenecks` +
          (p.weapons.length ? `<br>weapons sustained: ${p.weapons.map((w) => `${esc(w.code)} ${Math.round(w.pctLong)}%`).join(', ')}` : '') : 'power: not run';
        const unmet = e.brief?.unmet.length ? `<br>brief unmet: ${esc(e.brief.unmet.join('; '))}` : '';
        this.add(L, R, `<b>${e.valid ? 'valid' : 'not valid'}</b>, check ${e.score}${errs}<div class="muted">${pw}${unmet}</div>`, e.valid ? 'good' : 'err');
        this.step(L, R).classList.add(e.valid ? 'valid' : 'invalid');
        this.badge(L, R, e.valid ? 'valid' : 'invalid', e.valid ? 'good' : 'bad');
        break;
      }
      case 'feedback': this.add(L, R, fold('feedback to the model', e.text)); break;
      case 'render': this.add(L, R, `still rendered in ${e.ms} ms`, 'note'); break;
      case 'critic': this.add(L, R, `critic ${esc(e.model)}: looks ${e.looks ?? '?'}/10, ${esc(e.reason)} (${secs(e.ms)})`); break;
      case 'score':
        this.add(L, R, `score <b>${e.score}</b> <span class="muted">(check ${e.parts.check}${e.parts.briefPenalty ? `, brief -${e.parts.briefPenalty}` : ''}${e.parts.asymmetry ? `, asymmetry -${e.parts.asymmetry}` : ''}${e.parts.looks ? `, looks ${e.parts.looks}/10` : ''})</span>`);
        this.badge(L, R, String(e.score));
        break;
      case 'best': this.add(L, R, `best so far: "${esc(e.name)}" ${e.score}${e.valid ? ' (valid)' : ''}`, 'good'); break;
      case 'step': this.add(L, R || 0, `<b>step ${e.index}/${e.of}: ${esc(e.step)}</b> ${esc(e.status)}${e.note ? ` <span class="muted">(${esc(e.note)})</span>` : ''}`, e.status === 'accepted' ? 'good' : e.status === 'failed' ? 'err' : ''); break;
      case 'mutation': this.add(L, 0, `gen ${e.gen} child ${e.child} from ${esc(e.parent)}: ${esc(e.instruction)}`); break;
      case 'generation': this.add(L, 0, `generation ${e.gen}: ${e.population.map((p) => `${esc(p.id)} ${p.score}${p.valid ? '' : ' (invalid)'}`).join(', ')}`); break;
      case 'error': this.add(L, R, `${e.fatal ? 'stopped: ' : ''}${esc(e.message)}`, 'err'); break;
      case 'batch': {
        const what = e.phase === 'design' ? `ship #${e.attempt} (${esc(e.role)}): designing` : e.phase === 'refine' ? `ship #${e.attempt}: refining` : e.phase === 'saved' ? `ship #${e.attempt}: saved "${esc(e.ship?.name)}" score ${e.ship?.score} (${e.minutes} min)`
          : e.phase === 'rejected' ? `ship #${e.attempt}: rejected (${esc((e.why ?? []).join('; '))})` : e.phase === 'error' ? `ship #${e.attempt}: error ${esc(e.message)}` : e.phase === 'waiting' ? `waiting ${e.waitS} s: ${esc(e.message)}` : `batch stopped: ${esc(e.reason)}`;
        this.add(`#${e.attempt}`, 0, `<b>batch</b> ${what} <span class="muted">(${e.saved} saved of ${e.attempts})</span>`, e.phase === 'saved' ? 'good' : e.phase === 'rejected' || e.phase === 'error' ? 'err' : 'note');
        break;
      }
      case 'done': this.add(L, 0, `done${e.cancelled ? ' (stopped)' : ''}`, 'good'); break;
    }
  }
}
