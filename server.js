require("dotenv").config();
const express = require("express");
const compression = require("compression");
const fetch = global.fetch;

const app = express();
const PORT = process.env.PORT || 3000;

/* =========================================================
   Perf helpers (レイアウト非変更で体感を上げる)
   - gzip圧縮
   - 静的ファイルのCache-Control
   - Riot APIへの同時リクエストを抑制（Render Freeで安定しやすい）
   - 主要APIの短時間キャッシュ
   ========================================================= */

// HTML/CSS/JS/JSONを軽くする（見た目は変わらない）
app.use(compression());

// 静的ファイルをブラウザにキャッシュさせる（再訪を速く）
// ※ 更新頻度が高い間はmax-ageを短めに。
app.use(
  express.static("public", {
    setHeaders(res, filePath) {
      // htmlはキャッシュしすぎると更新が反映されにくいので短く
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "public, max-age=0, must-revalidate");
        return;
      }
      // css/jsは少しだけキャッシュ（更新は比較的入るため）
      if (filePath.endsWith(".css") || filePath.endsWith(".js")) {
        res.setHeader("Cache-Control", "public, max-age=3600"); // 1h
        return;
      }
      // 画像系は長めでOK
      if (/(\.png|\.jpg|\.jpeg|\.webp|\.gif|\.svg)$/i.test(filePath)) {
        res.setHeader("Cache-Control", "public, max-age=86400"); // 1d
        return;
      }
      res.setHeader("Cache-Control", "public, max-age=600");
    },
  })
);

// /result でも結果ページへ行けるように（任意）
app.get("/result", (req, res) => res.redirect("/result.html"));

const RIOT_API_KEY = process.env.RIOT_API_KEY;

// JP想定（必要なら .env で変更可）
const PLATFORM = (process.env.RIOT_PLATFORM || "jp1").toLowerCase(); // jp1, kr, na1...
const REGION = (process.env.RIOT_REGION || "asia").toLowerCase(); // asia, americas, europe

function platformUrl(path) {
  return `https://${PLATFORM}.api.riotgames.com${path}`;
}
function regionUrl(path) {
  return `https://${REGION}.api.riotgames.com${path}`;
}

async function riotFetch(url) {
  if (!RIOT_API_KEY) {
    return { ok: false, status: 500, data: { message: "RIOT_API_KEY is missing" } };
  }

  try {
    const res = await fetch(url, { headers: { "X-Riot-Token": RIOT_API_KEY } });
    const ct = res.headers.get("content-type") || "";
    const data = ct.includes("application/json")
      ? await res.json().catch(() => null)
      : { text: await res.text().catch(() => "") };

    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 500, data: { message: String(err) } };
  }
}

/* =========================
   Riot API concurrency limit
   ========================= */
function createSemaphore(max) {
  let active = 0;
  const q = [];
  const acquire = () =>
    new Promise((resolve) => {
      if (active < max) {
        active++;
        resolve();
      } else {
        q.push(resolve);
      }
    });
  const release = () => {
    active = Math.max(0, active - 1);
    const next = q.shift();
    if (next) {
      active++;
      next();
    }
  };
  return { acquire, release };
}

// Render Freeだと並列が多いほど不安定になりやすいので少なめ推奨
const RIOT_SEM = createSemaphore(Number(process.env.RIOT_CONCURRENCY || 4));

async function riotFetchLimited(url) {
  await RIOT_SEM.acquire();
  try {
    return await riotFetch(url);
  } finally {
    RIOT_SEM.release();
  }
}

/* =========================
   Short TTL cache for Riot endpoints
   - account/summoner/ranked/match-ids/live 等
   - 失効が早いデータは短め、match-v5は既存の5分キャッシュ
   ========================= */
const API_CACHE = new Map(); // key -> { ts, ttl, value }
const API_CACHE_MAX = 400;

function apiCacheGet(key) {
  const v = API_CACHE.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > v.ttl) {
    API_CACHE.delete(key);
    return null;
  }
  // LRU
  API_CACHE.delete(key);
  API_CACHE.set(key, v);
  return v.value;
}

function apiCacheSet(key, ttl, value) {
  API_CACHE.set(key, { ts: Date.now(), ttl, value });
  if (API_CACHE.size > API_CACHE_MAX) {
    const oldestKey = API_CACHE.keys().next().value;
    API_CACHE.delete(oldestKey);
  }
}

