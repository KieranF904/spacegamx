# Models for the silhouette designer: Ollama (/api/tags, /api/chat; its cloud models too, marked), LM Studio
# (/api/v1/models, the OpenAI /v1/chat/completions) and Anthropic (/v1/messages, a fixed list, shown when a key is set;
# paid). Streamed, stdlib only. The LM Studio token (LM_API_TOKEN) and the Anthropic key (ANTHROPIC_API_KEY), from the
# environment or game-v2/.env, only ever go in a request header.
import json
import os
import re
import urllib.error
import urllib.request
from pathlib import Path

OLLAMA = os.environ.get('OLLAMA_URL', 'http://localhost:11434').rstrip('/')
LMSTUDIO = os.environ.get('LMSTUDIO_URL', 'http://localhost:1234').rstrip('/')
ENV_FILE = Path(__file__).resolve().parents[3] / '.env'
ANTHROPIC = 'https://api.anthropic.com'
ANTHROPIC_MODELS = ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5']
# (Ways to keep Anthropic's thinking off, tried in turn when the API refuses one)
THINKING_OFF = [{'thinking': {'type': 'disabled'}}, {'output_config': {'effort': 'low'}}, {}]
_think_variant = [0]


class Stopped(Exception):
    pass


def secret(name: str) -> str | None:
    """A key from the environment, else game-v2/.env"""
    v = os.environ.get(name, '').strip()
    if v:
        return v
    if not ENV_FILE.exists():
        return None
    for line in ENV_FILE.read_text(encoding='utf-8').splitlines():
        m = re.match(rf'^\s*(?:export\s+)?{name}\s*=\s*(.*)$', line)
        if m:
            return re.sub(r'^([\'"])(.*)\1$', r'\2', m.group(1).strip()) or None
    return None


def lm_token() -> str | None:
    return secret('LM_API_TOKEN')


def _get(url: str, headers: dict | None = None, timeout: float = 5) -> dict:
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers or {}), timeout=timeout) as r:
        return json.loads(r.read().decode('utf-8'))


def list_models() -> tuple[list[dict], list[str]]:
    """Every chat model, never loading any: Ollama's (local, then its cloud ones), LM Studio's, then Anthropic's when a key
    is set. [{id, provider, name, label, thinking}], and a note per server that could not be reached"""
    models, notes = [], []
    try:
        cloud = []
        for m in _get(f'{OLLAMA}/api/tags').get('models', []):
            caps = m.get('capabilities') or ['completion']
            if 'completion' not in caps:
                continue
            remote = bool(re.search(r'[:-]cloud$', m['name'], re.I) or m.get('remote_host'))
            size = (m.get('details') or {}).get('parameter_size', '')
            (cloud if remote else models).append({'id': f'ollama/{m["name"]}', 'provider': 'ollama', 'name': m['name'], 'thinking': 'thinking' in caps,
                                                  'label': f'Ollama{" cloud" if remote else ""}  {m["name"]}' + (f'  ({size})' if size and not remote else '')})
        models += cloud
    except Exception as e:
        notes.append(f'Ollama: not reachable ({type(e).__name__})')
    tok = lm_token()
    if not tok:
        notes.append('LM Studio: no LM_API_TOKEN in the environment or game-v2/.env')
    else:
        try:
            for m in _get(f'{LMSTUDIO}/api/v1/models', {'Authorization': f'Bearer {tok}'}).get('models', []):
                if m.get('type') in ('embedding', 'embeddings') or not m.get('key'):
                    continue
                loaded = bool(m.get('loaded_instances'))
                models.append({'id': f'lmstudio/{m["key"]}', 'provider': 'lmstudio', 'name': m['key'],
                               'thinking': bool((m.get('capabilities') or {}).get('reasoning')),
                               'label': f'LM Studio  {m["key"]}' + (f'  ({m["params_string"]})' if m.get('params_string') else '') + ('' if loaded else '  - loads when asked')})
        except Exception as e:
            notes.append(f'LM Studio: not reachable ({type(e).__name__})')
    if secret('ANTHROPIC_API_KEY'):
        models += [{'id': f'anthropic/{m}', 'provider': 'anthropic', 'name': m, 'thinking': False, 'label': f'Anthropic  {m}  - paid'} for m in ANTHROPIC_MODELS]
    else:
        notes.append('Anthropic: no ANTHROPIC_API_KEY in the environment or game-v2/.env')
    return models, notes


