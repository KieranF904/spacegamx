# The step log: one line or block per event (prompt, reply, what the reader and checker said, power, score), grouped by
# lane and round. Long texts (prompts, replies, feedback) show a short preview; clicking "full text" opens the whole.
import html

from PySide6.QtCore import QUrl
from PySide6.QtWidgets import QDialog, QPlainTextEdit, QTextBrowser, QVBoxLayout

esc = lambda s: html.escape(str(s if s is not None else ''))
secs = lambda ms: f'{ms / 1000:.1f} s'
GOOD, BAD, MUTED = '#5fd39a', '#ef6b6b', '#7c8896'


class StepLog(QTextBrowser):
    def __init__(self, parent=None):
        super().__init__(parent)
        self.setOpenLinks(False)
        self.anchorClicked.connect(self._open)
        self.texts: dict[str, tuple[str, str]] = {}
        self.follow = True
        self.last_head = None

    def clear_log(self) -> None:
        self.clear()
        self.texts.clear()
        self.last_head = None

    def _open(self, url: QUrl) -> None:
        t = self.texts.get(url.toString())
        if not t:
            return
        d = QDialog(self)
        d.setWindowTitle(t[0])
        d.resize(900, 700)
        lay = QVBoxLayout(d)
        box = QPlainTextEdit(t[1])
        box.setReadOnly(True)
        lay.addWidget(box)
        d.show()

    def _full(self, title: str, text: str) -> str:
        key = f'text:{len(self.texts)}'
        self.texts[key] = (title, text or '')
        preview = esc((text or '').strip().replace('\n', ' ')[:160])
        return f'<a href="{key}" style="color:#6cb8ff">{esc(title)}</a> <span style="color:{MUTED}">{preview}{"…" if len(text or "") > 160 else ""}</span>'

    def _add(self, lane, rnd, body: str, colour: str | None = None) -> None:
        head = f'{lane or ""}|{rnd or 0}'
        if head != self.last_head:
            self.last_head = head
            label = f'{esc(lane) + " · " if lane else ""}{"round " + str(rnd) if rnd else "run"}'
            self.append(f'<div style="margin-top:6px;color:#cfd8e1"><b>{label}</b></div>')
        style = f' style="color:{colour}"' if colour else ''
        self.append(f'<div{style}>&nbsp;&nbsp;{body}</div>')
        if self.follow:
            sb = self.verticalScrollBar()
            sb.setValue(sb.maximum())

    def event_in(self, e: dict) -> None:
        t, L, R = e.get('type'), e.get('lane'), e.get('round')
        if t == 'start':
            self._add(L, 0, f'<b>{esc(e.get("mode"))}</b> with {esc(" vs ".join(e.get("models") or [e.get("model")]))}; role {esc(e.get("role") or "none")}; '
                            f'{esc(e.get("contract"))} replies; mirror {"off" if e.get("mirror") is False else "on"}{"; built in steps" if e.get("build") == "staged" else ""}')
        elif t == 'concept':
            self._add(L, 0, f'<b>concept</b>: {esc(e.get("line"))}', GOOD)
        elif t == 'brief':
            self._add(L, 0, self._full(f'brief ({e.get("legendCodes")} codes, system prompt {e.get("promptChars")} chars)', e.get('text', '')))
        elif t == 'prompt':
            self._add(L, R, (self._full(f'system prompt ({len(e["system"])} chars)', e['system']) + '<br>&nbsp;&nbsp;' if e.get('system') else '') +
                      self._full(f'prompt: {e.get("messages")} messages, {e.get("chars")} chars', e.get('user', '')))
        elif t == 'reply':
            tok = f', {e["outputTokens"]} tokens' if e.get('outputTokens') else ''
            rate = f' at {e["tokensPerSec"]}/s' if e.get('tokensPerSec') else ''
            self._add(L, R, self._full(f'reply in {secs(e.get("ms", 0))}{tok}{rate}', e.get('text', '')))
        elif t == 'grid' and not e.get('partial'):
            errs = e.get('errors') or []
            if not e.get('text'):
                self._add(L, R, 'unreadable: ' + esc('; '.join(x.get('message', '') for x in errs)), BAD)
            else:
                body = f'read {e.get("parts")} parts ({esc(e.get("via"))})'
                if errs:
                    body += '<br>&nbsp;&nbsp;' + '<br>&nbsp;&nbsp;'.join(esc(x.get('message')) for x in errs[:6])
                for w in (e.get('warnings') or [])[:4]:
                    body += f'<br>&nbsp;&nbsp;<span style="color:{MUTED}">{esc(w)}</span>'
                self._add(L, R, body, BAD if errs else None)
        elif t == 'check':
            r = e.get('result') or {}
            p = r.get('power')
            errs = ''.join(f'<br>&nbsp;&nbsp;• {esc(x.get("message"))}' for x in (r.get('errors') or [])[:8])
            pw = (f'power: {p["generation"]} E/s made, {p["storage"]} E stored; cruise {p["thrust"]["cruisePct"]}%, boost {p["thrust"]["boostPct"]}%; '
                  f'{len(p["unpowered"])} unpowered, {len(p["bottlenecks"])} bottlenecks') if p else 'power: not run'
            unmet = (e.get('brief') or {}).get('unmet') or []
            self._add(L, R, f'<b>{"valid" if e.get("valid") else "not valid"}</b>, check {e.get("score")}{errs}'
                            f'<br>&nbsp;&nbsp;<span style="color:{MUTED}">{esc(pw)}{"<br>&nbsp;&nbsp;brief unmet: " + esc("; ".join(unmet)) if unmet else ""}</span>',
                      GOOD if e.get('valid') else BAD)
        elif t == 'feedback':
            self._add(L, R, self._full('feedback to the model', e.get('text', '')))
        elif t == 'render':
            self._add(L, R, f'picture rendered in {e.get("ms")} ms', MUTED)
        elif t == 'score':
            parts = e.get('parts') or {}
            extra = ''.join([f', brief -{parts["briefPenalty"]}' if parts.get('briefPenalty') else '', f', concept -{parts["concept"]}' if parts.get('concept') else ''])
            self._add(L, R, f'score <b>{e.get("score")}</b> <span style="color:{MUTED}">(check {parts.get("check")}{extra})</span>')
        elif t == 'best':
            self._add(L, R, f'best so far: "{esc(e.get("name"))}" {e.get("score")}{" (valid)" if e.get("valid") else ""}', GOOD)
        elif t == 'step':
            st = e.get('status')
            self._add(L, R or 0, f'<b>step {e.get("index")}/{e.get("of")}: {esc(e.get("step"))}</b> {esc(st)}{" (" + esc(e["note"]) + ")" if e.get("note") else ""}',
                      GOOD if st == 'accepted' else BAD if st == 'failed' else None)
        elif t == 'mutation':
            self._add(L, 0, f'gen {e.get("gen")} child {e.get("child")} from {esc(e.get("parent"))}: {esc(e.get("instruction"))}')
        elif t == 'generation':
            pop = ', '.join(f'{esc(p["id"])} {p["score"]}{"" if p["valid"] else " (invalid)"}' for p in e.get('population', []))
            self._add(L, 0, f'generation {e.get("gen")}: {pop}')
        elif t == 'error':
            self._add(L, R, f'{"stopped: " if e.get("fatal") else ""}{esc(e.get("message"))}', BAD)
        elif t == 'batch':
            ph = e.get('phase')
            n = e.get('attempt')
            what = {
                'design': f'ship #{n} ({esc(e.get("role"))}): designing',
                'refine': f'ship #{n}: refining',
                'saved': f'ship #{n}: saved "{esc((e.get("ship") or {}).get("name"))}" score {(e.get("ship") or {}).get("score")} ({e.get("minutes")} min)',
                'rejected': f'ship #{n}: rejected ({esc("; ".join(e.get("why") or []))})',
                'error': f'ship #{n}: error {esc(e.get("message"))}',
                'waiting': f'waiting {e.get("waitS")} s: {esc(e.get("message"))}',
            }.get(ph, f'batch stopped: {esc(e.get("reason"))}')
            self._add(f'#{n}', 0, f'<b>batch</b> {what} <span style="color:{MUTED}">({e.get("saved")} saved of {e.get("attempts")})</span>',
                      GOOD if ph == 'saved' else BAD if ph in ('rejected', 'error') else MUTED)
        elif t == 'done':
            self._add(L, 0, f'done{" (stopped)" if e.get("cancelled") else ""}', GOOD)
