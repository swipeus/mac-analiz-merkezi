"""Tek seferlik güncelleme + şifreli statik site üretimi (GitHub Actions bunu 15 dakikada bir çalıştırır).

Kullanım: SITE_PASSWORD=... python build_static.py <çıktı-klasörü>
Önbellek ve önceki analizler DATA_DIR'deki SQLite dosyasında tutulur; Actions bunu cache ile saklar.
"""
import asyncio
import hashlib
import json
import logging
import os
import shutil
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

from app import analysis, karne, kupon, leagues, players
from app.config import DB_PATH, LEAGUES, STATIC_DIR, TR_TZ
from app.crypto_box import derive_key, seal, unseal
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
    # önbellek kaybolduysa model karnesi geçmişini yayındaki siteden geri yükle
    pages = os.environ.get("PAGES_URL")
    if not pages and "/" in os.environ.get("GITHUB_REPOSITORY", ""):
        owner, repo = os.environ["GITHUB_REPOSITORY"].split("/", 1)
        pages = f"https://{owner.lower()}.github.io/{repo}/"
    last = store.cache_get("karne:synced")
    if pages and (not last or time.time() - last[0] > 5 * 3600):  # her yeni işin başında (≈5.5 saatte bir)
        try:
            r = await src.client.get(pages.rstrip("/") + f"/data/karne.json?t={int(time.time())}")
            if r.status_code == 200:
                log.info("karne yayındakiyle birleştirildi: %s kayıt", karne.seed(store, unseal(key, r.json())))
                store.cache_put("karne:synced", True)
        except Exception as e:  # noqa: BLE001
            log.warning("karne geri yüklenemedi: %s", e)
    # karneden tür bazında kalibrasyon (yeterli veri ve belirgin sapma varsa olasılıklar düzeltilir)
    analysis.CALIB, calib_report = karne.calib_table(store)
    log.info("kalibrasyon: %s", analysis.CALIB or "gerek yok")
    await up.cycle()
    store.prune()

    data = out / "data"
    if out.exists():
        shutil.rmtree(out)
    data.mkdir(parents=True)

    def write(name, obj):
        (data / name).write_text(json.dumps(seal(key, obj)), encoding="utf-8")

    now = datetime.now(TR_TZ)
    days, n_match, player_ids = [], 0, []
    move_bodies = []  # oran hareketleri için bugün ve yarının maçları
    kupon.settle(store)
    # bugün önce: oyuncu yenileme bütçesi önce bugünün maçlarına harcansın
    for d in (now, now + timedelta(days=1), now - timedelta(days=1)):
        try:
            matches = enrich_day(store, await up.day(d))
        except Exception as e:  # noqa: BLE001
            log.warning("gün listesi alınamadı %s: %s", day_key(d), e)
            continue
        bodies = [b["body"] for b in (store.bundle_get(m["id"]) for m in matches) if b]
        if d >= now - timedelta(hours=1):
            move_bodies += bodies
        # günün kombineleri: bugün ve yarın için (dünün kuponları kilitli, sadece gösterilir)
        doc = kupon.update_day(store, day_key(d), bodies) if d >= now - timedelta(hours=1) else store.coupon_get(day_key(d))
        write(f"day-{day_key(d)}.json", {"date": day_key(d), "matches": matches,
                                         "coupons": (doc or {}).get("coupons") or [], "coupons_locked": bool((doc or {}).get("locked"))})
        days.append(day_key(d))
        for m in matches:
            b = store.bundle_get(m["id"])
            if b:
                # başlamış maçlarda sayfadaki tahmin karnedeki (maç öncesi) kayıtla aynı olsun
                write(f"match-{m['id']}.json", karne.freeze(store, b["body"], b["body"]))
                n_match += 1
                player_ids += players.lineup_player_ids(b["body"])
    days.sort()

    # oyuncu sayfaları: bayat olanları sınırlı sayıda yenile, önbellekte olanların hepsini yaz
    budget = int(os.environ.get("PLAYER_BUDGET", "400"))
    n_fetched = await players.refresh_players(src, store, player_ids, budget)
    n_players = 0
    for pid in dict.fromkeys(player_ids):
        p = players.cached_player(store, pid)
        if p:
            write(f"player-{pid}.json", p)
            n_players += 1
    log.info("oyuncular: %s yenilendi, %s yayınlandı (%s kadroda)", n_fetched, n_players, len(set(player_ids)))
    write("events.json", store.recent_events(60))
    write("odds-moves.json", {"updated": time.time(), "moves": leagues.odds_moves(move_bodies)})
    # lig sayfaları: puan durumu, gol ve asist krallığı
    for lp in await leagues.all_pages(src):
        write(f"league-{lp['id']}.json", lp)
    kupon.settle(store)
    write("karne.json", karne.export(store))
    write("meta.json", {
        "updated": time.time(),
        "days": days,
        "leagues": [{"id": k, "name": v} for k, v in LEAGUES.items()],
        "matches": n_match,
        "took": round(time.time() - t0, 1),
        # canlı veri köprüsü (Cloudflare Worker) adresi; anahtar tarayıcıda şifreden türetilir
        "live": {"url": os.environ.get("LIVE_URL") or None},
    })

    # arayüz: göreli yollar + statik mod işareti. Dosyalara içerik özetiyle sürüm eklenir ki
    # tarayıcı önbelleği eski sayfayla yeni kodu (ya da tersini) karıştırmasın.
    html = (STATIC_DIR / "index.html").read_text(encoding="utf-8")
    for f in ("app.js", "asistan.js", "canli.js", "style.css"):
        shutil.copy(STATIC_DIR / f, out / f)
        ver = hashlib.sha1((STATIC_DIR / f).read_bytes()).hexdigest()[:10]
        html = html.replace(f'"/static/{f}"', f'"{f}?v={ver}"')
    html = html.replace("<script src=", "<script>window.STATIC_SITE = true;</script>\n<script src=", 1)
    (out / "index.html").write_text(html, encoding="utf-8")
    (out / ".nojekyll").write_text("", encoding="utf-8")
    await src.close()
    log.info("bitti: %s maç, %s gün, %.1f sn", n_match, len(days), time.time() - t0)


if __name__ == "__main__":
    asyncio.run(main(Path(sys.argv[1] if len(sys.argv) > 1 else "out").resolve()))