async function riotFetchCached(url, ttlMs, cacheKey) {
  const key = cacheKey || url;
  const cached = apiCacheGet(key);
  if (cached) return { ...cached, cached: true };

  const r = await riotFetchLimited(url);
  // 200のみキャッシュ（エラーをキャッシュすると復旧が遅れる）
  if (r.ok) apiCacheSet(key, ttlMs, r);
  return { ...r, cached: false };
}

async function mapLimit(list, limit, fn) {
  const ret = new Array(list.length);
  let i = 0;

  async function worker() {
    while (i < list.length) {
      const idx = i++;
      ret[idx] = await fn(list[idx], idx);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, list.length) }, worker));
  return ret;
}

/* =========================================================
   Match-V5 キャッシュ（▼展開のラグ対策）
   - 同じ matchId を /api/match と /api/matchteams が両方取りに行くため、
     ここで短時間キャッシュして Riot API 往復を減らします。
   ========================================================= */
const MATCH_CACHE = new Map(); // key: matchId -> { ts, data }
const MATCH_TTL_MS = 5 * 60 * 1000; // 5分
const MATCH_CACHE_MAX = 200; // メモリ暴走防止（必要なら調整）

function cacheGet(matchId) {
  const v = MATCH_CACHE.get(matchId);
  if (!v) return null;

  if (Date.now() - v.ts > MATCH_TTL_MS) {
    MATCH_CACHE.delete(matchId);
    return null;
  }

  // LRUっぽくする（最近使ったものを後ろへ）
  MATCH_CACHE.delete(matchId);
  MATCH_CACHE.set(matchId, v);

  return v.data;
}

function cacheSet(matchId, data) {
  MATCH_CACHE.set(matchId, { ts: Date.now(), data });

  if (MATCH_CACHE.size > MATCH_CACHE_MAX) {
    const oldestKey = MATCH_CACHE.keys().next().value;
    MATCH_CACHE.delete(oldestKey);
  }
}

async function getMatchV5(matchId) {
  const cached = cacheGet(matchId);
  if (cached) return { ok: true, status: 200, data: cached, cached: true };

  const r = await riotFetchLimited(regionUrl(`/lol/match/v5/matches/${encodeURIComponent(matchId)}`));
  if (r.ok) cacheSet(matchId, r.data);
  return { ...r, cached: false };
}

/**
 * RiotID -> puuid + iconId + (可能なら) summonerId
 */
app.get("/api/summary/:name/:tag", async (req, res) => {
  const { name, tag } = req.params;

  // RiotID -> puuid はほぼ変わらないので少し長めにキャッシュ
  const account = await riotFetchCached(
    regionUrl(`/riot/account/v1/accounts/by-riot-id/${encodeURIComponent(name)}/${encodeURIComponent(tag)}`),
    10 * 60 * 1000,
    `acct:${String(name).toLowerCase()}#${String(tag).toLowerCase()}`
  );
  if (!account.ok) return res.status(account.status).json({ error: "account not found", detail: account.data });

  const puuid = account.data.puuid;

  // アイコン等は頻繁に変わらないので短めキャッシュ
  const summoner = await riotFetchCached(
    platformUrl(`/lol/summoner/v4/summoners/by-puuid/${encodeURIComponent(puuid)}`),
    2 * 60 * 1000,
    `sum:${puuid}`
  );
  if (!summoner.ok) return res.status(summoner.status).json({ error: "summoner not found", detail: summoner.data });

  // devキー/権限で summoner.data.id が返らないことがある（= nullになる）
  const summonerId = summoner.data?.id ?? null;

  res.json({
    puuid,
    summonerId,
    name: account.data.gameName,
    tag: account.data.tagLine,
    iconId: summoner.data?.profileIconId ?? null,

    // デバッグ用（不要なら消してOK）
    summonerName: summoner.data?.name ?? null,
    platform: PLATFORM,
    region: REGION,
  });
});

/**
 * ランク情報（Solo/Flex）: SummonerID版（残してOK）
 */
