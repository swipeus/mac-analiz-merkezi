"""Model karnesi: her maç için başlamadan önceki son tahmin saklanır, maç bitince sonuçla karşılaştırılır.

Karne üç başlıkta tutulur: tek tercihler (her birine 1000 ₺), günün kombineleri (kupon başına 5000 ₺) ve
skor tahminleri (her birine 10 ₺, skorun oranıyla). KARNE_START öncesindeki kayıtlar yayınlanmaz (sıfırlama).
"""
from datetime import datetime

from . import kupon
import math

from .analysis import code_odds, early_hit, pick_hit, pick_type
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
    rep = calib_table(store)[1]
    lessons(rep)  # rapora ders ve "kanıtlanmış" işaretlerini ekler
    return {"start": KARNE_START, "singles": singles, "coupons": coupons, "lessons": rep,
            "league_lessons": league_lessons(store)[1]}


def lock_pick(store, b):
    """Resmi ilk 11'ler açıklandıktan sonraki ilk analizin garanti tercihi son karardır: maç başlayana kadar
    yeni analizler onu değiştirmez (yalnızca oranı güncellenir). Başlamış maçlar zaten dondurulmuştur."""
    pr = (b.get("analysis") or {}).get("prediction") or {}
    st = b.get("status") or {}
    if st.get("started") or st.get("finished"):
        pr["best_final"] = bool(pr.get("best_pick"))
        return
    if not (b.get("lineup") or {}).get("confirmed") or not pr.get("best_pick"):
        return
    rec = store.pred_get(b["id"])
    if rec and (rec.get("locked") or rec.get("final") is True) and rec.get("pick"):  # "final" eski kayıtlarda kilit bayrağıydı
        bp = {k: v for k, v in rec["pick"].items() if k != "o0"}
        bp["odds"] = code_odds(b.get("odds"), bp["code"])[0] or bp.get("odds")
        pr["best_pick"] = bp
    pr["best_final"] = True


def record(store, b):
    """Maç paketi her yenilendiğinde çağrılır."""
    mid = b["id"]
    st = b.get("status") or {}
    pr = (b.get("analysis") or {}).get("prediction") or {}
    old = store.pred_get(mid)

    if old and b.get("referee") and old.get("referee") != b.get("referee"):  # hakem sayfası için
        old["referee"] = b["referee"]
        if old.get("state") != "pending":
            store.pred_put(mid, old)
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
            # o0: tercihin ilk görülen oranı; maç başlayınca kalan "odds" kapanış oranıdır (kapanış farkı için)
            "pick": {**pr["best_pick"], "o0": code_odds(b.get("odds"), pr["best_pick"]["code"])[1]}, "score": pr["score_pick"],
            "p": {"1": pr.get("p_home"), "X": pr.get("p_draw"), "2": pr.get("p_away")}, "ms": pr.get("pick"),
            "state": "pending", "locked": bool(pr.get("best_final")), "referee": b.get("referee"),
            # değerli oran tercihi: ayrı izlenir (garanti tercih karnesine karışmaz)
            "value": ({**pr["value_pick"], "o0": code_odds(b.get("odds"), pr["value_pick"]["code"])[1]}
                      if pr.get("value_pick") else None),
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
        if old.get("value"):
            old["value_hit"] = pick_hit(old["value"]["code"], hs, as_, b.get("final"))
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


CALIB_MIN_N = 40


