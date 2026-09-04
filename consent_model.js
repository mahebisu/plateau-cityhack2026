/* =========================================================================
   納得率の推定モデル（プロトタイプ・node で単体実行できる）
   ---------------------------------------------------------------------
   説明充足率（条例から機械的に決まる実測値）を入力の1つとして、
   「納得率」「到達率」「合意率」を推定する。
   理論の出所＝ materials/consent_simulation_persona_model_20260823.md
     ・広瀬・大友(2014)『社会安全学研究』4号：社会的受容＝手続き的公正×計画内容
     ・土木学会論文集D3 69(4) 2013：ELM。理解度が低いほど手続き的公正の重みが増す
     ・令和5年度さいたま市民意識調査（市公式・一次）：属性分布・媒体接触率・関心の重み
     ・横浜市『地区計画策定に向けての合意形成』：好条件下の反対率 2.2%（校正アンカー）
   ★係数はすべて仮。CO（Coefficients）1か所に集約し、感度分析で幅を出す。

     使い方: node consent_model.js       レポートを出す（既定シナリオ＋比較表）
             node dump_cohort.js        ブラウザ版が読む data/consent_cohort.json を書き出す
     ブラウザ版＝ consent.html → http://localhost:8765/consent.html
   ========================================================================= */

/* node でも ブラウザでも同じファイルを読む。
   ブラウザ側は data/consent_cohort.json（node dump_cohort.js で作る）を読むので
   verify_numbers.js（＝巨大GeoJSONを触る部分）は要らない。 */
const IS_NODE = (typeof module !== "undefined" && typeof require === "function");
const V = IS_NODE ? require("./verify_numbers.js") : null;

/* 論点の既定の回答状況。node 側（verify_numbers.js）と同じ値をここにも持つ。 */
/* ★2026-08-24 に論点を全面的に入れ替えた（本人設計）。
   t1 制度の説明／t2 資産価値／t3 同じ規模を建てられるか／t4 事業継続／
   t5 住宅地として（後退のとき）／t6 商業地として（拡大のとき）／t7 日当たり／t8 直後から変わること。
   既定＝標準的な用途地域変更の説明会資料に載るのは制度の説明（t1）だけ、という想定。 */
const DEFAULT_ANSWERED = { t1:true, t2:false, t3:false, t4:false,
                           t5:false, t6:false, t7:false, t8:false };

/* =======================================================================
   0. 係数テーブル。★ここ以外に数字を書かない（感度分析がここを振るため）
   ======================================================================= */
const CO = {
  /* --- 理解度 U --- */
  U0:      0.192,  // 実測：パブコメ制度の認知19.2%（＝手続きの理解の代理・下限アンカー）
  gViz:    0.35,   // 仮：3D可視化（本アプリ）
  gEasy:   0.15,   // 仮：資料の平易化
  gStudy:  0.10,   // 仮：事前学習会
  /* ★論点t1「用途地域の変更とは何か（法律上どう変わるのか）」は、他の7つと種類が違う。
     不利益の大きさではなく“理解できたか”そのものなので、理解度 U に足す（2026-08-24 本人設計）。
     ELM(2013)の含意＝理解度が上がると判断の重心が手続きから内容へ移る。仮の値。 */
  gLegal:  0.12,

  /* --- 手続き的公正 PF の内訳重み（合計1）。参加機会を最大にする（先行研究） --- */
  wPart:   0.35,
  wInfo:   0.25,
  wRepr:   0.20,
  wCtrl:   0.20,

  /* --- 内容評価 CE --- */
  aEff:    0.60,
  aClear:  0.40,
  clearInfo: 0.50,  // わかりやすさのうち、論点への回答が占める割合（残りは理解度U）

  /* --- ELM：理解度による重み配分（U=0で手続き優位、U=1で内容優位） --- */
  bPF0:    0.65, bPFslope: -0.35,
  bCE0:    0.15, bCEslope:  0.35,
  bDF:     0.45,

  /* --- 分配的公正 DF の損失強度 --- */
  lossNonconform: 0.80,  // 既存不適格になる（建て替えで今の規模が建たない）
  lossKinA:       0.50,  // 近隣ア（敷地境界15m かつ 外壁50m）
  lossKinB0:      0.25,  // 近隣イ（日影）の下駄
  lossKinBhour:   0.55,  // 近隣イ 影に入る時刻数/7 に比例する分
  lossShuu:       0.10,  // 周辺住民
  tenureRent:     0.45,  // 賃貸は資産価値の毀損が効かない分だけ弱い（持ち家=1.0）
  /* ★未回答の論点は、その論点に対応する不利益を過大に見積もらせる（不確実性の割増）。
     査読文献からの直接の係数ではなく本モデルの仮定。ただし横浜市の実務ガイドが
     「反対意見は『何に反対しているのか』を明確にする必要がある」と述べている点に対応する。 */
  lossAmp:        0.60,

  /* --- 納得の閾値（ロジスティック） --- */
  theta:   0.30,
  slope:   0.12,

  /* --- 到達率 --- */
  gateAware:  0.192,  // 実測：媒体に触れても手続きに反応する率の代理（パブコメ認知）
  q0:         0.55,   // 未到達者の既定態度（消極的黙認）。定住意向85.2%・無関心38.6%から仮置き

  /* --- ★影響力の失敗（科研費22K05880：参加率を揃えても着座位置・発言回数に差が出る）---
     出席できることと、そこで発言できることは別。対面はこの減衰が大きく、
     非同期・匿名の入力経路ほど小さい（FR-3：投稿順ランダム・属性非表示・投稿数上限）。 */
  voiceEqFace:  0.55,  // 対面での発言機会の実効係数（仮）
  voiceEqAsync: 0.90,  // 非同期経路での同（仮）

  /* --- ★職員の対面対応負荷（カスハラ実態調査を「なぜこの量が中立でないか」の根拠に使う）---
     ★誰が加害するかは一切モデル化しない。総量だけを出す。 */
  faceShareBase: 1.00, // 非同期経路が無いときの対面比率
  asyncTake:     0.65, // 非同期経路を用意したとき、そちらに流れる割合（仮）
  repeatAmp:     1.20  // 未回答の論点が残っている棟の、問い合わせの反復倍率（仮）
};