def chat(model: dict, messages: list[dict], on_token, stop, temperature: float = 0.3, think: bool = False, num_ctx: int = 8192,
         idle_s: float = 600) -> dict:
    """Streams one reply. on_token(text, kind) with kind 'content' or 'thinking'; stop() true ends it (raises Stopped).
    Returns {text, thinking, prompt_tokens, output_tokens, stop_reason}"""
    out = {'text': '', 'thinking': '', 'prompt_tokens': None, 'output_tokens': None, 'stop_reason': ''}

    def emit(d, kind):
        if d:
            out['text' if kind == 'content' else 'thinking'] += d
            on_token(d, kind)

    if model['provider'] == 'ollama':
        body = {'model': model['name'], 'stream': True, 'messages': messages, 'options': {'temperature': temperature, 'num_ctx': num_ctx}}
        if model.get('thinking'):
            body['think'] = think
        req = urllib.request.Request(f'{OLLAMA}/api/chat', json.dumps(body).encode(), {'Content-Type': 'application/json'})
    elif model['provider'] == 'anthropic':
        return _anthropic(model, messages, emit, stop, out, think, idle_s)
    else:
        tok = lm_token()
        if not tok:
            raise RuntimeError('LM Studio: no LM_API_TOKEN in the environment or game-v2/.env')
        body = {'model': model['name'], 'stream': True, 'messages': messages, 'temperature': temperature, 'stream_options': {'include_usage': True}}
        # (A reasoning model otherwise reasons until the context is full)
        if not think and (model.get('thinking') or re.search('gpt-oss', model['name'], re.I)):
            body['reasoning_effort'] = 'low'
        req = urllib.request.Request(f'{LMSTUDIO}/v1/chat/completions', json.dumps(body).encode(),
                                     {'Content-Type': 'application/json', 'Authorization': f'Bearer {tok}'})
    try:
        r = urllib.request.urlopen(req, timeout=idle_s)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f'{model["id"]}: HTTP {e.code} {e.read().decode("utf-8", "replace")[:300]}') from None
    with r:
        for raw in r:
            if stop():
                raise Stopped()
            line = raw.decode('utf-8', 'replace').strip()
            if not line:
                continue
            if model['provider'] == 'ollama':
                j = json.loads(line)
                if j.get('error'):
                    raise RuntimeError(f'{model["id"]}: {j["error"]}')
                msg = j.get('message') or {}
                emit(msg.get('thinking'), 'thinking')
                emit(msg.get('content'), 'content')
                if j.get('done'):
                    out.update(stop_reason=str(j.get('done_reason', '')), prompt_tokens=j.get('prompt_eval_count'), output_tokens=j.get('eval_count'))
            else:
                m = re.match(r'^data:\s?(.*)$', line)
                if not m or m.group(1).strip() == '[DONE]':
                    continue
                j = json.loads(m.group(1))
                if j.get('error'):
                    raise RuntimeError(f'{model["id"]}: {j["error"].get("message", j["error"]) if isinstance(j["error"], dict) else j["error"]}')
                ch = (j.get('choices') or [{}])[0]
                if ch.get('finish_reason'):
                    out['stop_reason'] = str(ch['finish_reason'])
                d = ch.get('delta') or {}
                emit(d.get('reasoning_content') or d.get('reasoning'), 'thinking')
                emit(d.get('content'), 'content')
                if j.get('usage'):
                    out.update(prompt_tokens=j['usage'].get('prompt_tokens'), output_tokens=j['usage'].get('completion_tokens'))
    return out


def _anthropic(model: dict, messages: list[dict], emit, stop, out: dict, think: bool, idle_s: float) -> dict:
    """Anthropic's streamed /v1/messages. No temperature (the current models refuse it). Thinking is off unless asked
    for, or it eats the reply; a way of turning it off that the API refuses is dropped for the next, and remembered"""
    key = secret('ANTHROPIC_API_KEY')
    if not key:
        raise RuntimeError('Anthropic: no ANTHROPIC_API_KEY in the environment or game-v2/.env')
    system = '\n\n'.join(m['content'] for m in messages if m['role'] == 'system')
    while True:
        body = {'model': model['name'], 'stream': True, 'max_tokens': 16384, 'messages': [m for m in messages if m['role'] != 'system'],
                **({'system': system} if system else {}), **({} if think else THINKING_OFF[_think_variant[0]])}
        req = urllib.request.Request(f'{ANTHROPIC}/v1/messages', json.dumps(body).encode(),
                                     {'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01'})
        try:
            r = urllib.request.urlopen(req, timeout=idle_s)
            break
        except urllib.error.HTTPError as e:
            why = e.read().decode('utf-8', 'replace')
            if e.code == 400 and not think and _think_variant[0] < len(THINKING_OFF) - 1 and re.search('thinking|effort|output_config', why, re.I):
                _think_variant[0] += 1
                continue
            raise RuntimeError(f'{model["id"]}: HTTP {e.code} {why[:300]}') from None
    with r:
        for raw in r:
            if stop():
                raise Stopped()
            m = re.match(r'^data:\s?(.*)$', raw.decode('utf-8', 'replace').strip())
            if not m:
                continue
            j = json.loads(m.group(1))
            t = j.get('type')
            if t == 'error':
                raise RuntimeError(f'{model["id"]}: {(j.get("error") or {}).get("message", "error")}')
            if t == 'message_start':
                out['prompt_tokens'] = ((j.get('message') or {}).get('usage') or {}).get('input_tokens')
            elif t == 'content_block_delta':
                d = j.get('delta') or {}
                emit(d.get('thinking'), 'thinking')
                emit(d.get('text'), 'content')
            elif t == 'message_delta':
                if (j.get('usage') or {}).get('output_tokens') is not None:
                    out['output_tokens'] = j['usage']['output_tokens']
                if (j.get('delta') or {}).get('stop_reason'):
                    out['stop_reason'] = str(j['delta']['stop_reason'])
    return out
