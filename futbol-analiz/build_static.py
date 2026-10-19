"""Tek seferlik güncelleme + şifreli statik site üretimi (GitHub Actions bunu 15 dakikada bir çalıştırır).

Kullanım: SITE_PASSWORD=... python build_static.py <çıktı-klasörü>
Önbellek ve önceki analizler DATA_DIR'deki SQLite dosyasında tutulur; Actions bunu cache ile saklar.
"""
import asyncio
import json
import logging
import os
import shutil
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

from app.config import DB_PATH, LEAGUES, STATIC_DIR, TR_TZ
from app.crypto_box import derive_key, seal
from app.sources import Sources
from app.store import Store
from app.updater import Updater, day_key, enrich_day

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(name)s %(levelname)s %(message)s")
log = logging.getLogger("build")


async def main(out):
    password = (os.environ.get("SITE_PASSWORD") or "").strip()
    if not password:
        sys.exit("SITE_PASSWORD ortam değişkeni gerekli")
    key = derive_key(password)
    t0 = time.time()

    store = Store(DB_PATH)
    src = Sources(store)
    up = Updater(store, src)
    await up.cycle()
    store.prune()

    data = out / "data"
    if out.exists():
        shutil.rmtree(out)
    data.mkdir(parents=True)

    def write(name, obj):
        (data / name).write_text(json.dumps(seal(key, obj)), encoding="utf-8")

    now = datetime.now(TR_TZ)
    days, n_match = [], 0
    for d in (now - timedelta(days=1), now, now + timedelta(days=1)):
        try:
            matches = enrich_day(store, await up.day(d))
        except Exception as e:  # noqa: BLE001
            log.warning("gün listesi alınamadı %s: %s", day_key(d), e)
            continue
        write(f"day-{day_key(d)}.json", {"date": day_key(d), "matches": matches})
        days.append(day_key(d))
        for m in matches:
            b = store.bundle_get(m["id"])
            if b:
                write(f"match-{m['id']}.json", b["body"])
                n_match += 1
    write("events.json", store.recent_events(60))
    write("meta.json", {
        "updated": time.time(),
        "days": days,
        "leagues": [{"id": k, "name": v} for k, v in LEAGUES.items()],
        "matches": n_match,
        "took": round(time.time() - t0, 1),
    })

    # arayüz: göreli yollar + statik mod işareti
    for f in ("app.js", "style.css"):
        shutil.copy(STATIC_DIR / f, out / f)
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    html = html.replace('href="/static/', 'href="').replace('src="/static/', 'src="')
    html = html.replace("<script src=", "<script>window.STATIC_SITE = true;</script>\n<script src=", 1)
    (out / "index.html").write_text(html, encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")
    await src.close()
    log.info("bitti: %s maç, %s gün, %.1f sn", n_match, len(days), time.time() - t0)


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1] if len(sys.argv) > 1 else "out").resolve()))