/* 媒体別の到達率（令和5年度さいたま市民意識調査・実測） */
const MEDIA = {
  shiho:   { label: "市報さいたま",       reach: 0.554, gated: true  },
  hp:      { label: "市・区のHP",         reach: 0.436, gated: true  },
  sns:     { label: "SNS",                reach: 0.280, gated: true  },
  kairan:  { label: "自治会の回覧板",     reach: 0.169, gated: false }, // 手渡し＝制度認知を経由しない
  kobetsu: { label: "個別通知（投函）",   reach: 0.95,  gated: false }
};

/* 便益の訴求軸と、その市民側の重み（実測）
   幹線道路に最も求める機能：安全63.5／快適・利便19.6／防災9.3／環境3.7／活力1.3 */
const BENEFIT = {
  safety:  { label: "生活道路・通学路の安全", sal: 0.635 },
  conv:    { label: "買い物・交通の利便",     sal: 0.196 },
  bosai:   { label: "防災",                   sal: 0.093 },
  green:   { label: "緑化・環境",             sal: 0.037 },
  nigiwai: { label: "にぎわい・活力",         sal: 0.013 }
};

/* 居住形態（実測）：持ち家一戸建て52.9／持ち家集合22.7／民間借家16.6／公営2.3／社宅1.4
   → 用途コードから持ち家確率を割り当てる（PLATEAU の usage は100%収録） */
const OWNER_P = {
  411: 0.86,  // 住宅（戸建て）
  413: 0.80,  // 店舗等併用住宅
  415: 0.80,  // 作業所併用住宅
  412: 0.43,  // 共同住宅（持ち家集合22.7 / (22.7+16.6+2.3+1.4)）
  414: 0.43,  // 店舗等併用共同住宅
  404: 0.60,  // 商業系複合施設
  402: 0.60, 401: 0.60, 403: 0.60, 421: 1.00, 422: 1.00,
  431: 0.60, 441: 0.60, 451: 0.60, 452: 1.00, 454: 0.60, 461: 0.756 // 不明＝全体の持ち家率75.6%
};

/* ★代表性は「参加者をどう集めるか」で決まる。実測のTVD（総変動距離）を使う。
   ⚠️2026-08-23 修正：以前は性別のズレと年代のズレを1本に連結して TVD を計算していた（=別々の分布を
   足していた・誤り）。さらに「説明会は郵送調査よりゆがむ」を skew という根拠のない倍率で表していた。
   → 参加者バイアス研究のWS実測値（男性68%・20代0%・30代9%・50代27%・60代32%）に置き換えた。
   年代のTVDは3セル（18-19/40代/70+）が未公表なので、既知セル＋未知ブロックの差から**下界**を取る。 */
const RECRUIT = {
  koubo:  { label: "公募（WS実測）",              tvdAge: 0.289, tvdSex: 0.188 },
  shimei: { label: "指名（自治会等・WSの73%）",   tvdAge: 0.340, tvdSex: 0.220 },
  mail:   { label: "郵送・全戸配布（実測）",      tvdAge: 0.077, tvdSex: 0.060 },
  random: { label: "無作為抽出（ミニ・パブリックス）", tvdAge: 0.050, tvdSex: 0.040 }
};

/* =======================================================================
   1. 説明会の設計変数（プレイヤーが操作するもの）
   ======================================================================= */
const DEFAULT_PLAN = {
  viz:      true,    // 3D可視化（本アプリ）を使う
  easy:     false,   // 資料を平易化する
  study:    false,   // 事前学習会を開く
  media:    ["shiho"],            // 告知媒体
  weekend:  false,   // 土日昼の回を追加する（平日夜のみだと都内通勤30.8%が来られない）
  rounds:   1,       // 開催回数
  voice:    "classroom",          // classroom / podium / smallgroup
  plans:    1,       // 提示する案の数
  feedback: false,   // 意見の扱い方を事前に説明し、結果をフィードバックする
  benefit:  "nigiwai",            // 便益をどう説明するか
  recruit:  "koubo", // 参加者の集め方（RECRUIT）
  async:    false,   // 非同期・非対面の意見入力を主経路にする（FR-1）
  traceable: false,  // 意見の行き先を公開する（受付→論点化→反映／不採用＋理由・FR-4）
  answered: null     // 論点の回答状況。null なら DEFAULT_ANSWERED を使う
};

const VOICE = { classroom: 0.40, podium: 0.60, smallgroup: 0.90 };

/* 層ごとの「不利益に直結する論点」。
   ★t1（制度の説明）は不利益の大きさではなく理解度なので、ここには入れず U に足している。
   ★t5／t6 は排他。ここは後退側（t5）で書いてある。拡大側のコホート（offsetM>0・2026-09-05）は
     buildCohort が r.lossTopics に t6 へ読み替えた配列を持たせ、estimate はそちらを優先する。 */
const LOSS_TOPICS = {
  subject: ["t3", "t4", "t8"],   // 用途地域そのものが変わる棟＝規模・事業・直後の費用
  kinA:    ["t2", "t5"],         // 至近＝資産価値と環境の変化
  kinB:    ["t2", "t5", "t7"],   // 日影で入った棟だけが日当たりを持つ
  shuu:    ["t2", "t5"]
};

