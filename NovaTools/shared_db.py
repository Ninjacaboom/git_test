"""SQLite storage for shared builds."""

import json
import os
import secrets
import sqlite3
import string

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'data', 'shared_builds.db')
_CHARS = string.ascii_letters + string.digits


def _connect():
    os.makedirs(os.path.dirname(DB_PATH), exist_ok=True)
    return sqlite3.connect(DB_PATH)


def init_db():
    with _connect() as conn:
        conn.execute('''
            CREATE TABLE IF NOT EXISTS shared_builds (
                id TEXT PRIMARY KEY,
                ship_name TEXT NOT NULL,
                build_data TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        ''')


def _gen_id(length=8):
    # secrets, not random: share IDs are unguessable capability tokens.
    return ''.join(secrets.choice(_CHARS) for _ in range(length))


def save_shared_build(ship_name, build):
    data = json.dumps(build, separators=(',', ':'))
    with _connect() as conn:
        for _ in range(10):
            bid = _gen_id()
            try:
                conn.execute(
                    'INSERT INTO shared_builds (id, ship_name, build_data) VALUES (?, ?, ?)',
                    (bid, ship_name, data),
                )
                return bid
            except sqlite3.IntegrityError:
                continue
    raise RuntimeError('Failed to generate unique share ID')


def get_shared_build(bid):
    with _connect() as conn:
        row = conn.execute(
            'SELECT ship_name, build_data FROM shared_builds WHERE id = ?', (bid,)
        ).fetchone()
    if not row:
        return None
    return {'ship': row[0], 'build': json.loads(row[1])}


init_db()
