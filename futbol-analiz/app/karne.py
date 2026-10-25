"""Model karnesi: her maç için başlamadan önceki son tahmin saklanır, maç bitince sonuçla karşılaştırılır.

Karne üç başlıkta tutulur: tek tercihler (her birine 100 ₺), günün kombineleri (kupon başına 250 ₺) ve
skor tahminleri (her birine 10 ₺, skorun oranıyla). KARNE_START öncesindeki kayıtlar yayınlanmaz (sıfırlama).
"""
from datetime import datetime

from . import kupon
from .analysis import early_hit, pick_hit
from .config import TR_TZ

KARNE_START = "2026-10-22"  # yeni oran sağlayıcısı ve genişletilmiş modelle karne bu günden başladı


def tr_day(utc):
    try:
        return datetime.fromisoformat(utc.replace("Z", "+00:00")).astimezone(TR_TZ).strftime("%Y-%m-%d")
    except (AttributeError, ValueError):
        return ""


def export(store):
    singles = [r for r in store.pred_all() if tr_day(r.get("utc")) >= KARNE_START]
    singles.sort(key=lambda r: r.get("utc") or "", reverse=True)
    coupons = [d for d in store.coupon_all() if d["date"] >= KARNE_START]
    return {"start": KARNE_START, "singles": singles, "coupons": coupons}


def record(store, b):
    """Maç paketi her yenilendiğinde çağrılır."""
    mid = b["id"]
    st = b.get("status") or {}
    pr = (b.get("analysis") or {}).get("prediction") or {}
    old = store.pred_get(mid)

    if st.get("cancelled"):
        if old and old.get("state") == "pending":
            old["state"] = "void"
            store.pred_put(mid, old)
        return

    if not st.get("started") and not st.get("finished"):
        # başlamadan önce: tahmini güncel tut (maç başlayınca donar)
        if not pr.get("best_pick") or not pr.get("score_pick"):
            return
        # not: "olası sürpriz" bilerek karneye yazılmaz
        store.pred_put(mid, {
            "id": mid, "utc": b.get("utc"), "league_id": b.get("league_id"), "league": b.get("league_name"),
            "home": {"id": b["home"]["id"], "name": b["home"]["name"]},
            "away": {"id": b["away"]["id"], "name": b["away"]["name"]},
            "pick": pr["best_pick"], "score": pr["score_pick"],
            "p": {"1": pr.get("p_home"), "X": pr.get("p_draw"), "2": pr.get("p_away")}, "ms": pr.get("pick"),
            "state": "pending",
        })
        return

    if st.get("started") and not st.get("finished") and old and old.get("state") == "pending":
        # maç sürüyor: canlı skor ve dakika; sonucu kesinleşen tercih (KG Var, üstler...) erkenden sonuçlanır
        hs, as_ = b["home"].get("score"), b["away"].get("score")
        old["live"] = {"score": [hs, as_], "min": st.get("live")}
        if old.get("pick_hit") is None:
            h = early_hit(old["pick"]["code"], hs, as_, b.get("final"))
            if h is not None:
                old["pick_hit"], old["pick_early"] = h, True
        store.pred_put(mid, old)
        return

    if st.get("finished") and old and old.get("state") == "pending":
        hs, as_ = b["home"].get("score"), b["away"].get("score")
        if hs is None or as_ is None:
            return
        ps = [int(x) for x in old["score"]["score"].split("-")]
        ms_real = "1" if hs > as_ else ("X" if hs == as_ else "2")
        hit = pick_hit(old["pick"]["code"], hs, as_, b.get("final"))
        old.pop("live", None)
        old.update({
            # beraberlikte iade gibi durumlarda tercih "iade" sayılır (None)
            "state": "done", "result": [hs, as_],
            "pick_hit": hit,
            "final": b.get("final"),
            "score_hit": ps == [hs, as_],
            "ms_hit": old.get("ms") == ms_real,
        })
        store.pred_put(mid, old)


def seed(store, data):
    """Yayındaki karneyi yerel kayıtlarla birleştirir: eksik kayıtları ekler, yerelde hâlâ "bekliyor" olup
    yayında sonuçlanmış kayıtları günceller (önbellek eski bir sürüme döndüğünde geçmiş kaybolmasın)."""
    if isinstance(data, dict):
        rows = data.get("singles")
        n = kupon.seed(store, data.get("coupons"))
    else:  # eski biçim: yalnızca tek tercih listesi
        rows, n = data, 0
    for r in rows or []:
        if not r.get("id"):
            continue
        local = store.pred_get(r["id"])
        if not local or (local.get("state") == "pending" and r.get("state") == "done"):
            store.pred_put(r["id"], r)
            n += 1
    return n


FROZEN_KEYS = ("prediction", "summary", "scenarios", "commentary")


def freeze(store, b, old_body):
    """Başlama düdüğünden sonra maç sayfasındaki tahmin değişmesin: maç öncesi son analizi korur.
    Önce önceki paketin dondurulmuş kopyası, yoksa maç öncesi son paketin analizi kullanılır; o da yoksa
    (bu düzeltmeden önce başlamış maçlar) en azından garanti tercih ve skor karnedeki kayıtla eşitlenir."""
    if not (b.get("status") or {}).get("started"):
        b.pop("frozen", None)
        return b
    snap = None
    if old_body:
        if old_body.get("frozen"):
            snap = old_body["frozen"]
        elif not (old_body.get("status") or {}).get("started"):
            snap = {k: old_body["analysis"][k] for k in FROZEN_KEYS if k in old_body.get("analysis", {})}
    if snap:
        b["frozen"] = snap
        b["analysis"].update(snap)
    rec = store.pred_get(b["id"])
    if rec:
        pr = b["analysis"]["prediction"]
        pr["best_pick"], pr["score_pick"] = rec["pick"], rec["score"]
    b["analysis"]["frozen"] = True
    return b