/* =======================================================================
   2. 対象棟を組み立てる（層・距離・日影の時刻数・用途をひとまとめに）
   ======================================================================= */
function buildCohort(offsetM) {
  if (!IS_NODE) throw new Error("buildCohort は node 専用（ブラウザは consent_cohort.json を読む）");
  V.setOffset(offsetM);
  const subjects = [];
  const expand = offsetM > 0;
  V.lineTargets.forEach(t => {
    const st = V.classify(t); if (!st) return;
    if (offsetM < 0) { if (st.state === "over") subjects.push({ f: t.f, h: Number(t.p.h), cap: t.cap }); }
    /* ★2026-09-05 拡大側：当事者＝線を越えて用途地域そのものが変わる棟（freed）。
       旧条件 `h > t.cap` は「いま20mを超えているか」＝後退側と同じ判定で構造的に空だった。
       近隣住民ア（敷地境界15m）は高さに依らないので実測で立てる。イ（高さ2倍・日影）は数えない＝下限。 */
    else if (expand && st.state === "freed") subjects.push({ f: t.f, h: Number(t.p.h), cap: t.cap, freed: true });
  });
  const key = f => f.properties.grp || f.properties.id;
  const rec = new Map();  // 複合体キー -> {layer, topics:Set, feats:[], dist, shHours, usage}
  const touch = (k, f) => {
    if (!rec.has(k)) rec.set(k, { key: k, topics: new Set(), feats: [], dist: Infinity, shHours: 0, layer: null });
    const r = rec.get(k);
    if (r.feats.indexOf(f) < 0) r.feats.push(f);
    return r;
  };
  const rank = { subject: 3, kinA: 2, kinB: 1, shuu: 0 };
  const setLayer = (r, L) => { if (r.layer == null || rank[L] > rank[r.layer]) r.layer = L; };

  subjects.forEach(sj => {
    const j = V.computeJourei(sj.f, sj.h, expand ? { noHeight: true } : null);
    const ring = V.outerRing(sj.f.geometry);
    const add = (f, L) => {
      const r = touch(key(f), f);
      setLayer(r, L);
      V.topicsFor(L).forEach(t => r.topics.add(t));   // 2026-08-24：向きで t5/t6 が入れ替わる
      const c = V.centroidOf(f);
      const d = V.distToRing(c[0], c[1], ring);
      if (d < r.dist) r.dist = d;
      // ★日影は「7時刻のうち何時刻に入るか」まで数える（既存の二値判定を連続量に）
      let n = 0; j.shadows.forEach(sh => { if (V.ptInRing(c[0], c[1], sh.ring)) n++; });
      if (n > r.shHours) r.shHours = n;
    };
    j.kinA.forEach(f => add(f, "kinA"));
    j.kinB.forEach(f => add(f, "kinB"));
    j.shuu.forEach(f => add(f, "shuu"));
    const r = touch(key(sj.f), sj.f);
    setLayer(r, "subject");
    V.topicsFor("subject").forEach(t => r.topics.add(t));
    r.dist = 0; r.nonconform = !expand; r.freed = !!expand; r.h = sj.h; r.cap = sj.cap;
  });

  rec.forEach(r => {
    let rep = r.feats[0];
    r.feats.forEach(f => { if (Number(f.properties.h) > Number(rep.properties.h)) rep = f; });
    r.rep = rep;
    r.usage = Number(rep.properties.usage);
    r.hMax = Number(rep.properties.h);
    /* ★拡大側（2026-09-05）：損失の置き方に新しい係数を作らない。
       当事者のうち住宅系用途（411 住宅／412 共同住宅／413 店舗等併用住宅／414 店舗等併用共同住宅／415 作業所併用住宅）は
       容積の恩恵より先に「隣が高層化する」側＝周辺住民の損失 lossShuu を流用。
       非住宅の当事者は天井が外れる＝利益なので損失 0（利益の係数は作らない）。
       環境の論点は t5→t6 に読み替える（LOSS_TOPICS は後退側の t5 で書いてある）。 */
    if (expand) {
      r.resi = [411, 412, 413, 414, 415].indexOf(r.usage) >= 0;
      r.lossTopics = (LOSS_TOPICS[r.layer] || []).map(t => t === "t5" ? "t6" : t);
    }
    /* 持ち家か賃貸かは、用途別の持ち家率から決定的に割り当てる
       （毎回ぶれると数字が信用されないので、IDのハッシュで固定する） */
    const p = OWNER_P[r.usage] != null ? OWNER_P[r.usage] : 0.756;
    r.owner = hash01(String(r.key)) < p;
  });
  return Array.from(rec.values());
}

function hash01(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) % 100000) / 100000;
}

/* =======================================================================
   3. 推定本体
   ======================================================================= */
const sigmoid = x => 1 / (1 + Math.exp(-x));
const clamp01 = x => Math.max(0, Math.min(1, x));

