"""WC2026 match-outcome predictor -- RandomForest trained on FIFA data."""
import pickle
from pathlib import Path
import numpy as np, pandas as pd, requests
from sklearn.ensemble import RandomForestClassifier
from sklearn.model_selection import cross_val_score
from sklearn.preprocessing import StandardScaler
from requests.adapters import HTTPAdapter
from requests.packages.urllib3.util.retry import Retry

FIFA_RANKINGS = {
    "Argentina":1,"France":2,"Spain":3,"England":4,"Brazil":5,"Portugal":6,
    "Belgium":7,"Netherlands":8,"Germany":9,"Uruguay":10,"Colombia":11,"Croatia":12,
    "Italy":13,"Morocco":14,"Mexico":15,"USA":16,"United States":16,"Switzerland":17,
    "Senegal":18,"Iran":19,"Japan":20,"South Korea":21,"Ecuador":22,"Canada":23,
    "Qatar":24,"Denmark":25,"Austria":26,"Poland":27,"Australia":28,"Serbia":29,
    "Czechia":30,"Czech Republic":30,"Hungary":31,"Scotland":32,"Ukraine":33,
    "Turkey":34,"Turkiye":34,"Slovenia":35,"Slovakia":36,"Romania":37,"Norway":38,
    "Greece":39,"Egypt":40,"Cameroon":41,"Algeria":42,"Nigeria":43,"South Africa":44,
    "Tunisia":45,"Ghana":46,"Ivory Coast":47,"Zambia":48,"Namibia":49,"Saudi Arabia":50,
    "Iraq":51,"Jordan":52,"Bahrain":53,"Oman":54,"New Zealand":55,"Fiji":56,"Haiti":57,
    "Honduras":58,"Jamaica":59,"El Salvador":60,"Curacao":61,"Venezuela":62,"Chile":63,
    "Paraguay":64,"Bolivia":65,"Peru":66,"Bosnia-Herzegovina":67,"Wales":68,"Tahiti":69,
}
CONFED_STRENGTH = {"CONMEBOL":0.95,"UEFA":1.0,"CONCACAF":0.75,"CAF":0.70,"AFC":0.65,"OFC":0.55}
CONFED_MAP = {
    **{t:"CONMEBOL" for t in ["Argentina","Brazil","Uruguay","Colombia","Ecuador","Paraguay","Chile","Venezuela","Bolivia","Peru"]},
    **{t:"UEFA" for t in ["France","Spain","England","Portugal","Germany","Netherlands","Belgium","Croatia","Switzerland","Denmark","Austria","Wales","Poland","Serbia","Czechia","Czech Republic","Hungary","Scotland","Ukraine","Turkey","Slovenia","Slovakia","Romania","Norway","Greece","Bosnia-Herzegovina"]},
    **{t:"CONCACAF" for t in ["Mexico","USA","United States","Canada","Honduras","Haiti","Jamaica","El Salvador","Curacao","Panama"]},
    **{t:"CAF" for t in ["Morocco","Senegal","Cameroon","Algeria","Nigeria","South Africa","Tunisia","Ghana","Ivory Coast","Zambia","Namibia","Egypt"]},
    **{t:"AFC" for t in ["Japan","South Korea","Iran","Saudi Arabia","Australia","Qatar","Iraq","Jordan","Bahrain","Oman"]},
    **{t:"OFC" for t in ["New Zealand","Fiji","Tahiti"]},
}
HOST_NATIONS = {"USA","United States","Canada","Mexico"}
WC_SEASONS   = {"Qatar2022":255711,"Russia2018":254645,"Brazil2014":244319}
FEATURES     = ["home_rank","away_rank","rank_diff","home_conf","away_conf","conf_diff","home_host"]
MODEL_PATH   = Path("data/wc_model.pkl")

def rank(t): return FIFA_RANKINGS.get(t,55)
def confed_strength(t): return CONFED_STRENGTH.get(CONFED_MAP.get(t,"UEFA"),0.65)

def _get_session_with_retries(retries: int = 3, backoff_factor: float = 0.5):
    """Create a requests session with automatic retry logic."""
    session = requests.Session()
    retry_strategy = Retry(
        total=retries,
        backoff_factor=backoff_factor,
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"]
    )
    adapter = HTTPAdapter(max_retries=retry_strategy)
    session.mount("http://", adapter)
    session.mount("https://", adapter)
    return session

