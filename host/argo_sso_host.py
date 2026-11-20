#!/usr/bin/python3
"""Native messaging host for the Argo Submit extension (com.jprats.argo_submit).

Chrome starts this script and sends it one message per token change:
    {"host": "argo.example.com", "token": "Bearer v2:...", "expires": 1760000000000, "env": true}

For every message it writes ~/.cache/argo-sso/tokens/<host>.json, for terminal tools that call the Argo API.
When "env" is true it also writes ~/.cache/argo-sso/env for the argo CLI, as before.
A message with "token": null removes that host's token file.
Everything is written 0600 inside 0700 directories. Stdlib only: Chrome runs this with a minimal environment.
"""
import json
import os
import re
import struct
import sys
import time

CACHE = os.path.expanduser('~/.cache/argo-sso')
TOKENS = os.path.join(CACHE, 'tokens')
HOST_RE = re.compile(r'^[A-Za-z0-9.-]+$')


def read_message():
    raw = sys.stdin.buffer.read(4)
    if len(raw) < 4:
        return None
    (length,) = struct.unpack('<I', raw)
    return json.loads(sys.stdin.buffer.read(length).decode('utf-8'))


def send_message(obj):
    data = json.dumps(obj).encode('utf-8')
    sys.stdout.buffer.write(struct.pack('<I', len(data)))
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()


def write_private(path, text):
    for d in (CACHE, os.path.dirname(path)):
        os.makedirs(d, mode=0o700, exist_ok=True)
        os.chmod(d, 0o700)
    tmp = f'{path}.tmp'
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, 'w') as f:
        f.write(text)
    os.replace(tmp, path)


def quote(s):
    return "'" + s.replace("'", "'\\''") + "'"


def handle(msg):
    host = (msg or {}).get('host') or ''
    if not HOST_RE.match(host):
        return {'ok': False, 'error': f'invalid host {host!r}'}
    token = msg.get('token')
    path = os.path.join(TOKENS, f'{host}.json')
    if not token:
        if os.path.exists(path):
            os.remove(path)
        return {'ok': True, 'path': path, 'removed': True}
    if not token.lower().startswith('bearer '):
        token = f'Bearer {token}'
    write_private(path, json.dumps({
        'host': host, 'token': token, 'expires': msg.get('expires'), 'updated': int(time.time() * 1000),
    }))
    if msg.get('env'):
        env_path = os.path.join(CACHE, 'env')
        write_private(env_path, '\n'.join([
            f'export ARGO_SERVER={quote(host + ":443")}',
            'export ARGO_SECURE=true',
            'export ARGO_HTTP1=true',
            f'export ARGO_TOKEN={quote(token)}',
            '',
        ]))
        return {'ok': True, 'path': env_path, 'tokenPath': path}
    return {'ok': True, 'path': path}


def main():
    try:
        msg = read_message()
        send_message(handle(msg))
    except Exception as e:  # report to the extension instead of dying silently
        send_message({'ok': False, 'error': str(e)})


if __name__ == '__main__':
    main()