function estimate(cohort, plan, co) {
  co = co || CO;
  const ans = plan.answered || DEFAULT_ANSWERED;

  /* --- 全棟共通のスカラー --- */
  const U = clamp01(co.U0 + co.gViz * (plan.viz ? 1 : 0) + co.gEasy * (plan.easy ? 1 : 0)
                        + co.gStudy * (plan.study ? 1 : 0)
                        + co.gLegal * ((plan.answered || DEFAULT_ANSWERED).t1 ? 1 : 0));
  const bPF = co.bPF0 + co.bPFslope * U;
  const bCE = co.bCE0 + co.bCEslope * U;

  /* 代表性：参加者の集め方で決まる。年代と性別のTVDのうち大きい方を採る
     （小さい方に引きずられて良く見せない）。非同期経路は時間と場所の制約を外すので
     年代のゆがみを一定ぶん戻す（FR-1・仮） */
  const rc = RECRUIT[plan.recruit] || RECRUIT.koubo;
  const tvdAge = plan.async ? rc.tvdAge * 0.55 : rc.tvdAge;
  const Repr = clamp01(1 - Math.max(tvdAge, rc.tvdSex));

  /* 結果の統制：石割(2007)／川上(1998) 532市区町村調査＝**意見の公表54%**、
     公聴会の意見が審議会に反映されていない市が大半。→ 何もしない状態の下駄を 0.54 ではなく
     「公表はされるが行き先は見えない」に置き、行き先の公開(FR-4)と複数案(FR-5)で積む。 */
  const Ctrl = clamp01(0.20 + 0.25 * (plan.plans > 1 ? 1 : 0)
                            + 0.25 * (plan.feedback ? 1 : 0)
                            + 0.30 * (plan.traceable ? 1 : 0));

  /* 参加機会 ＝ 出席できるか × その場で発言できるか × 回数
     ★「出席できる」と「発言できる」は別（科研費22K05880）。非同期経路はここを構造的に平準化する。 */
  const attend = plan.async ? 0.98 : (plan.weekend ? 0.95 : (1 - 0.308));
  const rounds = 1 - Math.pow(0.6, plan.rounds);
  const voiceEq = plan.async ? co.voiceEqAsync : co.voiceEqFace;
  const Part = clamp01(attend * VOICE[plan.voice] * voiceEq * rounds / (1 - Math.pow(0.6, 1))
                       / co.voiceEqFace);
  // 内容の実効性：市民が反応する軸の重み（実測）に、説明の質（理解度）を掛ける
  const Eff = clamp01(BENEFIT[plan.benefit].sal * (0.5 + 0.5 * U));

  // 到達率（周辺住民のみ媒体依存。近隣住民は条例第9条1項で個別説明が義務＝1.0）
  let miss = 1;
  plan.media.forEach(m => {
    const md = MEDIA[m]; if (!md) return;
    miss *= 1 - md.reach * (md.gated ? co.gateAware : 1);
  });
  const Rshuu = clamp01(1 - miss);

  /* ★職員の対面対応の総量。カスハラ実態調査（総務省2025-04-25）は
     「この量が中立でない理由」として引くだけで、発生率も加害者属性も一切モデル化しない。 */
  const faceShare = co.faceShareBase * (plan.async ? 1 - co.asyncTake : 1);
  let face = 0;

  let sumP = 0, sumR = 0, sumAgree = 0, sumRP = 0;
  const byLayer = {};
  cohort.forEach(r => {
    // 情報開示＝その棟が持つ論点のうち回答済みの割合（★説明充足率の連続版）
    let tot = 0, ok = 0;
    r.topics.forEach(t => { tot++; if (ans[t]) ok++; });
    const Info = tot ? ok / tot : 1;
    const PF = clamp01(co.wInfo * Info + co.wPart * Part + co.wRepr * Repr + co.wCtrl * Ctrl);
    /* ★わかりやすさ＝計画内容の指標（広瀬モデル）。論点への回答は手続き（情報開示）だけでなく
       内容評価にも効く。だから充足率を上げると PF と CE の両方が動く。 */
    const Clear = clamp01(co.clearInfo * Info + (1 - co.clearInfo) * U);
    const CE = clamp01(co.aEff * Eff + co.aClear * Clear);

    // 分配的公正：層と実データ（日影の時刻数・距離）から損失を出す
    let loss = 0;
    if (r.freed) loss = r.resi ? co.lossShuu : 0;          // ★拡大側の当事者（2026-09-05）
    else if (r.layer === "subject") loss = co.lossNonconform;
    else if (r.layer === "kinA") loss = co.lossKinA * (1 - Math.min(1, r.dist / 50));
    else if (r.layer === "kinB") loss = co.lossKinB0 + co.lossKinBhour * (r.shHours / 7);
    else loss = co.lossShuu;
    /* ★その層の「不利益に直結する論点」が未回答だと、不利益が過大に見積もられる */
    const lt = r.lossTopics || LOSS_TOPICS[r.layer] || [];
    let un = 0; lt.forEach(t => { if (!ans[t]) un++; });
    loss *= 1 + co.lossAmp * (lt.length ? un / lt.length : 0);
    const tenure = r.owner ? 1.0 : co.tenureRent;
    const DF = -clamp01(loss) * tenure;

    const SA = bPF * PF + bCE * CE + co.bDF * DF;
    r._CE = CE;
    const P = sigmoid((SA - co.theta) / co.slope);
    const R = (r.layer === "shuu") ? Rshuu : 1.0;
    const agree = R * P + (1 - R) * co.q0;

    /* 未回答の論点が残っている棟ほど、同じ問いが繰り返される（FR-8：回答の資産化） */
    let tu = 0; r.topics.forEach(t => { if (!ans[t]) tu++; });
    face += R * faceShare * (1 + co.repeatAmp * (tot ? tu / tot : 0));

    sumP += P; sumR += R; sumAgree += agree; sumRP += R * P;
    const L = r.layer;
    byLayer[L] = byLayer[L] || { n: 0, p: 0, r: 0, a: 0, rp: 0 };
    byLayer[L].n++; byLayer[L].p += P; byLayer[L].r += R; byLayer[L].a += agree; byLayer[L].rp += R * P;
    r._P = P; r._R = R; r._SA = SA; r._PF = PF; r._DF = DF; r._Info = Info;
  });
  const n = cohort.length;
  return {
    n, U, bPF, bCE, PF_common: { Part, Repr, Ctrl }, Eff, Rshuu,
    nattoku: sumP / n, reach: sumR / n, agree: sumAgree / n,
    /* ★2026-09-04 KGI＝同意率。分母は条文に合わせて2通り（REQ_doui_kgi_20260904.md D3）
       douiAll     ＝ Σ(R×P)/n  … 全員分母（都再法14条・区分所有法62条型）＝KGI
       douiReached ＝ ΣP/n      … 到達者分母（区分所有法17条・31条・円滑化法9条2項型）＝旧・納得率と同値
       agree（合意率・黙認込み）は残す。恒等式 agree − douiAll ＝ q0×(1−reach) */
    douiAll: sumRP / n, douiReached: sumP / n,
    face: face, facePer: face / n, faceShare: faceShare,
    tvdAge: tvdAge, tvdSex: rc.tvdSex,
    byLayer
  };
}