app.get("/api/ranked/:summonerId", async (req, res) => {
  const { summonerId } = req.params;
  if (!summonerId || summonerId === "null" || summonerId === "undefined") {
    return res.json({ solo: null, flex: null, note: "summonerId missing" });
  }

  const r = await riotFetchCached(
    platformUrl(`/lol/league/v4/entries/by-summoner/${encodeURIComponent(summonerId)}`),
    2 * 60 * 1000,
    `rank:sid:${summonerId}`
  );
  if (!r.ok) return res.status(r.status).json({ error: "league api error", detail: r.data });

  const entries = Array.isArray(r.data) ? r.data : [];
  const pick = (queueType) => entries.find((e) => e.queueType === queueType) || null;

  res.json({
    solo: pick("RANKED_SOLO_5x5"),
    flex: pick("RANKED_FLEX_SR"),
  });
});

/**
 * ランク情報（Solo/Flex）: ✅ PUUID版（summonerIdがnullでもOK）
 */
app.get("/api/ranked-by-puuid/:puuid", async (req, res) => {
  const { puuid } = req.params;
  if (!puuid || puuid === "null" || puuid === "undefined") {
    return res.json({ solo: null, flex: null, note: "puuid missing" });
  }

  const r = await riotFetchCached(
    platformUrl(`/lol/league/v4/entries/by-puuid/${encodeURIComponent(puuid)}`),
    2 * 60 * 1000,
    `rank:puuid:${puuid}`
  );
  if (!r.ok) return res.status(r.status).json({ error: "league api error", detail: r.data });

  const entries = Array.isArray(r.data) ? r.data : [];
  const pick = (queueType) => entries.find((e) => e.queueType === queueType) || null;

  res.json({
    solo: pick("RANKED_SOLO_5x5"),
    flex: pick("RANKED_FLEX_SR"),
  });
});

/**
 * LIVE（Spectator）
 * まずPuuidを試し、ダメならsummonerの方を試す
 */
app.get("/api/live/:id", async (req, res) => {
  const { id } = req.params;

  if (!id || id === "null" || id === "undefined") {
    return res.status(400).json({ error: "live id missing", detail: { id } });
  }

  // ① PUUID向け（推奨）
  // LIVEは変化が速いので短時間キャッシュ（連打時だけ効く）
  const byPuuid = await riotFetchCached(
    platformUrl(`/lol/spectator/v5/active-games/by-puuid/${encodeURIComponent(id)}`),
    15 * 1000,
    `live:puuid:${id}`
  );

  if (byPuuid.status === 404) return res.json({ inGame: false });
  if (byPuuid.ok) {
    const g = byPuuid.data;
    const participants = (g.participants || []).map((p) => ({
      teamId: p.teamId,
      puuid: p.puuid || null,
      summonerName: p.summonerName || null,
      riotId: p.riotId || null,
      championId: p.championId,
      spell1Id: p.spell1Id,
      spell2Id: p.spell2Id,
      perks: p.perks || null,
    }));
    return res.json({
      inGame: true,
      gameId: g.gameId,
      gameLength: g.gameLength,
      gameMode: g.gameMode,
      queueId: g.gameQueueConfigId,
      participants,
      _via: "by-puuid",
    });
  }

  // ② フォールバック
  const bySummoner = await riotFetchCached(
    platformUrl(`/lol/spectator/v5/active-games/by-summoner/${encodeURIComponent(id)}`),
    15 * 1000,
    `live:sid:${id}`
  );

  if (bySummoner.status === 404) return res.json({ inGame: false });
  if (!bySummoner.ok) return res.status(bySummoner.status).json({ error: "spectator api error", detail: bySummoner.data });

  const g = bySummoner.data;
  const participants = (g.participants || []).map((p) => ({
    teamId: p.teamId,
    puuid: p.puuid || null,
    summonerName: p.summonerName || null,
    riotId: p.riotId || null,
    championId: p.championId,
    spell1Id: p.spell1Id,
    spell2Id: p.spell2Id,
    perks: p.perks || null,
  }));

  res.json({
    inGame: true,
    gameId: g.gameId,
    gameLength: g.gameLength,
    gameMode: g.gameMode,
    queueId: g.gameQueueConfigId,
    participants,
    _via: "by-summoner",
  });
});

/**
 * 履歴：マッチID 20件
 */
app.get("/api/matches/:puuid", async (req, res) => {
  const { puuid } = req.params;

  // 同じ人の履歴は短時間なら変わりにくい
  const result = await riotFetchCached(
    regionUrl(`/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?count=20`),
    30 * 1000,
    `matchids:${puuid}:20`
  );

  res.status(result.status).json(result);
});

/**
 * ✅ DUO（直近N戦で2回以上同じチーム）
 * GET /api/with/:puuid?count=20&min=2
 *
 * 返すもの：
 * { count, min, usedMatches, players:[{riotId,name,tag,iconId,level,games,wins,losses,winRate}] }
 */
