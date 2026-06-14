"""WC2026 Fantasy XV selector -- pick the best 15-player squad."""
from models.wc_predictor import FIFA_RANKINGS

POS_SLOTS = {"GK":2,"DEF":5,"MID":5,"FWD":3}
POS_NORM  = {"Goalkeeper":"GK","Defender":"DEF","Midfielder":"MID","Forward":"FWD",
             "Attacker":"FWD","G":"GK","D":"DEF","M":"MID","F":"FWD"}
PRIME_AGE = {"GK":(28,35),"DEF":(24,32),"MID":(22,29),"FWD":(21,28)}


def _player_score(team_rank: int, pos: str, age: int) -> float:
    strength = max(0.0,(65-team_rank)/64.0)
    lo,hi    = PRIME_AGE[pos]
    age_fit  = max(0.0,1.0-abs(age-(lo+hi)/2)/8.0)
    return round(strength*0.72+age_fit*0.28,4)


def select_fantasy_xv(teams: list, squads: dict) -> dict:
    """Select the best XV across all WC2026 squads (max 3 per nation)."""
    id2name = {t["id"]:t["name"] for t in teams}
    pool: list = []
    for tid,players in squads.items():
        team = id2name.get(tid,"?")
        rank = FIFA_RANKINGS.get(team,55)
        for p in players:
            pos = POS_NORM.get(p.get("position") or p.get("pos_abbr") or "",None)
            if not pos: continue
            try: age = int(p.get("age") or 27)
            except: age = 27
            pool.append({"id":p.get("id",""),"name":p.get("name","?"),"jersey":p.get("jersey","?"),
                "team":team,"team_id":tid,"team_rank":rank,"pos":pos,"age":age,
                "height":p.get("height","?"),"citizenship":p.get("citizenship",team),
                "score":_player_score(rank,pos,age),"injured":bool(p.get("injured"))})
    pool.sort(key=lambda x:(-x["score"],x["injured"]))
    selected,pc,nc=[],{k:0 for k in POS_SLOTS},{}
    for p in pool:
        if p["injured"] or pc.get(p["pos"],0)>=POS_SLOTS[p["pos"]] or nc.get(p["team"],0)>=3: continue
        selected.append(p); pc[p["pos"]]=pc.get(p["pos"],0)+1; nc[p["team"]]=nc.get(p["team"],0)+1
        if len(selected)==15: break
    selected.sort(key=lambda x:({"GK":0,"DEF":1,"MID":2,"FWD":3}.get(x["pos"],9),-x["score"]))
    return {"squad":selected,"total":len(selected),
            "nations":len({p["team"] for p in selected}),"pos_breakdown":pc}
