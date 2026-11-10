"""
Local development server for Nova Tools.

This file is intentionally different from wsgi.py (PythonAnywhere):
  - Serves locally at http://localhost:8080
  - Provides /api/update-data: spawns update_data.py and streams output
  - Provides /api/check-updates: compares the gameVersion + buildVersion
    inside data/Live.zip + PTU.zip against what's recorded in versions.json
  - Does NOT expose `application` variable (not a WSGI app)

wsgi.py is the production entry point (PythonAnywhere). It omits
/api/update-data (data is updated offline and uploaded manually) and
always reports no updates to avoid outbound calls on the free tier.
"""
import json
import os
import subprocess
import sys
import zipfile
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

from shared_db import save_shared_build, get_shared_build

DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data')
VERSIONS_FILE = os.path.join(DATA_DIR, 'versions.json')
ZIP_FILES = ['Live.zip', 'PTU.zip']


def load_versions():
    try:
        with open(VERSIONS_FILE) as f:
            return json.load(f)
    except Exception:
        return {}


def zip_versions(path):
    """Return (gameVersion, buildVersion) from the zip's metadata.json, or ('','')."""
    try:
        with zipfile.ZipFile(path) as zf:
            meta = json.loads(zf.read('metadata.json').decode('utf-8'))
        return meta.get('gameVersion', '') or '', meta.get('buildVersion', '') or ''
    except Exception:
        return '', ''


class AppHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        # Mirror wsgi.py's CSP so policy violations surface in dev, not prod.
        self.send_header('Content-Security-Policy',
                         "default-src 'self'; script-src 'self'; "
                         "style-src 'self' 'unsafe-inline'; worker-src 'self' blob:; "
                         "object-src 'none'; base-uri 'self'; frame-ancestors 'self'")
        self.send_header('X-Content-Type-Options', 'nosniff')
        super().end_headers()

    def do_POST(self):
        if self.path == '/api/share':
            self._handle_share_create()
        else:
            self.send_error(404)

    def do_GET(self):
        if self.path == '/api/check-updates':
            self._handle_check_updates()
        elif self.path == '/api/update-data':
            self._handle_update_data()
        elif self.path.startswith('/api/shared/'):
            self._handle_share_get()
        elif self.path.startswith('/s/'):
            self._serve_index()
        else:
            # Same policy as wsgi.py: never serve the SQLite DB, source
            # files or dotfiles over HTTP.
            path = self.path.split('?', 1)[0]
            if path.endswith(('.db', '.py')) or '/.' in path:
                self.send_error(404)
            else:
                super().do_GET()

    def _handle_check_updates(self):
        """Surface a banner only when there's a genuinely new SC build to
        deploy - i.e. the gameVersion or buildVersion inside the ZIP differs
        from what versions.json recorded.

        Earlier iterations compared filesystem mtime (false-positive on every
        re-copy) and SHA-256 (false-positive on every Extractor re-run, since
        the bundled metadata.json's extractionTimestamp changes). gameVersion
        + buildVersion is the user-visible identity: matching them means
        deploying brings nothing new to end users.
        """
        versions = load_versions()
        updates = {}
        for name in ZIP_FILES:
            zip_path = os.path.join(DATA_DIR, name)
            if not os.path.exists(zip_path):
                continue
            zip_game, zip_build = zip_versions(zip_path)
            if not zip_game:
                continue
            entry = versions.get(name, {})
            recorded_game = entry.get('gameVersion', '') if isinstance(entry, dict) else ''
            recorded_build = entry.get('buildVersion', '') if isinstance(entry, dict) else ''
            if (zip_game, zip_build) != (recorded_game, recorded_build):
                fmt = lambda g, b: f'{g} ({b})' if b else g
                updates[name] = {
                    'remote': fmt(zip_game, zip_build),
                    'local': fmt(recorded_game, recorded_build) or 'never',
                }
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({
            'hasUpdates': len(updates) > 0,
            'updates': updates
        }).encode())

    def _handle_update_data(self):
        """Run update_data.py and stream output."""
        self.send_response(200)
        self.send_header('Content-Type', 'text/plain; charset=utf-8')
        self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()

        script = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'update_data.py')
        try:
            proc = subprocess.Popen(
                [sys.executable, script],
                stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                cwd=os.path.dirname(script),
                bufsize=1, universal_newlines=True
            )
            for line in proc.stdout:
                chunk = line.encode('utf-8')
                self.wfile.write(f'{len(chunk):x}\r\n'.encode())
                self.wfile.write(chunk)
                self.wfile.write(b'\r\n')
                self.wfile.flush()
            proc.wait()

            if proc.returncode == 0:
                msg = b'\nUpdate complete! Refresh the page to load new data.\n'
            else:
                msg = f'\nUpdate failed (exit code {proc.returncode})\n'.encode()
            self.wfile.write(f'{len(msg):x}\r\n'.encode())
            self.wfile.write(msg)
            self.wfile.write(b'\r\n')
        except Exception as e:
            msg = f'Error: {e}\n'.encode()
            self.wfile.write(f'{len(msg):x}\r\n'.encode())
            self.wfile.write(msg)
            self.wfile.write(b'\r\n')
        finally:
            self.wfile.write(b'0\r\n\r\n')
            self.wfile.flush()

    def _handle_share_create(self):
        length = int(self.headers.get('Content-Length', 0))
        body = json.loads(self.rfile.read(length)) if length else {}
        ship = body.get('ship')
        build = body.get('build')
        if not ship or not build:
            self.send_response(400)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'Missing ship or build'}).encode())
            return
        bid = save_shared_build(ship, build)
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps({'id': bid}).encode())

    def _handle_share_get(self):
        bid = self.path.split('/api/shared/')[-1]
        result = get_shared_build(bid)
        if not result:
            self.send_response(404)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(json.dumps({'error': 'Not found'}).encode())
            return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(json.dumps(result).encode())

    def _serve_index(self):
        index = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'index.html')
        self.send_response(200)
        self.send_header('Content-Type', 'text/html')
        self.end_headers()
        with open(index, 'rb') as f:
            self.wfile.write(f.read())


ThreadingHTTPServer(('', 8080), AppHandler).serve_forever()