/* =======================================================================
   ★逆問題：「2/3 の合意率にするには、どう設計すればよいか」を解く
   ---------------------------------------------------------------------
   何もしていない状態（＝いまの運用）から始めて、打てる手を1つずつ足していく。
   毎回「合意率が1コストあたり最も上がる手」を選ぶ（貪欲法）。
   目標を越えたところで止め、さらに続ければ 3/4・4/5 に何が要るかがそのまま出る。
   ★大域最適ではない。総当たりとの差は check_optimality.js で測っている。
   ======================================================================= */

/* コスト＝市の手間（人日・費用の代理）。★すべて仮の値。ここだけ直せば順序が変わる。
   「便益の言い換え」だけがコスト0＝タダで最も効く、という結論が出るように作ってはいない。
   実際に効くかどうかは市民意識調査の実測値（安全63.5% / にぎわい1.3%）が決めている。 */
const MEASURES = [
  { id:"benefit", cost:0, label:"便益を「生活道路・通学路の安全」で説明する",
    why:"幹線道路に求める機能の実測＝安全63.5% / にぎわい・活力1.3%。言い換えるだけ",
    avail:p => p.benefit !== "safety", apply:p => ({ benefit:"safety" }) },
  { id:"viz", cost:1, label:"3D可視化（本アプリ）を使う",
    why:"理解度が上がり、判断の重みが手続きから内容へ移る（ELM）",
    avail:p => !p.viz, apply:() => ({ viz:true }) },
  { id:"hp", cost:1, label:"市・区のHPでも告知する",
    why:"接触43.6%。ただし制度認知19.2%のゲートを通る",
    avail:p => p.media.indexOf("hp") < 0, apply:p => ({ media:p.media.concat(["hp"]) }) },
  { id:"podium", cost:1, label:"発言席を設ける（自席発言をやめる）",
    why:"公聴会の52%が自席発言＝学校教室型。討議を妨げる",
    avail:p => p.voice === "classroom", apply:() => ({ voice:"podium" }) },
  { id:"easy", cost:2, label:"資料を平易化する",
    why:"理解度。わかりやすさは計画内容側の指標でもある",
    avail:p => !p.easy, apply:() => ({ easy:true }) },
  { id:"feedback", cost:2, label:"意見の扱い方を事前に説明し、結果を返す",
    why:"手続き的公正の「結果の統制」",
    avail:p => !p.feedback, apply:() => ({ feedback:true }) },
  { id:"kairan", cost:2, label:"自治会の回覧板で配る",
    why:"接触16.9%だが手渡し＝制度認知のゲートを通らない。デジタルに来ない層に届く",
    avail:p => p.media.indexOf("kairan") < 0, apply:p => ({ media:p.media.concat(["kairan"]) }) },
  { id:"sns", cost:1, label:"SNSでも告知する",
    why:"接触28.0%。ゲートあり",
    avail:p => p.media.indexOf("sns") < 0, apply:p => ({ media:p.media.concat(["sns"]) }) },
  { id:"traceable", cost:3, label:"意見の行き先を公開する（受付→論点化→反映／不採用＋理由）",
    why:"公聴会の意見が審議会に反映されたか分からない、が古典的な批判",
    avail:p => !p.traceable, apply:() => ({ traceable:true }) },
  { id:"weekend", cost:3, label:"土日昼の回を追加する",
    why:"勤務先が東京23区30.8%・通勤1時間以上32.3%＝平日夜に来られない",
    avail:p => !p.weekend && !p.async, apply:() => ({ weekend:true }) },
  { id:"mail", cost:3, label:"参加者を郵送・全戸配布で集める",
    why:"公募のTVD 年代0.289 → 郵送0.077。代表性が上がる",
    avail:p => p.recruit === "koubo" || p.recruit === "shimei", apply:() => ({ recruit:"mail" }) },
  { id:"smallgroup", cost:4, label:"少人数討議にする",
    why:"参加機会は手続き的公正の内部で影響が最大",
    avail:p => p.voice === "podium", apply:() => ({ voice:"smallgroup" }) },
  { id:"round2", cost:4, label:"開催回数を増やす（2回目）",
    why:"1回で来られない層",
    avail:p => p.rounds < 2, apply:() => ({ rounds:2 }) },
  { id:"plans", cost:5, label:"複数案を等価に提示する",
    why:"職員評価が最下位だった計画アセス方式（37%）を3Dで安くする",
    avail:p => p.plans < 2, apply:() => ({ plans:2 }) },
  { id:"study", cost:5, label:"事前学習会を開く",
    why:"理解度",
    avail:p => !p.study, apply:() => ({ study:true }) },
  { id:"random", cost:6, label:"参加者を無作為抽出で集める（ミニ・パブリックス）",
    why:"TVD 年代0.050。母集団の縮図に近づける",
    avail:p => p.recruit !== "random", apply:() => ({ recruit:"random" }) },
  { id:"kobetsu", cost:6, label:"個別通知を投函する",
    why:"接触95%・ゲートなし。周辺住民に確実に届く",
    avail:p => p.media.indexOf("kobetsu") < 0, apply:p => ({ media:p.media.concat(["kobetsu"]) }) },
  { id:"async", cost:8, label:"非同期・非対面の意見入力を主経路にする",
    why:"時刻と場所の制約を外す。発言量を構造的に平準化し、職員の対面対応を減らす",
    avail:p => !p.async, apply:() => ({ async:true }) },
  { id:"topics", cost:4, label:"未回答の論点にすべて答える資料を作る",
    why:"条例第11条（意見書には回答義務）。同じ問いの反復も減る",
    avail:p => Object.keys(p.answered || DEFAULT_ANSWERED).some(t => !(p.answered || DEFAULT_ANSWERED)[t]),
    apply:() => ({ answered:{ t1:true,t2:true,t3:true,t4:true,t5:true,t6:true,t7:true,t8:true } }) }
];

