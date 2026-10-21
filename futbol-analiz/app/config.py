import os
from datetime import timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# Sunucuda kalıcı disk DATA_DIR ile verilir (ör. /data)
DB_PATH = Path(os.environ.get("DATA_DIR") or ROOT / "data") / "futbol.db"
STATIC_DIR = ROOT / "static"

# Boşsa site şifresiz açılır (yerel kullanım). Sunucuda mutlaka ayarlanmalı.
SITE_PASSWORD = os.environ.get("SITE_PASSWORD", "")

# Türkiye 2016'dan beri sabit UTC+3
TR_TZ = timezone(timedelta(hours=3))

# FotMob lig ID'leri -> görünen ad (sıra = sitedeki sıra)
LEAGUES = {
    71: "Süper Lig",
    47: "Premier League",
    87: "LaLiga",
    55: "Serie A",
    54: "Bundesliga",
    53: "Ligue 1",
    57: "Eredivisie",
    61: "Liga Portugal",
    40: "Belçika Pro Lig",
    48: "Championship",
    64: "İskoçya Premiership",
    42: "Şampiyonlar Ligi",
    73: "Avrupa Ligi",
    10216: "Konferans Ligi",
}

# Güncelleme aralıkları (saniye)
CYCLE_SECONDS = 120          # ana döngü
DAY_LIST_TTL = 180           # günün maç listesi
LIVE_INTERVAL = 120          # canlı maç
NEAR_INTERVAL = 300          # başlamaya 3 saatten az kalan maç
TODAY_INTERVAL = 300         # aynı gün içindeki diğer maçlar (her 6 dakikalık turda yenilenir)
FAR_INTERVAL = 30 * 60       # yarının maçları
SEASON_TTL = 6 * 3600        # sezon istatistikleri
NEWS_TTL = 10 * 60           # haberler