app.get("/api/with/:puuid", async (req, res) => {
  const { puuid } = req.params;
  const count = Math.max(1, Math.min(50, Number(req.query.count || 20)));
  const min = Math.max(2, Math.min(10, Number(req.query.min || 2)));

  if (!puuid || puuid === "null" || puuid === "undefined") {
    return res.status(400).json({ error: "puuid missing" });
  }

  // matchIds
  const idsRes = await riotFetchCached(
    regionUrl(`/lol/match/v5/matches/by-puuid/${encodeURIComponent(puuid)}/ids?count=${encodeURIComponent(count)}`),
    30 * 1000,
    `matchids:${puuid}:${count}`
  );
  if (!idsRes.ok) return res.status(idsRes.status).json({ error: "match ids error", detail: idsRes.data });

  const ids = Array.isArray(idsRes.data) ? idsRes.data : [];
  if (!ids.length) return res.json({ count, min, usedMatches: 0, players: [] });

  const acc = new Map(); // key(lower) -> stats

  function keyOf(name, tag) {
    return `${String(name || "").trim().toLowerCase()}#${String(tag || "").trim().toLowerCase()}`;
  }

  function remakeOf(info, me) {
    const gameDuration = Number(info?.gameDuration || 0);
    const remakeFlag =
      me?.gameEndedInEarlySurrender ??
      info?.participants?.[0]?.gameEndedInEarlySurrender ??
      false;

    const remakeFallback = gameDuration > 0 && gameDuration <= 300; // 5分以下
    return !!remakeFlag || remakeFallback;
  }

  // 20試合分のMatch-V5を読む（並列は抑える）
  const results = await mapLimit(ids, 2, async (matchId) => {
    const r = await getMatchV5(matchId);
    if (!r.ok) return null;
    return r.data;
  });

  let usedMatches = 0;

  for (const m of results) {
    if (!m?.info?.participants) continue;

    const info = m.info;
    const me = (info.participants || []).find((p) => p.puuid === puuid);
    if (!me) continue;

    // ✅ リメイクはDUO集計から除外（OPGG寄せ）
    if (remakeOf(info, me)) continue;

    usedMatches++;

    const myTeam = me.teamId;
    const isWin = !!me.win;

    const teamMates = (info.participants || []).filter((p) => p.teamId === myTeam && p.puuid !== puuid);

    for (const p of teamMates) {
      const name = p.riotIdGameName || null;
      const tag = p.riotIdTagline || null;

      // ストリーマーモード等（riotId欠損）はスキップ
      if (!name || !tag) continue;

      const k = keyOf(name, tag);

      const iconId = p.profileIcon ?? p.profileIconId ?? null;
      const level = p.summonerLevel ?? null;

      const cur = acc.get(k) || {
        riotId: `${name}#${tag}`,
        name,
        tag,
        iconId,
        level,
        games: 0,
        wins: 0,
        losses: 0,
      };

      cur.games += 1;
      if (isWin) cur.wins += 1;
      else cur.losses += 1;

      // 最新の情報で上書き（任意）
      cur.iconId = iconId ?? cur.iconId;
      cur.level = level ?? cur.level;

      acc.set(k, cur);
    }
  }

  const players = Array.from(acc.values())
    .filter((x) => Number(x.games || 0) >= min)
    .map((x) => {
      const w = Number(x.wins || 0);
      const l = Number(x.losses || 0);
      const t = w + l;
      const winRate = t > 0 ? Math.round((w / t) * 100) : 0;
      return { ...x, winRate };
    })
    .sort((a, b) => {
      const dg = Number(b.games) - Number(a.games);
      if (dg !== 0) return dg;
      return Number(b.winRate) - Number(a.winRate);
    });

  res.json({ count, min, usedMatches, players });
});

/**
 * 履歴カード（トップ画面用）：自分の情報だけ返す（軽量）
 * ✅ リメイク判定を追加して返す
 */