/* 何もしていない状態＝いまの運用（市報のみ・平日夜1回・自席発言・単一案・にぎわいで説明・公募） */
const BASE_PLAN = {
  viz:false, easy:false, study:false, media:["shiho"], weekend:false, rounds:1,
  voice:"classroom", plans:1, feedback:false, benefit:"nigiwai",
  recruit:"koubo", async:false, traceable:false, answered:null
};

/* 目標の合意率に、最も安く届く組み合わせを探す。
   ---------------------------------------------------------------------
   ★貪欲法（1コストあたりの伸びが最大の手を足す）は最適を外す。実測で +1／+4／+3 だった
     （`node check_optimality.js` が総当たり524,288通りと突き合わせる）。
     いま効く手より、あとで効く手の前提になる安い手を先に打つべき場面があるため。
   → コストの安い側から幅を持って探す（ビーム探索＋分枝限定）。
     いまの目標では総当たりと一致する。合わなくなったら BEAM を上げる。
   ======================================================================= */
const BEAM = { perCost: 4, total: 60, maxDepth: 14 };
/* ★2026-09-04 解く指標。既定＝ KGI の同意率（全員分母）。"agree" を渡せば旧来の合意率で解く */
const SOLVE_METRIC = "douiAll";

function solveOne(cohort, goal, startPlan, startUsed, metric) {
  metric = metric || SOLVE_METRIC;
  const key = u => Object.keys(u).sort().join(",");
  const mk = (plan, cost, used, steps, e) => ({ plan, cost, used, steps, e });
  let frontier = [mk(Object.assign({}, startPlan, { media: startPlan.media.slice() }),
                    0, Object.assign({}, startUsed), [], estimate(cohort, startPlan))];
  if (frontier[0].e[metric] >= goal - 1e-9) return { steps: [], cost: 0, e: frontier[0].e, reached: true };
  let best = null, seen = {};
  for (let d = 0; d < BEAM.maxDepth && frontier.length; d++) {
    const kids = [];
    frontier.forEach(st => {
      MEASURES.forEach(m => {
        if (st.used[m.id] || !m.avail(st.plan)) return;
        const cost = st.cost + m.cost;
        if (best && cost >= best.cost) return;              // 分枝限定
        const used = Object.assign({}, st.used); used[m.id] = 1;
        const k = key(used); if (seen[k] && seen[k] <= cost) return; seen[k] = cost;
        const plan = Object.assign({}, st.plan, m.apply(st.plan));
        const e = estimate(cohort, plan);
        const steps = st.steps.concat([{ id: m.id, label: m.label, why: m.why, cost: m.cost,
          cumCost: cost, agree: e.agree, nattoku: e.nattoku, reach: e.reach, face: e.face,
          douiAll: e.douiAll, douiReached: e.douiReached }]);
        const node = mk(plan, cost, used, steps, e);
        if (e[metric] >= goal - 1e-9) { if (!best || cost < best.cost) best = node; }
        else kids.push(node);
      });
    });
    /* コストの階層ごとに上位を残す＝「安いが伸びる」枝を落とさない */
    const byCost = {};
    kids.forEach(k => { (byCost[k.cost] = byCost[k.cost] || []).push(k); });
    frontier = [];
    Object.keys(byCost).map(Number).sort((x, y) => x - y).forEach(c => {
      if (best && c >= best.cost) return;
      byCost[c].sort((x, y) => y.e[metric] - x.e[metric]);
      frontier = frontier.concat(byCost[c].slice(0, BEAM.perCost));
    });
    frontier.sort((x, y) => x.cost - y.cost);
    frontier = frontier.slice(0, BEAM.total);
  }
  return best ? { steps: best.steps, cost: best.cost, e: best.e, plan: best.plan,
                  used: best.used, reached: true }
              : { steps: [], cost: null, e: null, reached: false };
}

/* 目標を順に追う。2/3に届いた状態から3/4を、そこから4/5を追う。
   ＝「2/3にはこれ、4/5にはさらにこれ」が1本の道として出る。 */
function solve(cohort, targets, startPlan, metric) {
  metric = metric || SOLVE_METRIC;
  const sorted = targets.slice().sort((a, b) => a - b);
  let plan = Object.assign({}, startPlan || BASE_PLAN);
  plan.media = plan.media.slice();
  let used = {}, steps = [], cost = 0;
  const start = estimate(cohort, plan);
  let cur = start;
  const marks = [];
  for (const goal of sorted) {
    if (cur[metric] >= goal - 1e-9) {
      marks.push({ target: goal, reached: true, atStep: steps.length, cost: cost });
      continue;
    }
    const r = solveOne(cohort, goal, plan, used, metric);
    if (!r.reached) { marks.push({ target: goal, reached: false, atStep: null, cost: null }); break; }
    r.steps.forEach(st => { st.cumCost += cost; st.forGoal = goal; steps.push(st); });
    plan = r.plan; used = r.used; cost += r.cost; cur = r.e;
    marks.push({ target: goal, reached: true, atStep: steps.length, cost: cost });
  }
  return { metric, start: { agree: start.agree, nattoku: start.nattoku, face: start.face,
                    douiAll: start.douiAll, douiReached: start.douiReached },
           steps, marks, plan, cost, final: cur,
           reached: marks.length > 0 && marks[marks.length - 1].reached };
}