def _fetch_history():
    rows=[]; hdr={"User-Agent":"Mozilla/5.0","Accept":"application/json"}
    session = _get_session_with_retries()
    try:
        for name,sid in WC_SEASONS.items():
            try:
                r=session.get("https://api.fifa.com/api/v3/calendar/matches",headers=hdr,
                    params={"idCompetition":17,"idSeason":sid,"language":"en","count":100},timeout=12)
                if not r.ok: continue
                for m in r.json().get("Results",[]):
                    h=m.get("Home",{}); a=m.get("Away",{})
                    if not h or not a: continue
                    hs=h.get("Score",0)or 0; as_=a.get("Score",0)or 0
                    hn=(h.get("TeamName")or[{}])[0].get("Description","")
                    an=(a.get("TeamName")or[{}])[0].get("Description","")
                    if not hn or not an: continue
                    rows.append({"home_rank":rank(hn),"away_rank":rank(an),"rank_diff":rank(an)-rank(hn),
                        "home_conf":confed_strength(hn),"away_conf":confed_strength(an),
                        "conf_diff":confed_strength(hn)-confed_strength(an),
                        "home_host":1 if hn in HOST_NATIONS else 0,
                        "label":0 if hs>as_ else(1 if hs==as_ else 2)})
            except Exception as e: print(f"[ML] {name}: {e}")
    finally:
        session.close()
    return rows


class WCPredictor:
    """RandomForest classifier that predicts home-win / draw / away-win."""
    def __init__(self): self.clf=None; self.scaler=StandardScaler(); self.trained=False

    def train(self):
        rows=_fetch_history(); rng=np.random.default_rng(42)
        for hr in range(1,50,3):
            for ar in range(hr+5,65,5):
                diff=ar-hr; ph=min(0.75,0.40+diff*0.005)
                lbl=0 if rng.random()<ph else(1 if rng.random()<0.3 else 2)
                rows.append({"home_rank":hr,"away_rank":ar,"rank_diff":diff,
                    "home_conf":0.9,"away_conf":0.7,"conf_diff":0.2,"home_host":0,"label":lbl})
        df=pd.DataFrame(rows); Xs=self.scaler.fit_transform(df[FEATURES].values); y=df["label"].values
        self.clf=RandomForestClassifier(n_estimators=300,max_depth=7,min_samples_leaf=3,
            class_weight="balanced",random_state=42,n_jobs=-1)
        self.clf.fit(Xs,y)
        cv=cross_val_score(self.clf,Xs,y,cv=5,scoring="accuracy")
        print(f"[ML] Trained | CV: {cv.mean():.1%}"); self.trained=True
        MODEL_PATH.parent.mkdir(parents=True,exist_ok=True)
        with open(MODEL_PATH,"wb") as f: pickle.dump({"clf":self.clf,"scaler":self.scaler},f)
        return self

    def load_or_train(self):
        if MODEL_PATH.exists():
            try:
                with open(MODEL_PATH,"rb") as f: d=pickle.load(f)
                self.clf=d["clf"]; self.scaler=d["scaler"]; self.trained=True; print("[ML] Loaded")
            except Exception as e:
                print(f"[ML] Model load failed: {e}, retraining...")
                self.train()
        else: self.train()
        return self

    def predict(self,home,away):
        hr=rank(home); ar=rank(away); hc=confed_strength(home); ac=confed_strength(away)
        feat=[hr,ar,ar-hr,hc,ac,hc-ac,1 if home in HOST_NATIONS else 0]
        if self.trained and self.clf:
            Xs=self.scaler.transform([feat]); proba=self.clf.predict_proba(Xs)[0]
            pm=dict(zip(self.clf.classes_,proba))
            hw=round(pm.get(0,.34)*100,1); dr=round(pm.get(1,.28)*100,1); aw=round(pm.get(2,.34)*100,1); mdl="RandomForest"
        else:
            diff=feat[2]; hw=round(min(85,max(10,40+diff*.5+(5 if home in HOST_NATIONS else 0))),1)
            aw=round(min(80,max(8,40-diff*.5)),1); dr=round(max(5,100-hw-aw),1); mdl="Heuristic"
        winner=home if hw>aw else(away if aw>hw else "Draw")
        return {"home":home,"away":away,"home_win_pct":hw,"draw_pct":dr,"away_win_pct":aw,
                "predicted_winner":winner,"confidence":round(max(hw,aw),1),
                "home_rank":feat[0],"away_rank":feat[1],"model":mdl}

    def predict_fixtures(self,fx):
        return [{**f,"prediction":self.predict(f["home_team"],f["away_team"])}
                for f in fx if f.get("status_state") in("pre","")]
