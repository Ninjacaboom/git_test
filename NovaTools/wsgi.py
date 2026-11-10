"""
PythonAnywhere WSGI entry point for Nova Tools.

This file is intentionally different from server.py (local dev):
  - Exposes `application` variable for WSGI (PythonAnywhere requirement)
  - Omits /api/update-data - data is updated offline via update_data.py
    and re-uploaded manually via the Files tab or SFTP
  - /api/check-updates always returns hasUpdates=false to avoid outbound
    calls on the free tier (which may block external connections)
  - /deploy handles automated GitHub Actions deploys: git pull + reload

On PythonAnywhere:
  - Point the WSGI file to this file in the Web dashboard
  - Set the working directory to the project root
  - Upload the contents of data/ manually after running update_data.py locally
  - Set DEPLOY_SECRET env var in the Web tab → Environment variables panel
"""

import hmac
import json
import os
import subprocess

from flask import Flask, abort, jsonify, request, send_from_directory
from shared_db import save_shared_build, get_shared_build

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, 'data')
VERSIONS_FILE = os.path.join(DATA_DIR, 'versions.json')

# Only these directories are reachable through the static catch-all. The repo
# root also holds source (.py), the shared-builds SQLite DB and docs - none of
# which may be served over HTTP.
STATIC_DIRS = ('js/', 'css/', 'fonts/', 'img/', 'lib/', 'data/', 'admin/')
BLOCKED_SUFFIXES = ('.db', '.py')

app = Flask(__name__)


@app.after_request
def set_cache_headers(response):
    """Cache policy that's fast but never serves stale code.

    - Dynamic JSON (the /api routes) is never cached - it can change per request.
    - Everything else (index.html, JS, CSS, fonts) is cacheable but MUST be
      revalidated on every use. Flask's send_file already attaches ETag +
      Last-Modified and answers conditional GETs, so an unchanged asset returns
      a tiny 304 (fast) while a deployed change returns fresh bytes immediately.
      This keeps loads quick yet guarantees browsers can never run a stale
      ES-module graph - the import mismatch (a cached old sustained.js vs a new
      ttkCalc.js) that left the app stuck on "Loading data...".

    NOTE: this only governs files served BY FLASK. If PythonAnywhere has a
    static-file mapping for /js, /css or /fonts (Web tab), those are served by
    nginx and bypass this entirely - remove those mappings so the assets route
    through Flask's catch-all and pick up these headers.
    """
    if response.mimetype == 'application/json':
        response.headers['Cache-Control'] = 'no-store'
    else:
        response.headers['Cache-Control'] = 'no-cache'
    response.headers.pop('Pragma', None)
    response.headers.pop('Expires', None)
    response.headers['X-Content-Type-Options'] = 'nosniff'
    response.headers['X-Frame-Options'] = 'SAMEORIGIN'
    response.headers['Referrer-Policy'] = 'strict-origin-when-cross-origin'
    # worker-src blob: is required by zip.js (inflates the data ZIPs in a
    # Web Worker booted from a Blob URL). style 'unsafe-inline' covers the
    # style="" attributes in JS-built markup.
    response.headers['Content-Security-Policy'] = (
        "default-src 'self'; script-src 'self'; "
        "style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; "
        "object-src 'none'; base-uri 'self'; frame-ancestors 'self'"
    )
    return response


@app.route('/deploy', methods=['POST'])
def deploy():
    """
    Webhook for automated GitHub Actions deploys.

    Expects:  Authorization: Bearer <token>
    Token must match the DEPLOY_SECRET environment variable set in the
    PythonAnywhere Web tab → Environment variables panel.

    Steps:
      1. Verify token
      2. git pull origin master
      3. Touch the PA WSGI reload trigger so the worker picks up new code
    """
    # Read secret from ~/.deploy_secret (a plain-text file outside the repo,
    # never committed). Create it on PythonAnywhere with:
    #   echo "your-secret-here" > /home/novatools/.deploy_secret
    secret_file = os.path.expanduser('~/.deploy_secret')
    try:
        with open(secret_file) as f:
            secret = f.read().strip()
    except OSError:
        secret = ''
    if not secret:
        # Details (missing vs empty file) stay server-side; unauthenticated
        # callers get nothing to map the filesystem with.
        app.logger.error('deploy: ~/.deploy_secret missing or empty')
        return jsonify({'error': 'Deploy not configured'}), 500

    auth = request.headers.get('Authorization', '')
    if not hmac.compare_digest(auth, f'Bearer {secret}'):
        return jsonify({'error': 'Unauthorized'}), 401

    try:
        result = subprocess.run(
            ['git', 'pull', 'origin', 'master'],
            cwd=BASE_DIR,
            capture_output=True,
            text=True,
            timeout=60,
        )
    except subprocess.TimeoutExpired:
        return jsonify({'error': 'git pull timed out'}), 500

    # Touch the PA WSGI trigger file to reload the worker with the new code.
    # PA's wrapper lives at /var/www/<username>_pythonanywhere_com_wsgi.py.
    pa_wsgi = '/var/www/novatools_pythonanywhere_com_wsgi.py'
    try:
        os.utime(pa_wsgi, None)
    except OSError:
        pass  # file may not exist in dev/test environments

    output = (result.stdout + result.stderr).strip()
    if result.returncode != 0:
        return jsonify({'error': 'git pull failed', 'output': output}), 500

    return jsonify({'ok': True, 'output': output})


@app.route('/api/check-updates')
def check_updates():
    """
    Data is updated offline (NovaSCDataExtractor → Live.zip / PTU.zip)
    and uploaded to PythonAnywhere manually, so we always report no
    updates. The versions endpoint still returns current version info
    for display.
    """
    try:
        with open(VERSIONS_FILE) as f:
            versions = json.load(f)
    except Exception:
        versions = {}
    return jsonify({'hasUpdates': False, 'updates': {}, 'versions': versions})


@app.route('/api/share', methods=['POST'])
def share_create():
    body = request.get_json(force=True, silent=True) or {}
    ship = body.get('ship')
    build = body.get('build')
    if not ship or not build:
        return jsonify({'error': 'Missing ship or build'}), 400
    bid = save_shared_build(ship, build)
    return jsonify({'id': bid})


@app.route('/api/shared/<bid>')
def share_get(bid):
    result = get_shared_build(bid)
    if not result:
        return jsonify({'error': 'Not found'}), 404
    return jsonify(result)


@app.route('/s/<bid>')
def share_page(bid):
    return send_from_directory(BASE_DIR, 'index.html')


@app.route('/')
def index():
    return send_from_directory(BASE_DIR, 'index.html')


@app.route('/<path:path>')
def static_files(path):
    if (not path.startswith(STATIC_DIRS)
            or path.endswith(BLOCKED_SUFFIXES)
            or '/.' in f'/{path}'):
        abort(404)
    return send_from_directory(BASE_DIR, path)


# PythonAnywhere looks for a variable named `application`
application = app