/* 感度分析：係数を1つずつ ±50% 振って、納得率の下限と上限を出す（決定的・軽量） */
const SENS_KEYS = ["gViz","gEasy","gStudy","gLegal","wPart","wInfo","wRepr","wCtrl","aEff","aClear",
                   "bPF0","bPFslope","bCE0","bCEslope","bDF",
                   "lossNonconform","lossKinA","lossKinB0","lossKinBhour","lossShuu","lossAmp",
                   "tenureRent","theta","slope","gateAware","q0","clearInfo","voiceEqFace","voiceEqAsync"];
function sensitivity(cohort, plan) {
  let lo = Infinity, hi = -Infinity, worst = null;
  const rows = [];
  SENS_KEYS.forEach(k => {
    let l = Infinity, h = -Infinity;
    [0.5, 1.5].forEach(mul => {
      const co = Object.assign({}, CO); co[k] = CO[k] * mul;
      const e = estimate(cohort, plan, co);
      l = Math.min(l, e.nattoku); h = Math.max(h, e.nattoku);
    });
    rows.push({ k, l, h, span: h - l });
    lo = Math.min(lo, l); hi = Math.max(hi, h);
  });
  rows.sort((a, b) => b.span - a.span);
  return { lo, hi, rows };
}

/* =======================================================================
   4. レポート
   ======================================================================= */
function fmt(x) { return (x * 100).toFixed(1) + "%"; }

