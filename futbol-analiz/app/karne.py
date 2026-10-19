"""Model karnesi: her maç için başlamadan önceki son tahmin saklanır, maç bitince sonuçla karşılaştırılır."""
from .analysis import pick_hit


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
        if not pr.get("best_pick") or not pr.get("scores"):
            return
        store.pred_put(mid, {
            "id": mid, "utc": b.get("utc"), "league_id": b.get("league_id"), "league": b.get("league_name"),
            "home": {"id": b["home"]["id"], "name": b["home"]["name"]},
            "away": {"id": b["away"]["id"], "name": b["away"]["name"]},
            "pick": pr["best_pick"], "score": pr["scores"][0],
            "p": {"1": pr.get("p_home"), "X": pr.get("p_draw"), "2": pr.get("p_away")}, "ms": pr.get("pick"),
            "state": "pending",
        })
        return

    if st.get("finished") and old and old.get("state") == "pending":
        hs, as_ = b["home"].get("score"), b["away"].get("score")
        if hs is None or as_ is None:
            return
        ps = [int(x) for x in old["score"]["score"].split("-")]
        ms_real = "1" if hs > as_ else ("X" if hs == as_ else "2")
        old.update({
            "state": "done", "result": [hs, as_],
            "pick_hit": pick_hit(old["pick"]["code"], hs, as_),
            "score_hit": ps == [hs, as_],
            "ms_hit": old.get("ms") == ms_real,
        })
        store.pred_put(mid, old)


def seed(store, rows):
    """Önbellek kaybolduysa yayındaki karneden geçmişi geri yükler (mevcut kayıtların üstüne yazmaz)."""
    n = 0
    for r in rows or []:
        if r.get("id") and not store.pred_get(r["id"]):
            store.pred_put(r["id"], r)
            n += 1
    return n
