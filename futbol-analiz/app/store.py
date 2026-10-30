import json
import sqlite3
import threading
import time


class Store:
    """SQLite: ham API önbelleği, maç paketleri ve olay (bildirim) kaydı."""

    def __init__(self, path):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(str(path), check_same_thread=False)
        self.lock = threading.Lock()
        with self.lock:
            self.conn.executescript(
                """
                PRAGMA journal_mode=WAL;
                CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, ts REAL, body TEXT);
                CREATE TABLE IF NOT EXISTS bundles (
                    match_id INTEGER PRIMARY KEY, day TEXT, ts REAL, sig TEXT, body TEXT);
                CREATE TABLE IF NOT EXISTS events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, ts REAL, match_id INTEGER,
                    kind TEXT, text TEXT);
                CREATE TABLE IF NOT EXISTS predictions (match_id INTEGER PRIMARY KEY, ts REAL, body TEXT);
                CREATE TABLE IF NOT EXISTS coupons (day TEXT PRIMARY KEY, ts REAL, body TEXT);
                CREATE TABLE IF NOT EXISTS katlama (day TEXT PRIMARY KEY, ts REAL, body TEXT);
                CREATE TABLE IF NOT EXISTS basket (kind TEXT, key TEXT, ts REAL, body TEXT, PRIMARY KEY (kind, key));
                """
            )

    # --- ham önbellek ---
    def cache_get(self, key):
        with self.lock:
            row = self.conn.execute("SELECT ts, body FROM cache WHERE key=?", (key,)).fetchone()
        if not row:
            return None
        return row[0], json.loads(row[1])

    def cache_put(self, key, obj):
        body = json.dumps(obj, ensure_ascii=False)
        with self.lock:
            self.conn.execute(
                "INSERT OR REPLACE INTO cache(key, ts, body) VALUES (?,?,?)", (key, time.time(), body)
            )
            self.conn.commit()

    # --- maç paketleri ---
    def bundle_get(self, match_id):
        with self.lock:
            row = self.conn.execute(
                "SELECT ts, sig, body FROM bundles WHERE match_id=?", (match_id,)
            ).fetchone()
        if not row:
            return None
        return {"ts": row[0], "sig": row[1], "body": json.loads(row[2])}

    def bundle_put(self, match_id, day, sig, obj):
        body = json.dumps(obj, ensure_ascii=False)
        with self.lock:
            self.conn.execute(
                "INSERT OR REPLACE INTO bundles(match_id, day, ts, sig, body) VALUES (?,?,?,?,?)",
                (match_id, day, time.time(), sig, body),
            )
            self.conn.commit()

    def prune(self, cache_days=40, bundle_days=14, event_days=14):
        """Eski kayıtları siler; gerekirse kaynaktan yeniden çekilir."""
        now = time.time()
        with self.lock:
            self.conn.execute("DELETE FROM cache WHERE ts < ?", (now - cache_days * 86400,))
            self.conn.execute("DELETE FROM bundles WHERE ts < ?", (now - bundle_days * 86400,))
            self.conn.execute("DELETE FROM events WHERE ts < ?", (now - event_days * 86400,))
            self.conn.commit()
            self.conn.execute("VACUUM")

    # --- olaylar ---
    def add_event(self, match_id, kind, text):
        with self.lock:
            cur = self.conn.execute(
                "INSERT INTO events(ts, match_id, kind, text) VALUES (?,?,?,?)",
                (time.time(), match_id, kind, text),
            )
            self.conn.commit()
            return cur.lastrowid

    # --- model karnesi (tahmin geçmişi; temizlikte silinmez) ---
    def pred_get(self, match_id):
        with self.lock:
            row = self.conn.execute("SELECT body FROM predictions WHERE match_id=?", (match_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def pred_put(self, match_id, obj):
        with self.lock:
            self.conn.execute("INSERT OR REPLACE INTO predictions(match_id, ts, body) VALUES (?,?,?)",
                              (match_id, time.time(), json.dumps(obj, ensure_ascii=False)))
            self.conn.commit()

    def pred_all(self):
        with self.lock:
            rows = self.conn.execute("SELECT body FROM predictions").fetchall()
        return [json.loads(r[0]) for r in rows]

    # --- günün kombineleri (temizlikte silinmez) ---
    def coupon_get(self, day):
        with self.lock:
            row = self.conn.execute("SELECT body FROM coupons WHERE day=?", (day,)).fetchone()
        return json.loads(row[0]) if row else None

    def coupon_put(self, day, obj):
        with self.lock:
            self.conn.execute("INSERT OR REPLACE INTO coupons(day, ts, body) VALUES (?,?,?)",
                              (day, time.time(), json.dumps(obj, ensure_ascii=False)))
            self.conn.commit()

    def coupon_all(self):
        with self.lock:
            rows = self.conn.execute("SELECT body FROM coupons ORDER BY day").fetchall()
        return [json.loads(r[0]) for r in rows]

    # --- basketbol tercih ve kupon kayıtları (temizlikte silinmez)
    def bk_get(self, kind, key):
        with self.lock:
            row = self.conn.execute("SELECT body FROM basket WHERE kind=? AND key=?", (kind, key)).fetchone()
        return json.loads(row[0]) if row else None

    def bk_put(self, kind, key, obj):
        with self.lock:
            self.conn.execute("INSERT OR REPLACE INTO basket(kind, key, ts, body) VALUES (?,?,?,?)",
                              (kind, key, time.time(), json.dumps(obj, ensure_ascii=False)))
            self.conn.commit()

    def bk_all(self, kind):
        with self.lock:
            rows = self.conn.execute("SELECT body FROM basket WHERE kind=?", (kind,)).fetchall()
        return [json.loads(r[0]) for r in rows]

    # --- katlama serisi: günde tek kupon (karneden ve diğer kuponlardan bağımsız, temizlikte silinmez) ---
    def kat_get(self, day):
        with self.lock:
            row = self.conn.execute("SELECT body FROM katlama WHERE day=?", (day,)).fetchone()
        return json.loads(row[0]) if row else None

    def kat_put(self, day, obj):
        with self.lock:
            self.conn.execute("INSERT OR REPLACE INTO katlama(day, ts, body) VALUES (?,?,?)",
                              (day, time.time(), json.dumps(obj, ensure_ascii=False)))
            self.conn.commit()

    def kat_all(self):
        with self.lock:
            rows = self.conn.execute("SELECT body FROM katlama ORDER BY day").fetchall()
        return [json.loads(r[0]) for r in rows]

    def recent_events(self, limit=50, since_id=0):
        with self.lock:
            rows = self.conn.execute(
                "SELECT id, ts, match_id, kind, text FROM events WHERE id>? ORDER BY id DESC LIMIT ?",
                (since_id, limit),
            ).fetchall()
        return [dict(id=r[0], ts=r[1], match_id=r[2], kind=r[3], text=r[4]) for r in rows]