app.get("/api/match/:matchId/:puuid", async (req, res) => {
  const { matchId, puuid } = req.params;

  // ★ここがキャッシュ対象（Riotへの重いリクエスト）
  const result = await getMatchV5(matchId);
  if (!result.ok) return res.status(result.status).json({ error: "match not found", detail: result.data });

  const info = result.data.info;
  const me = (info.participants || []).find((p) => p.puuid === puuid);
  if (!me) return res.status(404).json({ error: "player not found in match" });

  const gameDuration = Number(info.gameDuration || 0);
  const queueId = info.queueId ?? null;
  const gameMode = info.gameMode ?? null;
  const gameEndMs =
    info.gameEndTimestamp || (info.gameCreation ? Number(info.gameCreation) + gameDuration * 1000 : null) || null;

  // ✅ Remake 判定（公式フラグ優先、保険で短時間終了も見る）
  const remakeFlag =
    me?.gameEndedInEarlySurrender ??
    info?.participants?.[0]?.gameEndedInEarlySurrender ??
    false;

  const remakeFallback = gameDuration > 0 && gameDuration <= 300; // 5分以下を保険
  const remake = !!remakeFlag || remakeFallback;

  const cs = (me.totalMinionsKilled || 0) + (me.neutralMinionsKilled || 0);
  const csPerMin = gameDuration > 0 ? cs / (gameDuration / 60) : null;

  const myTeam = (info.participants || []).filter((p) => p.teamId === me.teamId);
  const teamKills = myTeam.reduce((sum, p) => sum + (p.kills || 0), 0);
  const kp = teamKills > 0 ? (me.kills + me.assists) / teamKills : null;

  const items = [me.item0, me.item1, me.item2, me.item3, me.item4, me.item5, me.item6].map((x) => Number(x || 0));

  let keystoneId = null;
  let subStyleId = null;
  try {
    const styles = me.perks?.styles || [];
    const primary = styles[0];
    const secondary = styles[1];
    keystoneId = primary?.selections?.[0]?.perk ?? null;
    subStyleId = secondary?.style ?? null;
  } catch { }

  res.json({
    queueId,
    gameMode,
    gameEndMs,
    gameDuration,

    // ✅ 勝敗表示はフロント側で remake を優先して上書きする
    remake,
    win: !!me.win,

    championName: me.championName,
    champLevel: me.champLevel,

    spell1Id: me.summoner1Id,
    spell2Id: me.summoner2Id,
    perks: { perkIds: keystoneId ? [keystoneId] : [], perkSubStyle: subStyleId },

    kills: me.kills,
    deaths: me.deaths,
    assists: me.assists,

    cs,
    csPerMin,
    kp,

    items,
  });
});

/**
 * ▼展開用：10人（5v5）＋ロール（TOP/JG/MID/ADC/SUP）付き
 */
app.get("/api/matchteams/:matchId/:puuid", async (req, res) => {
  const { matchId, puuid } = req.params;

  // ★ここもキャッシュ対象（履歴カードと同じ試合を読むため）
  const result = await getMatchV5(matchId);
  if (!result.ok) return res.status(result.status).json({ error: "match not found", detail: result.data });

  const info = result.data.info;

  const toRole = (p) => {
    const tp = String(p.teamPosition || p.individualPosition || "").toUpperCase();
    if (tp === "TOP") return "TOP";
    if (tp === "JUNGLE") return "JG";
    if (tp === "MIDDLE" || tp === "MID") return "MID";
    if (tp === "BOTTOM" || tp === "BOT") return "ADC";
    if (tp === "UTILITY" || tp === "SUPPORT") return "SUP";
    return "OTHER";
  };

  const participants = (info.participants || []).map((p) => {
    const gameName = p.riotIdGameName || null;
    const tagLine = p.riotIdTagline || null;

    let keystoneId = null;
    let subStyleId = null;
    try {
      const styles = p.perks?.styles || [];
      const primary = styles[0];
      const secondary = styles[1];
      keystoneId = primary?.selections?.[0]?.perk ?? null;
      subStyleId = secondary?.style ?? null;
    } catch { }

    return {
      teamId: p.teamId,
      isMe: p.puuid === puuid,
      role: toRole(p),

      name: gameName,
      tag: tagLine,
      anonymous: !gameName,

      championName: p.championName,
      spell1Id: p.summoner1Id,
      spell2Id: p.summoner2Id,
      perks: { perkIds: keystoneId ? [keystoneId] : [], perkSubStyle: subStyleId },
    };
  });

  res.json({
    blue: participants.filter((p) => p.teamId === 100),
    red: participants.filter((p) => p.teamId === 200),
  });
});

app.listen(PORT, () => {
  console.log(`Server running → http://localhost:${PORT}`);
});