if (IS_NODE && require.main === module) {
  const OFF = -60;
  const cohort = buildCohort(OFF);
  const base = estimate(cohort, DEFAULT_PLAN);
  console.log("=== 納得率の推定モデル（プロトタイプ） ===");
  console.log("シナリオ：商業を" + (-OFF) + "m後退／説明対象 " + base.n + " 複合体\n");

  /* ★逆問題を先に出す。「どう設計すると2/3に届くか」 */
  const sol = solve(cohort, [2/3, 3/4, 4/5]);
  console.log("=== 目標の合意率に、最も安く届く説明設計（ビーム探索＋分枝限定）===");
  console.log("何もしない状態（市報のみ・平日夜1回・自席発言・単一案・にぎわいで説明・公募）");
  console.log("  → 合意率 " + fmt(sol.start.agree) + " ／ 職員の対面対応 " + sol.start.face.toFixed(0) + "件\n");
  console.log("  #  コスト 累計  合意率   対面   打つ手");
  let shown = {};
  sol.steps.forEach((st, i) => {
    let mark = "";
    [[2/3,"◀ 2/3 達成"],[3/4,"◀ 3/4 達成"],[4/5,"◀ 4/5 達成"]].forEach(([t,lb]) => {
      if (!shown[lb] && st.agree >= t) { mark = "   " + lb; shown[lb] = 1; }
    });
    console.log("  " + String(i+1).padStart(2) + "   " + String(st.cost).padStart(2)
      + "  " + String(st.cumCost).padStart(3) + "  " + fmt(st.agree).padStart(6)
      + "  " + st.face.toFixed(0).padStart(4) + "件  " + st.label + mark);
  });
  const nmT = t => t === 2/3 ? "2/3" : t === 3/4 ? "3/4" : "4/5";
  sol.marks.forEach(m => {
    if (!m.reached) { console.log("  ✗ " + nmT(m.target) + " に届かない（打てる手が尽きた）"); return; }
    const alone = solve(cohort, [m.target]);
    const prem = m.cost - alone.cost;
    console.log("  ★ " + nmT(m.target) + " は " + m.atStep + "手目・累計コスト " + m.cost + " で達成"
      + "（最初からこの目標だけを狙えば " + alone.cost + "。"
      + (prem > 0 ? "段階的に上げた分の割高 +" + prem : "割高なし") + "）");
  });
  console.log("  ※ 総当たり524,288通りとの突き合わせは node check_optimality.js");
  console.log("");

  const sat = (() => { V.setOffset(OFF); V.computeAggregate(); const s = V.satisfaction(); return s; })();
  console.log("【入力】説明充足率（条例から機械的に決まる実測値） " + sat.ok + "/" + sat.total
              + " ＝ " + fmt(sat.ok / sat.total));
  console.log("        理解度 U=" + base.U.toFixed(3)
              + "  → 重み 手続き" + base.bPF.toFixed(2) + " / 内容" + base.bCE.toFixed(2) + "（ELM）");
  console.log("        参加機会 " + base.PF_common.Part.toFixed(2)
              + " ／ 代表性 " + base.PF_common.Repr.toFixed(2)
              + "（年代TVD " + base.tvdAge.toFixed(3) + " 性別TVD " + base.tvdSex.toFixed(3) + "）"
              + " ／ 結果の統制 " + base.PF_common.Ctrl.toFixed(2)
              + " ／ 実効性 " + base.Eff.toFixed(2));
  console.log("\n【出力】納得率 " + fmt(base.nattoku)
              + " ／ 到達率 " + fmt(base.reach)
              + " ／ 合意率 " + fmt(base.agree)
              + " ／ 対面対応 " + base.face.toFixed(0) + "件");
  console.log("        周辺住民への到達率 " + fmt(base.Rshuu) + "（媒体＝" + DEFAULT_PLAN.media.join("+") + "）");
  console.log("\n層別：");
  ["subject","kinA","kinB","shuu"].forEach(L => {
    const b = base.byLayer[L]; if (!b) return;
    const nm = { subject:"当事者      ", kinA:"近隣ア      ", kinB:"近隣イ      ", shuu:"周辺住民    " }[L];
    console.log("  " + nm + b.n + "棟  納得 " + fmt(b.p/b.n) + "  到達 " + fmt(b.r/b.n) + "  合意 " + fmt(b.a/b.n));
  });

  const s = sensitivity(cohort, DEFAULT_PLAN);
  console.log("\n【感度】係数を1つずつ±50%: 納得率 " + fmt(s.lo) + " 〜 " + fmt(s.hi));
  console.log("  影響の大きい係数 上位5:");
  s.rows.slice(0,5).forEach(r => console.log("    " + r.k.padEnd(16) + fmt(r.l) + " 〜 " + fmt(r.h)));

  /* --- 操作を1つずつ足していく --- */
  console.log("\n=== 説明会の設計を1つずつ良くすると何が動くか ===");
  const steps = [
    ["基準（市報のみ・平日夜1回・教室型・単一案・にぎわいで説明）", {}],
    ["＋ 論点t2「資産価値は上がるのか下がるのか」に答える", { answered: Object.assign({}, DEFAULT_ANSWERED, {t2:true}) }],
    ["＋ 論点t5「住宅地として住みやすくなるのか」にも答える", { answered: Object.assign({}, DEFAULT_ANSWERED, {t2:true,t5:true}) }],
    ["＋ 便益を「にぎわい」から「生活道路の安全」に変える", { benefit:"safety" }],
    ["＋ 土日昼の回を追加（都内通勤30.8%が来られる）",  { weekend:true }],
    ["＋ 少人数討議にする",                             { voice:"smallgroup" }],
    ["＋ 複数案を出し、意見の反映を事前に説明する",     { plans:2, feedback:true }],
    ["＋ 回覧板と個別通知を足す（周辺住民に届く）",     { media:["shiho","hp","kairan","kobetsu"] }],
    ["＋ 資料を平易化し、事前学習会を開く",             { easy:true, study:true }]
  ];
  let acc = Object.assign({}, DEFAULT_PLAN);
  console.log("".padEnd(52) + "納得率   到達率   合意率   対面件数");
  steps.forEach(([label, patch]) => {
    acc = Object.assign(acc, patch);
    const e = estimate(cohort, acc);
    console.log(label.padEnd(50) + "  " + fmt(e.nattoku).padStart(6)
                + "  " + fmt(e.reach).padStart(6) + "  " + fmt(e.agree).padStart(6)
                + "  " + e.face.toFixed(0).padStart(6));
  });

  /* --- ★参加者の集め方だけを変える（代表性の失敗） --- */
  console.log("\n=== 参加者の集め方だけを変える（他は基準のまま）===");
  ["shimei","koubo","mail","random"].forEach(k => {
    const e = estimate(cohort, Object.assign({}, DEFAULT_PLAN, { recruit: k }));
    console.log("  " + RECRUIT[k].label.padEnd(30) + " 代表性 " + e.PF_common.Repr.toFixed(3)
                + " ／ 納得 " + fmt(e.nattoku).padStart(6));
  });

  /* --- ★非同期・非対面の意見入力を主経路にする（FR-1／FR-3／FR-8） --- */
  console.log("\n=== 非同期・非対面の入力を主経路にすると何が起きるか ===");
  const full = { media: ["shiho","hp","kairan","kobetsu"], benefit: "safety", traceable: true };
  [["対面のみ（基準）", {}],
   ["対面のみ＋論点に全部答える", { answered: {t1:1,t2:1,t3:1,t4:1,t5:1,t6:1,t7:1,t8:1} }],
   ["非同期を主経路に", { async: true }],
   ["非同期＋論点に全部答える", { async: true, answered: {t1:1,t2:1,t3:1,t4:1,t5:1,t6:1,t7:1,t8:1} }]
  ].forEach(([lb, patch]) => {
    const e = estimate(cohort, Object.assign({}, DEFAULT_PLAN, full, patch));
    console.log("  " + lb.padEnd(28) + " 納得 " + fmt(e.nattoku).padStart(6)
                + " ／ 合意 " + fmt(e.agree).padStart(6)
                + " ／ 代表性 " + e.PF_common.Repr.toFixed(3)
                + " ／ 対面対応 " + e.face.toFixed(0).padStart(4) + "件");
  });

  /* --- ★周知を強めると合意率が下がる（＝黙認が納得に置き換わる）の確認 --- */
  console.log("\n=== 周知だけを強めたとき（他は基準のまま）===");
  [["市報のみ",["shiho"]],["＋HP",["shiho","hp"]],["＋SNS",["shiho","hp","sns"]],
   ["＋回覧板",["shiho","hp","sns","kairan"]],["＋個別通知",["shiho","hp","sns","kairan","kobetsu"]]]
  .forEach(([lb, md]) => {
    const e = estimate(cohort, Object.assign({}, DEFAULT_PLAN, { media: md }));
    console.log("  " + lb.padEnd(12) + " 到達 " + fmt(e.reach).padStart(6)
                + " ／ 納得 " + fmt(e.nattoku).padStart(6) + " ／ 合意 " + fmt(e.agree).padStart(6));
  });
}

const API = { CO, MEDIA, BENEFIT, OWNER_P, VOICE, RECRUIT, LOSS_TOPICS, DEFAULT_ANSWERED,
               DEFAULT_PLAN, SENS_KEYS, MEASURES, BASE_PLAN, SOLVE_METRIC, buildCohort, estimate, sensitivity, solve };
if (IS_NODE) module.exports = API; else window.ConsentModel = API;
