window.addEventListener("DOMContentLoaded", () => {
  // ===== 共通DOM =====
  const riotIdInput = document.getElementById("riotId");
  const loadBtn = document.getElementById("load");
  const statusEl = document.getElementById("status");

  // ===== Resultページにだけ存在するDOM =====
  const summary = document.getElementById("summary");
  const matches = document.getElementById("matches");

  // 左サイド（Resultのみ：無ければ後で自動生成）
  let side = document.getElementById("side");

  const STREAMER_LABEL = "配信者モード";
  const isResultPage = !!(summary && matches);

  // 検索の世代（古い非同期結果で上書きしない用）
  let RUN_TOKEN = 0;

  // ===========================
  // ✅ 更新ディレイ（裏側だけ：連打防止）
  // ===========================
  const SEARCH_COOLDOWN_MS = 1500; // 好みで調整
  let lastSearchAt = 0;
  let isSearching = false;

  // クールダウン中に押された「最後の1回」だけを予約して実行する
  let pendingSearchRaw = null;
  let pendingTimer = null;

  function setSearchUIBusy(on) {
    if (!loadBtn) return;
    loadBtn.disabled = !!on;
  }

  function clearPendingTimer() {
    if (pendingTimer) {
      clearTimeout(pendingTimer);
      pendingTimer = null;
    }
  }

  /**
   * 連打を吸収して「最後に押された1回」だけを実行する
   * - 文字は出さない（setStatusしない）
   * - 入力形式がダメな時だけメッセージを出す
   */
  function requestSearch(raw) {
    const s = String(raw || "").trim();

    // 入力形式が明らかにダメなら、連打防止の対象にしない
    if (!parseRiotId(s)) {
      setStatus("サモナー名#タグ の形式で入力してください");
      return;
    }

    // 実行中なら、最後の入力だけ予約して終了
    if (isSearching) {
      pendingSearchRaw = s;
      return;
    }

    const now = Date.now();
    const remain = SEARCH_COOLDOWN_MS - (now - lastSearchAt);

    // クールダウン中：最後の入力だけ予約して、時間が来たら1回だけ実行
    if (remain > 0) {
      pendingSearchRaw = s;

      clearPendingTimer();
      setSearchUIBusy(true);

      pendingTimer = setTimeout(() => {
        pendingTimer = null;
        if (isSearching) return;

        const next = pendingSearchRaw;
        pendingSearchRaw = null;

        if (!next) {
          setSearchUIBusy(false);
          return;
        }

        lastSearchAt = Date.now();
        isSearching = true;
        setSearchUIBusy(true);
        runSearch(next);
      }, remain + 30);

      return;
    }

    // 即実行
    lastSearchAt = now;
    isSearching = true;
    setSearchUIBusy(true);
    runSearch(s);
  }

  // ===== Resultレイアウト（左サイド追加：HTMLを書き換えなくても動くように自動生成）=====
  function ensureResultLayout() {
    if (!isResultPage) return document.getElementById("side");

    const page = document.getElementById("page") || document.querySelector(".page");
    if (page) page.classList.add("result");

    // 既存のグリッド or 作成
    let grid = document.getElementById("resultGrid");
    if (!grid) {
      grid = document.createElement("div");
      grid.id = "resultGrid";
      grid.className = "result-grid";

      // summary の直前に差し込む（#status の下に来る）
      const parent = summary.parentElement;
      parent.insertBefore(grid, summary);
    } else {
      grid.classList.add("result-grid");
    }

    // side を確保
    let sideEl = document.getElementById("side");
    if (!sideEl) {
      sideEl = document.createElement("aside");
      sideEl.id = "side";
      sideEl.className = "side";
      sideEl.setAttribute("aria-label", "side panel");
    }

    // 以前の構造（result-main等）があれば解体して、summary/matchesを救出
    const oldMain = grid.querySelector(".result-main");
    if (oldMain) {
      if (oldMain.contains(summary)) oldMain.removeChild(summary);
      if (oldMain.contains(matches)) oldMain.removeChild(matches);
      oldMain.remove();
    }

    // すでにgrid配下に居なければ一旦外してから入れる
    const detach = (el) => {
      if (el && el.parentElement && el.parentElement !== grid) el.parentElement.removeChild(el);
    };
    detach(summary);
    detach(matches);
    detach(sideEl);

    // 正しい並びで入れる：summary（全幅）→ side（左）→ matches（右）
    if (summary.parentElement !== grid) grid.appendChild(summary);
    if (sideEl.parentElement !== grid) grid.appendChild(sideEl);
    if (matches.parentElement !== grid) grid.appendChild(matches);

    // 並び順を強制
    grid.insertBefore(summary, grid.firstChild);
    if (sideEl.previousElementSibling !== summary) grid.insertBefore(sideEl, summary.nextSibling);
    if (matches.previousElementSibling !== sideEl) grid.insertBefore(matches, sideEl.nextSibling);

    return sideEl;
  }

  // ===========================
  // ✅ モバイル順番調整（プロフィール→RANK→LIVE/履歴→DUO）
  // ===========================
  function syncMobileOrder() {
    if (!matches || !side) return;

    const duoHost = document.getElementById("sideDuoHost");
    const rankHost = document.getElementById("sideRankHost");
    if (!duoHost) return;

    const isMobile = window.matchMedia("(max-width: 900px)").matches;

    if (isMobile) {
      // DUOをLIVE/履歴の最後へ
      matches.appendChild(duoHost);
    } else {
      // PCはサイドに戻して、rankの直後へ
      if (rankHost && rankHost.parentElement === side) {
        side.insertBefore(duoHost, rankHost.nextSibling);
      } else if (duoHost.parentElement !== side) {
        side.appendChild(duoHost);
      }
    }
  }


  if (isResultPage) {
    side = ensureResultLayout();
  }

  if (!riotIdInput || !loadBtn) {
    console.error("必要なDOMが見つかりません（#riotId / #load）");
    return;
  }

  // ===== 文字/表示系 =====
  function setStatus(msg) {
    if (!statusEl) return;
    const text = (msg || "").trim();
    statusEl.textContent = text;
    statusEl.hidden = !text;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }


  // ===== 文字数（全角換算）=====
  // ASCII/半角カナ=0.5、それ以外=1 として数える
  function zenkakuLen(s) {
    let n = 0;
    for (const ch of String(s ?? "")) {
      const cp = ch.codePointAt(0);
      const isHalf = (cp <= 0x7f) || (cp >= 0xff61 && cp <= 0xff9f);
      n += isHalf ? 0.5 : 1;
    }
    return n;
  }

  // 全角換算で6文字以上なら true
  function isLongName(name, threshold = 6) {
    return zenkakuLen(String(name ?? "").trim()) >= threshold;
  }

  function parseRiotId(raw) {
    const s = String(raw || "").trim();
    if (!s.includes("#")) return null;
    const [name, tag] = s.split("#");
    if (!name || !tag) return null;
    return { name: name.trim(), tag: tag.trim() };
  }

  function normalizeRiotId(raw) {
    const p = parseRiotId(raw);
    if (!p) return null;
    return `${p.name}#${p.tag}`;
  }

  function entryFromRiotId(riotId) {
    const p = parseRiotId(riotId);
    return {
      riotId,
      name: p?.name ?? String(riotId || ""),
      tag: p?.tag ?? "",
      badge: "",
    };
  }

  // ===========================
  // ✅ お気に入り比較の正規化
  // ===========================
  function riotIdKey(riotId) {
    const p = parseRiotId(riotId);
    if (p) return `${p.name.trim().toLowerCase()}#${p.tag.trim().toLowerCase()}`;
    return String(riotId || "").trim().toLowerCase();
  }
  function sameRiotId(a, b) {
    return riotIdKey(a) === riotIdKey(b);
  }

  function formatDuration(sec) {
    sec = Math.max(0, Number(sec || 0));
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function formatAgo(ms) {
    if (!ms) return "";
    const diff = Date.now() - Number(ms);
    const min = Math.floor(diff / 60000);
    if (min < 60) return `${min}分前`;
    const hr = Math.floor(min / 60);
    if (hr < 24) return `${hr}時間前`;
    const d = Math.floor(hr / 24);
    return `${d}日前`;
  }

  function queueLabel(queueId, gameMode) {
    const q = Number(queueId);
    if (q === 420) return "ソロランク";
    if (q === 440) return "フレックス";
    if (q === 450) return "ARAM";
    if (q === 400 || q === 430) return "ノーマル";
    if (gameMode) return String(gameMode);
    return "不明";
  }

  // ===== ローカル保存（最近/お気に入り）=====
  const LS_RECENT = "recent_summoners_v2";
  const LS_FAV = "fav_summoners_v2";

  function loadList(key) {
    try {
      const raw = localStorage.getItem(key);
      const arr = JSON.parse(raw || "[]");
      if (!Array.isArray(arr)) return [];
      return arr
        .map((x) => ({
          riotId: typeof x?.riotId === "string" ? x.riotId : null,
          name: typeof x?.name === "string" ? x.name : null,
          tag: typeof x?.tag === "string" ? x.tag : null,
          badge: typeof x?.badge === "string" ? x.badge : "",
        }))
        .filter((x) => x.riotId && x.name && x.tag);
    } catch {
      return [];
    }
  }

  function saveList(key, list) {
    try {
      localStorage.setItem(key, JSON.stringify(list));
    } catch { }
  }

  function isFav(riotId) {
    const fav = loadList(LS_FAV);
    const key = riotIdKey(riotId);
    return fav.some((x) => riotIdKey(x.riotId) === key);
  }

  function upsertRecent(entry) {
    const list = loadList(LS_RECENT);
    const key = riotIdKey(entry?.riotId);
    const next = [entry, ...list.filter((x) => riotIdKey(x.riotId) !== key)].slice(0, 30);
    saveList(LS_RECENT, next);
  }

  function removeRecent(riotId) {
    const list = loadList(LS_RECENT);
    const key = riotIdKey(riotId);
    saveList(LS_RECENT, list.filter((x) => riotIdKey(x.riotId) !== key));
  }

  function setFav(entry, on) {
    const fav = loadList(LS_FAV);
    const key = riotIdKey(entry?.riotId);

    const cleaned = fav.filter((x) => riotIdKey(x.riotId) !== key);

    if (on) {
      const next = [entry, ...cleaned].slice(0, 50);
      saveList(LS_FAV, next);
    } else {
      saveList(LS_FAV, cleaned);
    }
  }

  function updateBadgeEverywhere(riotId, badge) {
    const upd = (key) => {
      const list = loadList(key);
      const next = list.map((x) => (sameRiotId(x.riotId, riotId) ? { ...x, badge: badge || "" } : x));
      saveList(key, next);
    };
    upd(LS_RECENT);
    upd(LS_FAV);
  }

  // ===== ランク表記（D4/E1…）=====
  const TIER_ABBR = {
    IRON: "I",
    BRONZE: "B",
    SILVER: "S",
    GOLD: "G",
    PLATINUM: "P",
    EMERALD: "E",
    DIAMOND: "D",
    MASTER: "M",
    GRANDMASTER: "GM",
    CHALLENGER: "C",
  };

  const RANK_ROMAN_TO_ARABIC = {
    I: "1",
    II: "2",
    III: "3",
    IV: "4",
  };

  function tierShort(entry) {
    if (!entry?.tier) return "";

    const t = String(entry.tier).toUpperCase();
    const ab = TIER_ABBR[t] || t.slice(0, 1);

    const rRaw = entry.rank ? String(entry.rank).toUpperCase() : "";
    const r = RANK_ROMAN_TO_ARABIC[rRaw] || "";

    return r ? `${ab}${r}` : `${ab}`;
  }

  function rankLine(entry, label) {
    if (!entry?.tier) return `${label} アンランク 0W0L 勝率0%`;
    const w = Number(entry.wins || 0);
    const l = Number(entry.losses || 0);
    const wr = w + l > 0 ? Math.round((w / (w + l)) * 100) : 0;
    const ts = tierShort(entry) || "—";
    return `${label} ${ts} ${w}W${l}L 勝率${wr}%`;
  }

  function primaryBadgeFromRanked(ranked) {
    const solo = ranked?.solo || null;
    const flex = ranked?.flex || null;
    return tierShort(solo) || tierShort(flex) || "";
  }

  // ===== 検索バー ドロップダウン（最近/お気に入り）=====
  const searchWrap = riotIdInput.closest(".search") || riotIdInput.parentElement;
  let searchPanel = null;

  function ensureSearchPanel() {
    if (searchPanel) return searchPanel;
    if (!searchWrap) return null;

    searchWrap.classList.add("has-panel");

    const panel = document.createElement("div");
    panel.id = "searchPanel";
    panel.className = "search-panel";
    panel.hidden = true;
    panel.dataset.tab = "recent";

    panel.innerHTML = `
      <div class="sp-head" role="tablist" aria-label="検索リスト切替">
        <button type="button" class="sp-tab is-active" data-tab="recent" role="tab" aria-selected="true">最近の検索</button>
        <button type="button" class="sp-tab" data-tab="fav" role="tab" aria-selected="false">お気に入り</button>
      </div>

      <div class="sp-grid">
        <div class="sp-col sp-recent" data-col="recent">
          <div class="sp-title">最近の検索</div>
          <div class="sp-list" data-list="recent"></div>
        </div>

        <div class="sp-col sp-fav" data-col="fav">
          <div class="sp-title">お気に入り</div>
          <div class="sp-list" data-list="fav"></div>
        </div>
      </div>
    `;

    searchWrap.appendChild(panel);
    searchPanel = panel;

    panel.querySelectorAll(".sp-tab").forEach((btn) => {
      btn.addEventListener("click", () => {
        const tab = btn.dataset.tab;
        panel.dataset.tab = tab;

        panel.querySelectorAll(".sp-tab").forEach((b) => {
          const on = b.dataset.tab === tab;
          b.classList.toggle("is-active", on);
          b.setAttribute("aria-selected", on ? "true" : "false");
        });

        renderPanelLists();
      });
    });

    panel.addEventListener("click", onPanelClick);

    return panel;
  }

  function openPanel() {
    const p = ensureSearchPanel();
    if (!p) return;
    renderPanelLists();
    p.hidden = false;
  }

  function closePanel() {
    if (!searchPanel) return;
    searchPanel.hidden = true;
  }

  function renderPanelLists() {
    if (!searchPanel) return;

    const recent = loadList(LS_RECENT);
    const fav = loadList(LS_FAV);

    const recentEl = searchPanel.querySelector(`[data-list="recent"]`);
    const favEl = searchPanel.querySelector(`[data-list="fav"]`);

    const row = (entry, mode) => {
      const favOn = isFav(entry.riotId);

      const badgeHtml = entry.badge
        ? `<span class="sp-badge">${escapeHtml(entry.badge)}</span>`
        : `<span class="sp-badge sp-badge-empty"></span>`;

      const actions =
        mode === "recent"
          ? `
            <button type="button" class="sp-star ${favOn ? "is-on" : ""}" aria-label="お気に入り"></button>
            <button type="button" class="sp-del" aria-label="履歴から削除">×</button>
          `
          : `
            <button type="button" class="sp-unfav" aria-label="お気に入りから削除">×</button>
          `;

      return `
        <div class="sp-row" data-riotid="${escapeHtml(entry.riotId)}">
          <button type="button" class="sp-main" title="${escapeHtml(entry.riotId)}">
            ${badgeHtml}
            <span class="sp-name">${escapeHtml(entry.name)}</span>
            <span class="sp-tag">#${escapeHtml(entry.tag)}</span>
          </button>

          <div class="sp-actions">
            ${actions}
          </div>
        </div>
      `;
    };

    recentEl.innerHTML =
      recent.length === 0
        ? `<div class="sp-empty">最近の検索はありません</div>`
        : recent.map((e) => row(e, "recent")).join("");

    favEl.innerHTML =
      fav.length === 0
        ? `<div class="sp-empty">お気に入りはありません</div>`
        : fav.map((e) => row(e, "fav")).join("");
  }

  function onPanelClick(ev) {
    const r = ev.target.closest(".sp-row");
    if (!r) return;

    const riotId = r.getAttribute("data-riotid");
    if (!riotId) return;

    const entry = (() => {
      const p = parseRiotId(riotId);
      return p ? { riotId, name: p.name, tag: p.tag, badge: "" } : null;
    })();
    if (!entry) return;

    if (ev.target.closest(".sp-star")) {
      const on = !isFav(riotId);

      const fromRecent = loadList(LS_RECENT).find((x) => sameRiotId(x.riotId, riotId)) || null;
      const fromFav = loadList(LS_FAV).find((x) => sameRiotId(x.riotId, riotId)) || null;

      const base = fromRecent || fromFav || entry || entryFromRiotId(riotId);

      const fixed = {
        ...entryFromRiotId(riotId),
        ...base,
        riotId,
      };

      setFav(fixed, on);

      renderPanelLists();
      syncProfileStarIfSame(riotId);

      ev.preventDefault();
      ev.stopPropagation();
      return;
    }

    if (ev.target.closest(".sp-del")) {
      removeRecent(riotId);
      renderPanelLists();
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }

    if (ev.target.closest(".sp-unfav")) {
      setFav(entry, false);
      renderPanelLists();
      syncProfileStarIfSame(riotId);
      ev.preventDefault();
      ev.stopPropagation();
      return;
    }

    riotIdInput.value = riotId;
    closePanel();

    if (isResultPage) requestSearch(riotId);
    else location.href = `/result.html?riotId=${encodeURIComponent(riotId)}`;
  }

  riotIdInput.addEventListener("focus", () => openPanel());
  riotIdInput.addEventListener("click", () => openPanel());
  riotIdInput.addEventListener("input", () => openPanel());

  document.addEventListener("pointerdown", (e) => {
    if (!searchPanel || searchPanel.hidden) return;
    const inside = searchWrap?.contains(e.target);
    if (!inside) closePanel();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePanel();
  });

  // ===== DataDragon（軽量キャッシュ）=====
  const TTL_MS = 24 * 60 * 60 * 1000;

  function readCache(key) {
    try {
      const raw = localStorage.getItem(key);
      if (!raw) return null;
      const obj = JSON.parse(raw);
      if (!obj?.value || !obj?.ts) return null;
      if (Date.now() - obj.ts > TTL_MS) return null;
      return obj.value;
    } catch {
      return null;
    }
  }

  function writeCache(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify({ value, ts: Date.now() }));
    } catch { }
  }

  async function getLatestDdragonVersionCached() {
    const cached = readCache("dd_ver");
    if (cached) return cached;
    const versions = await fetch("https://ddragon.leagueoflegends.com/api/versions.json").then((r) => r.json());
    const v = Array.isArray(versions) && versions[0] ? versions[0] : "latest";
    writeCache("dd_ver", v);
    return v;
  }

  async function getSpellKeyToImgMap(ddragon) {
    const key = `dd_spell_${ddragon}`;
    const cached = readCache(key);
    if (cached) return cached;

    const json = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ddragon}/data/ja_JP/summoner.json`).then((r) =>
      r.json()
    );
    const map = {};
    for (const k of Object.keys(json?.data || {})) {
      const sp = json.data[k];
      if (sp?.key && sp?.image?.full) map[String(sp.key)] = sp.image.full;
    }
    writeCache(key, map);
    return map;
  }

  async function getRuneIdToIconMap(ddragon) {
    const key = `dd_rune_${ddragon}`;
    const cached = readCache(key);
    if (cached) return cached;

    const json = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ddragon}/data/ja_JP/runesReforged.json`).then(
      (r) => r.json()
    );
    const map = {};
    for (const st of json || []) {
      if (st?.id && st?.icon) map[String(st.id)] = st.icon;
      for (const slot of st?.slots || []) {
        for (const rr of slot?.runes || []) {
          if (rr?.id && rr?.icon) map[String(rr.id)] = rr.icon;
        }
      }
    }
    writeCache(key, map);
    return map;
  }

  function spellIcon(ddragon, spellId, spellMap) {
    const full = spellMap[String(spellId)];
    if (!full) return `<span class="icon18 ph"></span>`;
    return `<img class="icon18" src="https://ddragon.leagueoflegends.com/cdn/${ddragon}/img/spell/${full}" loading="lazy" onerror="this.style.display='none'">`;
  }

  function runeIcon(runeIdToIcon, id) {
    const icon = runeIdToIcon[String(id)];
    if (!icon) return `<span class="icon18 ph"></span>`;
    return `<img class="icon18" src="https://ddragon.leagueoflegends.com/cdn/img/${icon}" loading="lazy" onerror="this.style.display='none'">`;
  }

  function srBlock(ddragon, spell1Id, spell2Id, keystoneId, subStyleId, spellMap, runeIdToIcon) {
    return `
      <div class="sr-box">
        <div class="sr-col">
          ${spellIcon(ddragon, spell1Id, spellMap)}
          ${spellIcon(ddragon, spell2Id, spellMap)}
        </div>
        <div class="sr-col">
          ${runeIcon(runeIdToIcon, keystoneId)}
          ${runeIcon(runeIdToIcon, subStyleId)}
        </div>
      </div>
    `;
  }

  function itemsBlock(ddragon, items) {
    const base = `https://ddragon.leagueoflegends.com/cdn/${ddragon}/img/item/`;
    const arr = Array.isArray(items) ? items : [];
    return `
      <div class="items">
        ${Array.from({ length: 7 })
        .map((_, i) => {
          const id = Number(arr[i] || 0);
          if (!id) return `<div class="item-slot"></div>`;
          return `<div class="item-slot"><img src="${base}${id}.png" loading="lazy" onerror="this.style.display='none'"></div>`;
        })
        .join("")}
      </div>
    `;
  }

  // ★ チャンピオン名の正規化
  // - Match-V5 で championName が "FiddleSticks" のように揺れるケースがある
  // - DataDragon の画像ファイル名は champion.json の "id" が正（例："Fiddlesticks.png"）
  //   → 小文字で突き合わせて「正式表記」に寄せる
  async function getChampionMaps(ddragon) {
    const storageKey = `dd_champ_${ddragon}`;

    const cached = readCache(storageKey);
    if (cached?.byKey && cached?.byLower) return cached;

    const json = await fetch(`https://ddragon.leagueoflegends.com/cdn/${ddragon}/data/ja_JP/champion.json`).then((r) =>
      r.json()
    );

    const byKey = {};   // "157" -> "Yasuo"（LIVE用）
    const byLower = {}; // "fiddlesticks" -> "Fiddlesticks"（履歴/展開用）

    const data = json?.data || {};
    for (const k of Object.keys(data)) {
      const c = data[k];
      if (c?.key && c?.id) byKey[String(c.key)] = c.id;
      if (c?.id) byLower[String(c.id).toLowerCase()] = c.id;
    }

    const out = { byKey, byLower };
    writeCache(storageKey, out);
    return out;
  }

  function champIdForDdragon(champMaps, championName) {
    const raw = String(championName || "").trim();
    if (!raw) return "";
    const key = raw.toLowerCase();
    return champMaps?.byLower?.[key] || raw;
  }

  // ===== ランク取得（LIVE 10人用：キャッシュ）=====
  const LIVE_RANK_CACHE = new Map();
  const LIVE_RANK_TTL = 10 * 60 * 1000;

  async function getRankedByPuuidCached(puuid) {
    if (!puuid) return null;

    const hit = LIVE_RANK_CACHE.get(puuid);
    if (hit && Date.now() - hit.ts < LIVE_RANK_TTL) return hit.data;

    try {
      const r = await fetch(`/api/ranked-by-puuid/${encodeURIComponent(puuid)}`);
      if (!r.ok) return null;
      const data = await r.json().catch(() => null);
      LIVE_RANK_CACHE.set(puuid, { ts: Date.now(), data });
      return data;
    } catch {
      return null;
    }
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

  function ensureMoreUI(matchesEl) {
    let wrap = matchesEl.querySelector("#moreWrap");
    if (!wrap) {
      wrap = document.createElement("div");
      wrap.id = "moreWrap";
      wrap.className = "more-wrap";
      wrap.innerHTML = `
        <button type="button" id="moreBtn" class="more-btn">もっと見る</button>
      `;
      matchesEl.appendChild(wrap);
    }
    const btn = wrap.querySelector("#moreBtn");
    return { wrap, btn };
  }

  // ===== summary =====
  function renderSummary(ddragon, sum) {
    if (!summary) return;

    const riotId = `${sum.name}#${sum.tag}`;
    const favOn = isFav(riotId);

    const longNameClass = isLongName(sum.name) ? " is-long-name" : "";

    summary.innerHTML = `
      <div class="summary-card">
        <img class="profile-icon" src="https://ddragon.leagueoflegends.com/cdn/${ddragon}/img/profileicon/${sum.iconId}.png" onerror="this.style.display='none'">

        <div class="summary-right">
          <div class="summary-head">
            <h2 class="summary-title${longNameClass}">${escapeHtml(sum.name)}#${escapeHtml(sum.tag)}</h2>
            <button type="button" class="fav-star ${favOn ? "is-on" : ""}" id="favStarBtn" aria-label="お気に入り"></button>
          </div>

          <div class="summary-sub">
            <span class="pill" id="rankSoloPill">Solo アンランク 0W0L 勝率0%</span>
            <span class="pill" id="rankFlexPill">Flex アンランク 0W0L 勝率0%</span>
          </div>
        </div>
      </div>
    `;

    const btn = document.getElementById("favStarBtn");
    if (btn) {
      btn.addEventListener("click", () => {
        const nowOn = !isFav(riotId);

        const entry = { riotId, name: sum.name, tag: sum.tag, badge: "" };
        const known =
          loadList(LS_RECENT).find((x) => sameRiotId(x.riotId, riotId)) ||
          loadList(LS_FAV).find((x) => sameRiotId(x.riotId, riotId)) ||
          entry;

        setFav(known, nowOn);
        btn.classList.toggle("is-on", nowOn);
        renderPanelLists();
      });
    }
  }

  function syncProfileStarIfSame(riotId) {
    const btn = document.getElementById("favStarBtn");
    if (!btn) return;
    const title = document.querySelector(".summary-title")?.textContent || "";
    if (sameRiotId(title.trim(), riotId.trim())) {
      btn.classList.toggle("is-on", isFav(riotId));
    }
  }

  function applyRankToSummary(ranked) {
    const solo = ranked?.solo || null;
    const flex = ranked?.flex || null;

    const soloP = document.getElementById("rankSoloPill");
    const flexP = document.getElementById("rankFlexPill");

    if (soloP) soloP.textContent = rankLine(solo, "Solo");
    if (flexP) flexP.textContent = rankLine(flex, "Flex");
  }

  // ===== side panel hosts（サイド全消ししない）=====
  function ensureSideHost(id) {
    if (!side) return null;

    let el = side.querySelector(`#${id}`);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      // 「先頭に差し込む」＝ firstChild の前に入れる
      side.insertBefore(el, side.firstChild);
    }
    return el;
  }

  function ensureSideRankHost() {
    return ensureSideHost("sideRankHost");
  }

  function ensureSideDuoHost() {
    // rankの下に置きたいので：rankHostの直後に挿入
    if (!side) return null;

    let duo = side.querySelector("#sideDuoHost");
    if (!duo) {
      duo = document.createElement("div");
      duo.id = "sideDuoHost";

      const rankHost = ensureSideRankHost();
      if (rankHost && rankHost.nextSibling) side.insertBefore(duo, rankHost.nextSibling);
      else if (rankHost) side.appendChild(duo);
      else side.insertBefore(duo, side.firstChild);
    }
    return duo;
  }

  // ===== side rank =====
  function sideMain(entry) {
    if (!entry?.tier) return "アンランク";
    const ts = tierShort(entry) || "—";
    const lp = Number(entry.leaguePoints || 0);
    return `${ts} ${lp}LP`;
  }

  function sideSub(entry) {
    if (!entry?.tier) return "0W0L 勝率0%";
    const w = Number(entry.wins || 0);
    const l = Number(entry.losses || 0);
    const wr = w + l > 0 ? Math.round((w / (w + l)) * 100) : 0;
    return `${w}W${l}L 勝率${wr}%`;
  }

  function tierIconSrc(entry) {
    const t = entry?.tier ? String(entry.tier).toLowerCase() : "unranked";
    return `/rank-icons/${t}.png`;
  }

  // ✅ side全体を上書きしない（rankHostだけ更新）
  function renderSidePanel(ranked) {
    const host = ensureSideRankHost();
    if (!host) return;

    const solo = ranked?.solo || null;
    const flex = ranked?.flex || null;

    const soloSrc = tierIconSrc(solo);
    const flexSrc = tierIconSrc(flex);

    // src が空のときは <img> を出さない（余計な表示/リクエスト防止）
    const soloEmblemHtml = soloSrc
      ? `<img class="rank-emblem" src="${soloSrc}" loading="lazy" decoding="async"
           onerror="this.style.display='none'">`
      : "";

    const flexEmblemHtml = flexSrc
      ? `<img class="rank-emblem" src="${flexSrc}" loading="lazy" decoding="async"
           onerror="this.style.display='none'">`
      : "";

    host.innerHTML = `
    <div class="side-card">
      <div class="side-title">RANK</div>

      <div class="rank-row">
        <div class="rank-emblem-box" aria-hidden="true">
          ${soloEmblemHtml}
        </div>

        <div class="rank-lines">
          <div class="rank-queue">Solo</div>
          <div class="rank-main">${escapeHtml(sideMain(solo))}</div>
          <div class="rank-sub">${escapeHtml(sideSub(solo))}</div>
        </div>
      </div>

      <div class="rank-row" style="margin-bottom:0;">
        <div class="rank-emblem-box" aria-hidden="true">
          ${flexEmblemHtml}
        </div>

        <div class="rank-lines">
          <div class="rank-queue">Flex</div>
          <div class="rank-main">${escapeHtml(sideMain(flex))}</div>
          <div class="rank-sub">${escapeHtml(sideSub(flex))}</div>
        </div>
      </div>
    </div>
  `;
  }

  // ===== duo（直近20戦で2回以上）=====
  function renderDuoPanel(ddragon, list) {
    const host = ensureSideDuoHost();
    if (!host) return;

    if (!list || list.length === 0) {
      host.innerHTML = `
        <div class="side-card">
          <div class="side-title">一緒にプレイしたサモナー（直近20戦）</div>
          <div class="sp-empty" style="padding:14px 6px;">該当なし（2回以上がいません）</div>
        </div>
      `;
      return;
    }

    const iconBase = `https://ddragon.leagueoflegends.com/cdn/${ddragon}/img/profileicon/`;

    host.innerHTML = `
      <div class="side-card">
        <div class="side-title">一緒にプレイしたサモナー（直近20戦）</div>

        <div class="duo-head" aria-hidden="true">
          <div class="duo-h-icon"></div>
          <div class="duo-h-name">サモナー</div>
          <div class="duo-h-games">ゲーム数</div>
          <div class="duo-h-wl">勝/敗</div>
          <div class="duo-h-wr">勝率</div>
        </div>

        ${list
        .map((x) => {
          const icon = x.iconId ? `${iconBase}${x.iconId}.png` : `${iconBase}1.png`;

          const riotIdFull = x.riotId || `${x.name}#${x.tag}`;
          const wr = x.games > 0 ? Math.round((x.wins / x.games) * 100) : 0;

          // 全角6文字以上なら1pxだけ小さく（見栄え優先）
          const zenkakuCount = (String(x.name).match(/[^\x00-\xff]/g) || []).length;
          const nameCls = zenkakuCount >= 6 ? "duo-name duo-name-small" : "duo-name";

          return `
  <a class="rank-row duo-row"
     href="/result.html?riotId=${encodeURIComponent(riotIdFull)}"
     style="text-decoration:none; color:inherit;">

    ${icon
              ? `<img class="rank-emblem duo-icon" src="${icon}" loading="lazy" onerror="this.style.display='none'">`
              : `<div class="rank-emblem duo-icon" aria-hidden="true"></div>`
            }

    <div class="${nameCls}" title="${escapeHtml(x.name)}">
      ${escapeHtml(x.name)}
    </div>

    <div class="duo-games">${x.games}</div>
    <div class="duo-wl">${x.wins}/${x.losses}</div>
    <div class="duo-wr">${wr}%</div>

  </a>
`;
        })
        .join("")}
      </div>
    `;
  } function renderDuoLoading() {
    const host = ensureSideDuoHost();
    if (!host) return;
    host.innerHTML = `
      <div class="side-card">
        <div class="side-title">一緒にプレイしたサモナー（直近20戦）</div>
        <div class="sp-empty" style="padding:14px 6px;">計算中…</div>
      </div>
    `;
  }

  async function computeDuoStats(token, ddragon, myPuuid, matchIds) {
    // ✅ サーバー側で集計（/api/with）
    // - アイコンはサモナーアイコン
    // - フロントで20試合×matchteamsを回さないので軽い
    renderDuoLoading();

    try {
      const r = await fetch(`/api/with/${encodeURIComponent(myPuuid)}?count=20&min=2`);
      const data = r.ok ? await r.json().catch(() => null) : null;

      if (token !== RUN_TOKEN) return;

      const list = Array.isArray(data?.players) ? data.players : [];
      const top = [...list].sort((a, b) => (b.games - a.games) || (b.wins - a.wins)).slice(0, 4);
      renderDuoPanel(ddragon, top);
    } catch (e) {
      console.error(e);
      if (token !== RUN_TOKEN) return;
      renderDuoPanel(ddragon, []);
    }
  }

  function preloadImages(urls) {
    const uniq = Array.from(new Set((urls || []).filter(Boolean)));
    return Promise.all(
      uniq.map(
        (u) =>
          new Promise((res) => {
            const img = new Image();
            img.onload = img.onerror = () => res();
            img.decoding = "async";
            img.loading = "eager";
            img.src = u;
          })
      )
    );
  }

  // ===== details teams（履歴展開：名前だけ）=====
  function renderTeamColumn(ddragon, champMaps, list, teamKey) {
    const champBase = `https://ddragon.leagueoflegends.com/cdn/${ddragon}/img/champion/`;

    const roleOrder = { TOP: 0, JG: 1, MID: 2, ADC: 3, SUP: 4, OTHER: 99 };
    const sorted = [...(list || [])].sort((a, b) => (roleOrder[a.role] ?? 99) - (roleOrder[b.role] ?? 99));

    const rows = sorted
      .map((p) => {
        const champId = champIdForDdragon(champMaps, p.championName);
        const champIcon = `${champBase}${champId}.png`;
        const riotId = p.name && p.tag ? `${p.name}#${p.tag}` : null;
        const displayName = p.anonymous ? STREAMER_LABEL : p.name ? escapeHtml(p.name) : "Unknown";

        const longNameClass = (!p.anonymous && p.name && isLongName(p.name)) ? " is-long-name" : "";

        const rowInner = `
          <img class="icon22" src="${champIcon}" loading="lazy" onerror="this.style.display='none'">
          <div class="team-name${longNameClass}">${displayName}</div>
        `;

        if (riotId && !p.anonymous) {
          return `<a class="team-row ${p.isMe ? "me" : ""}" href="/result.html?riotId=${encodeURIComponent(
            riotId
          )}" target="_blank" rel="noopener noreferrer">${rowInner}</a>`;
        }
        return `<div class="team-row ${p.isMe ? "me" : ""}">${rowInner}</div>`;
      })
      .join("");

    return `
      <div class="team-col ${teamKey}">
        <h4 class="team-title">${teamKey.toUpperCase()}</h4>
        ${rows}
      </div>
    `;
  }

  // ===== history card =====
  function renderHistoryCard(ddragon, spellMap, runeIdToIcon, champMaps, m, matchId, myPuuid) {
    const q = queueLabel(m.queueId, m.gameMode);
    const ago = formatAgo(m.gameEndMs);
    const duration = formatDuration(m.gameDuration || 0);

    const ratio =
      ((Number(m.kills || 0) + Number(m.assists || 0)) / Math.max(1, Number(m.deaths || 0))).toFixed(2);
    const csLine = m.csPerMin != null ? `${m.cs} (${Number(m.csPerMin).toFixed(1)})` : `${m.cs ?? 0}`;
    const kp = m.kp == null ? "0%" : `${Math.round(Number(m.kp) * 100)}%`;

    const champId = champIdForDdragon(champMaps, m.championName);
    const champIcon = `https://ddragon.leagueoflegends.com/cdn/${ddragon}/img/champion/${champId}.png`;
    const sr = srBlock(
      ddragon,
      m.spell1Id,
      m.spell2Id,
      m.perks?.perkIds?.[0] ?? null,
      m.perks?.perkSubStyle ?? null,
      spellMap,
      runeIdToIcon
    );
    const items = itemsBlock(ddragon, m.items || []);

    const card = document.createElement("div");
    const isRemake = !!m.remake;

    if (isRemake) card.className = "game-card remake";
    else card.className = `game-card ${m.win ? "win" : "lose"}`;

    const resultText = isRemake ? "リメイク" : m.win ? "勝利" : "敗北";

    card.innerHTML = `
      <div class="card-top">
        <div class="g-meta">
          <!-- ✅ 左メタ順序：ゲームモード → いつ → 勝敗 → ゲーム時間 -->
          <div class="g-queue">${escapeHtml(q)}</div>
          <div class="g-ago">${escapeHtml(ago)}</div>
          <div class="g-result">${escapeHtml(resultText)}</div>
          <div class="g-duration">${escapeHtml(duration)}</div>
        </div>

        <div class="g-main">
          <div class="champ-wrap">
            <div class="champ-icon-box">
              <img class="champ-icon" src="${champIcon}" loading="lazy" onerror="this.style.display='none'">
              <div class="champ-lv">${escapeHtml(m.champLevel)}</div>
            </div>
            <div class="sr">${sr}</div>
          </div>

          <div class="kda">
            <div class="kda-line">${escapeHtml(m.kills)}/${escapeHtml(m.deaths)}/${escapeHtml(m.assists)}</div>
            <div class="kda-sub">KDA${escapeHtml(ratio)}:1</div>
          </div>

          ${items}
        </div>

        <div class="g-stats">
          <div class="stat"><strong>KP</strong> ${escapeHtml(kp)}</div>
          <div class="stat"><strong>CS</strong> ${escapeHtml(csLine)}</div>
          <button class="chev" type="button" aria-expanded="false">▾</button>
        </div>
      </div>

      <div class="details" hidden></div>
    `;

    const btn = card.querySelector(".chev");
    const details = card.querySelector(".details");

    btn.addEventListener("click", async () => {
      const isOpen = !details.hasAttribute("hidden");
      if (isOpen) {
        details.setAttribute("hidden", "");
        btn.textContent = "▾";
        btn.setAttribute("aria-expanded", "false");
        return;
      }

      if (details.dataset.loaded === "1") {
        details.removeAttribute("hidden");
        btn.textContent = "▴";
        btn.setAttribute("aria-expanded", "true");
        return;
      }

      if (details.dataset.loading === "1") return;

      details.dataset.loading = "1";
      btn.disabled = true;

      try {
        const r = await fetch(`/api/matchteams/${encodeURIComponent(matchId)}/${encodeURIComponent(myPuuid)}`);
        const teams = await r.json().catch(() => null);
        if (!r.ok || !teams) throw new Error("team load failed");

        // 先読み（チャンプアイコンだけ）
        const champBase = `https://ddragon.leagueoflegends.com/cdn/${ddragon}/img/champion/`;
        const iconUrls = [...(teams.blue || []), ...(teams.red || [])].map((p) => {
          const champId = champIdForDdragon(champMaps, p.championName);
          return champId ? `${champBase}${champId}.png` : null;
        });

        // 先読み中に古い検索へ切替が起きても、描画はそのカード単位なのでOK
        await preloadImages(iconUrls);

        const html = `
  <div class="team-wrap">
    ${renderTeamColumn(ddragon, champMaps, teams.blue, "blue")}
    ${renderTeamColumn(ddragon, champMaps, teams.red, "red")}
  </div>
`;

        details.innerHTML = html;
        details.dataset.loaded = "1";

      } catch {
        details.innerHTML = `<div class="details-loading">通信エラー</div>`;
        details.dataset.loaded = "1";
      } finally {
        details.removeAttribute("hidden");
        btn.textContent = "▴";
        btn.setAttribute("aria-expanded", "true");

        btn.disabled = false;
        delete details.dataset.loading;
      }
    });

    return card;
  }

  // ===== Resultページ：検索〜描画 =====
  async function runSearch(riotIdRaw) {
    if (!isResultPage) return;

    const token = ++RUN_TOKEN;

    const riotId = String(riotIdRaw || "").trim();
    const parsed = parseRiotId(riotId);

    if (!parsed) {
      setStatus("サモナー名#タグ の形式で入力してください");
      return;
    }

    isSearching = true;
    setStatus("読み込み中…");

    const url = new URL(location.href);
    url.searchParams.set("riotId", riotId);
    history.replaceState(null, "", url.toString());

    summary.innerHTML = "";
    matches.innerHTML = "";

    // ✅ side全消しはしない（duoが消える原因）
    const rankHost = ensureSideRankHost();
    const duoHost = ensureSideDuoHost();
    if (rankHost) rankHost.innerHTML = "";
    if (duoHost) duoHost.innerHTML = "";


    syncMobileOrder();
    try {
      const ddragon = await getLatestDdragonVersionCached();
      const [spellMap, runeIdToIcon, champMaps] = await Promise.all([
        getSpellKeyToImgMap(ddragon),
        getRuneIdToIconMap(ddragon),
        getChampionMaps(ddragon),
      ]);

      // Summary
      const sumRes = await fetch(`/api/summary/${encodeURIComponent(parsed.name)}/${encodeURIComponent(parsed.tag)}`);
      const sum = await sumRes.json().catch(() => null);
      if (!sumRes.ok || !sum?.puuid) {
        setStatus(sum?.error ? sum.error : "サモナー取得に失敗しました");
        return;
      }

      // 最近に追加（まずは badge無し）
      const riotIdNorm = `${sum.name}#${sum.tag}`;
      upsertRecent({ riotId: riotIdNorm, name: sum.name, tag: sum.tag, badge: "" });
      renderPanelLists();

      renderSummary(ddragon, sum);

      // Rank（取れれば反映）
      let rankedData = { solo: null, flex: null };

      if (sum.summonerId) {
        try {
          const rr = await fetch(`/api/ranked/${encodeURIComponent(sum.summonerId)}`);
          if (rr.ok) {
            const ranked = await rr.json().catch(() => null);
            if (ranked) rankedData = ranked;
          }
        } catch { }
      }

      if (!rankedData?.solo && !rankedData?.flex) {
        try {
          const rr2 = await fetch(`/api/ranked-by-puuid/${encodeURIComponent(sum.puuid)}`);
          if (rr2.ok) {
            const ranked2 = await rr2.json().catch(() => null);
            if (ranked2) rankedData = ranked2;
          }
        } catch { }
      }

      applyRankToSummary(rankedData);
      renderSidePanel(rankedData);

      // badgeを保存（最近/お気に入りの左のD4/E1）
      const badge = primaryBadgeFromRanked(rankedData);
      if (badge) updateBadgeEverywhere(riotIdNorm, badge);

      // ============================
      // ✅ LIVE：常にカードを表示
      // ============================
      const liveCard = document.createElement("div");
      liveCard.className = "game-card live";
      liveCard.innerHTML = `
        <div class="card-top">
          <div class="g-meta">
            <div class="g-queue">LIVE</div>
            <div class="g-ago js-live-status">確認中</div>
            <div class="g-result js-live-queue">-</div>
            <div class="g-duration js-live-duration">-</div>
          </div>

          <div class="g-main">
            <div class="kda">
              <div class="kda-line js-live-title">インゲーム</div>
              <div class="kda-sub js-live-sub">▾で再チェック / インゲームなら展開</div>
            </div>
          </div>

          <div class="g-stats">
            <div class="stat"><strong>経過</strong> <span class="js-live-elapsed">-</span></div>
            <div class="stat stat-blank" aria-hidden="true"></div>
            <button class="chev" type="button" aria-expanded="false">▾</button>
          </div>
        </div>

        <div class="details" hidden></div>
      `;

      matches.appendChild(liveCard);

      const elStatus = liveCard.querySelector(".js-live-status");
      const elQueue = liveCard.querySelector(".js-live-queue");
      const elDuration = liveCard.querySelector(".js-live-duration");
      const elElapsed = liveCard.querySelector(".js-live-elapsed");
      const elSub = liveCard.querySelector(".js-live-sub");
      const liveBtn = liveCard.querySelector(".chev");
      const liveDetails = liveCard.querySelector(".details");

      const champBase = `https://ddragon.leagueoflegends.com/cdn/${ddragon}/img/champion/`;

      const parseRiotIdFromLive = (riotIdStr) => {
        if (typeof riotIdStr !== "string" || !riotIdStr) return { name: null, tag: null };
        if (!riotIdStr.includes("#")) return { name: riotIdStr, tag: null };
        const [name, tag] = riotIdStr.split("#");
        return { name: name || null, tag: tag || null };
      };

      const labelFromQueue = (qid) => {
        const q = Number(qid);
        if (q === 420) return "Solo";
        if (q === 440) return "Flex";
        return "Rank";
      };

      const renderNotInGame = (label = "未進行") => {
        elStatus.textContent = label;
        elQueue.textContent = "-";
        elDuration.textContent = "-";
        elElapsed.textContent = "-";
        elSub.textContent = "▾で再チェック / インゲームなら展開";
      };

      const renderInGameHeader = (live) => {
        elStatus.textContent = "ゲーム中";
        elQueue.textContent = queueLabel(live.queueId, live.gameMode);
        const d = formatDuration(live.gameLength || 0);
        elDuration.textContent = d;
        elElapsed.textContent = d;
        elSub.textContent = "▾でチーム表示";
      };

      async function buildLiveDetailsHtml(live) {
        const people = live.participants || [];

        const need = people
          .map((p) => ({
            p,
            canRank: !!p.puuid && !!parseRiotIdFromLive(p.riotId).tag,
          }))
          .filter((x) => x.canRank);

        const ranks = await mapLimit(need, 3, async (x) => {
          const ranked = await getRankedByPuuidCached(x.p.puuid);
          return { puuid: x.p.puuid, ranked };
        });

        const rankByPuuid = new Map(ranks.map((x) => [x.puuid, x.ranked]));

        const rowHtml = (p) => {
          const champKey = champMaps?.byKey?.[String(p.championId)] || null;
          const champIcon = champKey ? `${champBase}${champKey}.png` : null;

          const { name, tag } = parseRiotIdFromLive(p.riotId);
          const anonymous = !(name && tag);

          const displayName = anonymous ? STREAMER_LABEL : escapeHtml(name);

          const longNameClass = (!anonymous && isLongName(name)) ? " is-long-name" : "";

          let rankText = "";
          if (!anonymous) {
            const ranked = rankByPuuid.get(p.puuid) || null;
            const label = labelFromQueue(live.queueId);
            const entry = label === "Flex" ? ranked?.flex : ranked?.solo;
            rankText = rankLine(entry, label).replace(/^(Solo|Flex)\s+/, "");
          }

          const inner = `
            ${champIcon
              ? `<img class="icon22" src="${champIcon}" loading="lazy" onerror="this.style.display='none'">`
              : `<span class="icon22"></span>`
            }
            <div class="team-name${longNameClass}">${displayName}</div>
            <div class="team-rank">${rankText ? escapeHtml(rankText) : ""}</div>
          `;

          const meClass = p.puuid === sum.puuid ? " me" : "";
          const cls = `team-row has-rank${meClass}`;

          if (!anonymous) {
            const riotIdFull = `${name}#${tag}`;
            return `<a class="${cls}" href="/result.html?riotId=${encodeURIComponent(
              riotIdFull
            )}" target="_blank" rel="noopener noreferrer">${inner}</a>`;
          }
          return `<div class="${cls}">${inner}</div>`;
        };

        const blue = people.filter((p) => Number(p.teamId) === 100);
        const red = people.filter((p) => Number(p.teamId) === 200);

        return `
          <div class="team-wrap">
            <div class="team-col blue">
              <h4 class="team-title">BLUE</h4>
              ${blue.map(rowHtml).join("")}
            </div>
            <div class="team-col red">
              <h4 class="team-title">RED</h4>
              ${red.map(rowHtml).join("")}
            </div>
          </div>
        `;
      }

      try {
        const liveRes0 = await fetch(`/api/live/${encodeURIComponent(sum.puuid)}`);
        const live0 = liveRes0.ok ? await liveRes0.json().catch(() => null) : null;
        if (live0?.inGame) renderInGameHeader(live0);
        else renderNotInGame();
      } catch {
        renderNotInGame("取得失敗");
      }

      liveBtn.addEventListener("click", async () => {
        const isOpen = !liveDetails.hasAttribute("hidden");
        if (isOpen) {
          liveDetails.setAttribute("hidden", "");
          liveBtn.textContent = "▾";
          liveBtn.setAttribute("aria-expanded", "false");
          return;
        }

        liveBtn.disabled = true;
        liveBtn.classList.add("is-loading");

        try {
          const liveRes = await fetch(`/api/live/${encodeURIComponent(sum.puuid)}`);
          const live = liveRes.ok ? await liveRes.json().catch(() => null) : null;

          if (live?.inGame) {
            renderInGameHeader(live);
            liveDetails.innerHTML = `<div class="details-loading">読み込み中…</div>`;
            liveDetails.innerHTML = await buildLiveDetailsHtml(live);
          } else {
            renderNotInGame();
            liveDetails.innerHTML = `<div class="details-loading">現在ゲーム中ではありません</div>`;
          }
        } catch {
          liveDetails.innerHTML = `<div class="details-loading">通信エラー（再チェック失敗）</div>`;
        } finally {
          liveDetails.removeAttribute("hidden");
          liveBtn.textContent = "▴";
          liveBtn.setAttribute("aria-expanded", "true");
          liveBtn.disabled = false;
        }
      });

      // ============================
      // 履歴ID取得（最大20件）
      // ============================
      setStatus("履歴取得中…");
      const listRes = await fetch(`/api/matches/${encodeURIComponent(sum.puuid)}`);
      const listJson = await listRes.json().catch(() => null);

      const allIds =
        Array.isArray(listJson?.data)
          ? listJson.data
          : Array.isArray(listJson?.matchIds)
            ? listJson.matchIds
            : Array.isArray(listJson)
              ? listJson
              : [];

      if (!allIds.length) {
        setStatus("履歴が取得できませんでした");
        return;
      }

      const MAX_HISTORY = 20;
      const PAGE_SIZE = 10;

      const historyIds = allIds.slice(0, MAX_HISTORY);

      // ✅ duo（直近20戦・2回以上）を別スレッド的に計算（重いので同時2本）
      // ※検索切替時は token で古い結果を捨てる
      computeDuoStats(token, ddragon, sum.puuid, historyIds);

      // ============================
      // 履歴カード：最初10件、もっと見るで+10件
      // ============================
      let cursor = 0;

      const { wrap: moreWrap, btn: moreBtn } = ensureMoreUI(matches);
      moreWrap.hidden = true;

      const appendNext = async () => {
        const batch = historyIds.slice(cursor, cursor + PAGE_SIZE);
        if (!batch.length) {
          moreWrap.hidden = true;
          return;
        }

        moreBtn.disabled = true;
        moreBtn.textContent = "読み込み中…";
        setStatus(`試合詳細取得中…（${cursor + 1}〜${cursor + batch.length} / ${historyIds.length}）`);

        try {
          const details = await mapLimit(batch, 3, async (matchId) => {
            const r = await fetch(`/api/match/${encodeURIComponent(matchId)}/${encodeURIComponent(sum.puuid)}`);
            if (!r.ok) return null;
            return await r.json().catch(() => null);
          });

          for (let i = 0; i < batch.length; i++) {
            const matchId = batch[i];
            const m = details[i];
            if (!m) continue;

            const card = renderHistoryCard(ddragon, spellMap, runeIdToIcon, champMaps, m, matchId, sum.puuid);
            matches.insertBefore(card, moreWrap);
          }

          cursor += batch.length;
        } catch (e) {
          console.error(e);
          setStatus("通信エラー（履歴取得）");
        } finally {
          if (cursor >= historyIds.length) {
            moreWrap.hidden = true;
          } else {
            moreWrap.hidden = false;
            moreBtn.disabled = false;
            moreBtn.textContent = `もっと見る（${cursor}/${historyIds.length}）`;
          }
          setStatus("");
        }
      };

      moreBtn.onclick = () => appendNext();

      await appendNext();

      moreWrap.hidden = !(historyIds.length > PAGE_SIZE && cursor < historyIds.length);
      if (!moreWrap.hidden) {
        moreBtn.disabled = false;
        moreBtn.textContent = `もっと見る（${cursor}/${historyIds.length}）`;
      }

      setStatus("");
    } catch (e) {
      console.error(e);
      setStatus("通信エラーが発生しました");
    } finally {
      isSearching = false;

      // 予約が入っているなら、ここでは何もしない（予約側のタイマーに任せる）
      if (pendingSearchRaw) return;

      // ボタンだけ復帰（文字は出さない）
      setSearchUIBusy(false);
    }
  }

  function onSearch() {
    const raw = riotIdInput.value;

    if (isResultPage) {
      requestSearch(raw);
      return;
    }

    const norm = normalizeRiotId(raw);
    if (!norm) {
      setStatus("サモナー名#タグ の形式で入力してください");
      return;
    }

    // 検索ページ側も連打を抑える（遷移を連続で起こさない）
    const now = Date.now();
    const remain = SEARCH_COOLDOWN_MS - (now - lastSearchAt);
    if (remain > 0) {
      // ここは「裏でブロックするだけ」（文字は出さない）
      return;
    }
    lastSearchAt = now;
    location.href = `/result.html?riotId=${encodeURIComponent(norm)}`;
  }

  riotIdInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      closePanel();
      onSearch();
    }
  });

  loadBtn.addEventListener("click", () => {
    closePanel();

    window.addEventListener("resize", syncMobileOrder, { passive: true });
    onSearch();
  });

  // ===== 初期動作 =====
  const params = new URLSearchParams(location.search);
  const riotIdFromUrl = params.get("riotId");

  if (!isResultPage && riotIdFromUrl) {
    location.replace(`/result.html?riotId=${encodeURIComponent(riotIdFromUrl)}`);
    return;
  }

  if (riotIdFromUrl) riotIdInput.value = riotIdFromUrl;

  if (isResultPage) {
    if (riotIdFromUrl) requestSearch(riotIdFromUrl);
    else setStatus("");
  } else {
    setStatus("");
  }
});