def calib_table(store):
    """Tür bazında kalibrasyon: model ortalama %p dedi, gerçekte %h tuttu. En az 40 sonuçlanmış tercih olan ve
    sapması iki standart hatayı aşan türlerde olasılık çarpanı (0.85-1.10 arası, yarı yolda) döner."""
    items = []
    for r in store.pred_all():
        if tr_day(r.get("utc")) >= KARNE_START and r.get("state") == "done" and r.get("pick_hit") is not None:
            items.append((r["pick"]["code"], r["pick"]["p"], bool(r["pick_hit"])))
    for d in store.coupon_all():
        if d["date"] >= KARNE_START:
            for c in d.get("coupons") or []:
                for l in c.get("legs") or []:
                    if l.get("hit") is not None and not l.get("void"):
                        items.append((l["code"], l["p"], bool(l["hit"])))
    by = {}
    for code, p, hit in items:
        by.setdefault(pick_type(code), []).append((p, hit))
    out, report = {}, {}
    for t, xs in by.items():
        n = len(xs)
        mp = sum(p for p, _ in xs) / n
        hr = sum(h for _, h in xs) / n
        se = math.sqrt(max(mp * (1 - mp), 0.01) / n)
        report[t] = {"n": n, "model": round(mp, 3), "hit": round(hr, 3)}
        if n >= CALIB_MIN_N and abs(hr - mp) > 2 * se:
            out[t] = round(min(1.10, max(0.85, 1 + 0.5 * (hr / mp - 1))), 3)
            report[t]["factor"] = out[t]
    return out, report


LESSON_MIN_N = 12
PROVEN_MIN_N = 15


def lessons(report):
    """Karneden ders: modelin sandığından zayıf çıkan türler (tutma oranı modelin olasılığının altında) garanti tercih
    seçiminde geri alınır; fark veri azken küçültülür, en fazla 5 puan. İyi çıkan türler öne alınmaz (tek türe
    yığılma olmasın). Olasılıkları karnede tutan (en az 15 sonuç, sapma -3 puandan iyi) türler "kanıtlanmış" sayılır;
    değerli oran tercihi yalnızca bunlardan seçilir."""
    lesson, proven = {}, set()
    for t, r in report.items():
        n, d = r["n"], r["hit"] - r["model"]
        if n >= LESSON_MIN_N:
            adj = round(max(-0.05, min(0.0, d * n / (n + 40))), 3)
            if adj < 0:
                lesson[t] = r["lesson"] = adj
        if n >= PROVEN_MIN_N and d >= -0.03:
            proven.add(t)
            r["proven"] = True
    return lesson, proven


def backfill_referees(store):
    """Hakem bilgisi olmayan eski kayıtlara, elde maç paketi varsa hakemi ve maç sonu xG'yi yazar (hakem sayfası ve
    kaybın nedeni için). Dönüş: güncellenen kayıt sayısı."""
    n = 0
    for r in store.pred_all():
        fin = r.get("final") if isinstance(r.get("final"), dict) else None  # eski kayıtlarda kilit bayrağı (bool) olabilir
        if r.get("referee") and (fin or {}).get("xg"):
            continue
        b = store.bundle_get(r["id"])
        body = (b or {}).get("body") or {}
        changed = False
        if body.get("referee") and not r.get("referee"):
            r["referee"], changed = body["referee"], True
        if fin and not fin.get("xg") and (body.get("final") or {}).get("xg"):
            r["final"]["xg"], changed = body["final"]["xg"], True
        if changed:
            store.pred_put(r["id"], r)
            n += 1
    return n


LEAGUE_MIN_N = 10


def league_lessons(store):
    """Lig bazında ders: garanti tercihleri karnede modelin olasılığının belirgin altında kalan liglerin tercihleri
    seçimde biraz geri alınır (küçültülmüş fark, en fazla 4 puan; iyi giden ligler öne alınmaz).
    Dönüş: ({lig id: düzeltme}, rapor {lig id: {ad, n, model, hit, lesson?}})."""
    by = {}
    for r in store.pred_all():
        if tr_day(r.get("utc")) >= KARNE_START and r.get("state") == "done" and r.get("pick_hit") is not None:
            by.setdefault(r.get("league_id"), []).append((r["pick"]["p"], bool(r["pick_hit"]), r.get("league")))
    out, rep = {}, {}
    for lid, xs in by.items():
        n = len(xs)
        mp, hr = sum(p for p, _, _ in xs) / n, sum(h for _, h, _ in xs) / n
        rep[lid] = {"name": xs[0][2], "n": n, "model": round(mp, 3), "hit": round(hr, 3)}
        if n >= LEAGUE_MIN_N:
            adj = round(max(-0.04, min(0.0, (hr - mp) * n / (n + 40))), 3)
            if adj < 0:
                out[lid] = rep[lid]["lesson"] = adj
    return out, rep


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
