const state = {
  inning: 1,
  half: "Top",
  batting: "away",
  outs: 0,
  balls: 0,
  strikes: 0,
  bases: {1:false,2:false,3:false},
  gameMeta: null,
  teams: {
    away: {name:"Opponent", id:null, runs:Array(9).fill(0), hits:0, errors:0, lob:0, batter:0, lineup:[]},
    home: {name:"Nationals", id:120, runs:Array(9).fill(0), hits:0, errors:0, lob:0, batter:0, lineup:[]}
  },
  log: [],
  history: [],
  scorecard: { away: [], home: [] }
};

for (const side of ["away","home"]) {
  for (let i=1;i<=9;i++) state.teams[side].lineup.push({name:"", pos:"", ab:0, r:0, h:0, rbi:0});
}

let pollTimer = null;

const $ = (id)=>document.getElementById(id);
const API_BASE = "https://statsapi.mlb.com/api/v1";
const STORAGE_KEY = "cbs_state";

const POS_TO_NUM = { P:1, C:2, "1B":3, "2B":4, "3B":5, SS:6, LF:7, CF:8, RF:9 };
const NUM_TO_ABBR = ["","P","C","1B","2B","3B","SS","LF","CF","RF"];

function posOptions(preselect = "", blankLabel = ""){
  const defense = otherTeam();
  const playerAtPos = {};
  defense.lineup.forEach(p => {
    const n = POS_TO_NUM[p.pos];
    if (n && p.name) playerAtPos[n] = p.name;
  });
  const opts = blankLabel ? [`<option value="">${blankLabel}</option>`] : [];
  for (let n = 1; n <= 9; n++){
    const abbr = NUM_TO_ABBR[n];
    const label = playerAtPos[n] ? `${n} – ${abbr} ${playerAtPos[n]}` : `${n} – ${abbr}`;
    opts.push(`<option value="${n}"${String(n)===String(preselect)?" selected":""}>${label}</option>`);
  }
  return opts.join("");
}

function saveToStorage(){
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(_){}
}

function loadFromStorage(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    Object.assign(state, JSON.parse(raw));
    for (const side of ["away","home"]) state.teams[side].lineup = state.teams[side].lineup.slice(0,9);
    if (!state.scorecard) state.scorecard = { away: [], home: [] };
    $("setupScreen").classList.add("hidden");
    return true;
  } catch(_){ return false; }
}

function todayLocalISO(){
  const d = new Date();
  const offset = d.getTimezoneOffset();
  const local = new Date(d.getTime() - offset * 60000);
  return local.toISOString().slice(0,10);
}

function setStatus(message, cls=""){
  const el = $("setupStatus");
  el.className = "setup-status" + (cls ? " " + cls : "");
  el.textContent = message;
}

async function fetchJson(url){
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed: ${res.status}`);
  return res.json();
}

function formatGameTime(iso){
  if (!iso) return "Time TBD";
  return new Date(iso).toLocaleString([], {weekday:"short", hour:"numeric", minute:"2-digit", month:"short", day:"numeric"});
}

async function fetchGames(){
  const date = $("setupDate").value || todayLocalISO();
  const teamId = $("setupTeam").value;
  $("gameList").innerHTML = "";
  setStatus("Looking up MLB games…");

  let url = `${API_BASE}/schedule?sportId=1&date=${encodeURIComponent(date)}&hydrate=probablePitcher(note)`;
  if (teamId) url += `&teamId=${encodeURIComponent(teamId)}`;

  try {
    const data = await fetchJson(url);
    const games = (data.dates || []).flatMap(d => d.games || []);
    if (!games.length) {
      setStatus("No games found for that date/team. Try All MLB games or a different date.", "error");
      return;
    }
    setStatus(`Found ${games.length} game${games.length === 1 ? "" : "s"}. Choose one to load lineups.`, "success");
    renderGameList(games);
  } catch (err) {
    setStatus(`Could not fetch games. Check your internet connection or try again. ${err.message}`, "error");
  }
}

function renderGameList(games){
  const list = $("gameList");
  list.innerHTML = "";
  games.forEach(game => {
    const away = game.teams.away.team;
    const home = game.teams.home.team;
    const awayProb = game.teams.away.probablePitcher?.fullName || "TBD";
    const homeProb = game.teams.home.probablePitcher?.fullName || "TBD";
    const venue = game.venue?.name || "Ballpark TBD";
    const status = game.status?.detailedState || "Scheduled";
    const card = document.createElement("div");
    card.className = "game-card";
    card.innerHTML = `
      <div>
        <h3>${away.name} @ ${home.name}</h3>
        <p><span class="badge">${formatGameTime(game.gameDate)}</span><span class="badge">${status}</span><span class="badge">${venue}</span></p>
        <p>Probable pitchers: ${away.abbreviation || away.name}: ${awayProb} • ${home.abbreviation || home.name}: ${homeProb}</p>
      </div>
      <button class="primary">Load Game</button>
    `;
    card.querySelector("button").addEventListener("click", () => loadGame(game));
    list.appendChild(card);
  });
}

function extractStartingLineup(teamBox){
  const players = teamBox?.players || {};
  const starters = Object.values(players)
    .filter(p => {
      const order = String(p.battingOrder || "");
      return /^[1-9]00$/.test(order);
    })
    .sort((a,b) => Number(a.battingOrder) - Number(b.battingOrder))
    .map(p => ({
      name: p.person?.fullName || "",
      pos: p.position?.abbreviation || "",
      ab: 0, r: 0, h: 0, rbi: 0
    }));

  // Fallback: sometimes the batting order is not populated, but batters are present.
  if (starters.length === 0 && Array.isArray(teamBox?.batters)) {
    return teamBox.batters.slice(0,9).map(id => {
      const p = players[`ID${id}`];
      return {
        name: p?.person?.fullName || "",
        pos: p?.position?.abbreviation || "",
        ab: 0, r: 0, h: 0, rbi: 0
      };
    }).filter(p => p.name);
  }
  return starters;
}

function applyLineup(side, lineup){
  const team = state.teams[side];
  for (let i=0; i<9; i++) {
    const player = lineup[i] || {name:"", pos:"", ab:0, r:0, h:0, rbi:0};
    team.lineup[i] = {...team.lineup[i], name: player.name, pos: player.pos, ab:0, r:0, h:0, rbi:0};
  }
}

async function loadGame(scheduleGame){
  setStatus("Loading game feed and starting lineups…");
  try {
    const gamePk = scheduleGame.gamePk;
    const feed = await fetchJson(`https://statsapi.mlb.com/api/v1.1/game/${gamePk}/feed/live`);
    const gameData = feed.gameData || {};
    const liveData = feed.liveData || {};
    // Schedule game is authoritative for visitor vs. home designation
    const schedAway = scheduleGame.teams.away.team;
    const schedHome = scheduleGame.teams.home.team;
    const venue = gameData.venue?.name || scheduleGame.venue?.name || "";
    const gameDate = gameData.datetime?.dateTime || scheduleGame.gameDate || "";
    const status = gameData.status?.detailedState || scheduleGame.status?.detailedState || "";

    state.teams.away.name = schedAway.name || "Opponent";
    state.teams.away.id = schedAway.id || null;
    state.teams.home.name = schedHome.name || "Home";
    state.teams.home.id = schedHome.id || null;

    // Match boxscore team slots to schedule home/away by team ID, not by label
    const boxTeams = liveData.boxscore?.teams || {};
    const boxSlots = [boxTeams.away, boxTeams.home].filter(Boolean);
    const findBox = (id) => boxSlots.find(t => t.team?.id === id) || boxSlots.find(t => !t.team?.id);
    const awayLineup = extractStartingLineup(findBox(schedAway.id));
    const homeLineup = extractStartingLineup(findBox(schedHome.id));

    if (awayLineup.length) applyLineup("away", awayLineup);
    if (homeLineup.length) applyLineup("home", homeLineup);

    state.gameMeta = {
      gamePk,
      venue,
      status,
      gameDate,
      awayProbable: scheduleGame.teams.away.probablePitcher?.fullName || "",
      homeProbable: scheduleGame.teams.home.probablePitcher?.fullName || "",
      lineupStatus: `${awayLineup.length ? "Away lineup loaded" : "Away lineup not posted"} • ${homeLineup.length ? "Home lineup loaded" : "Home lineup not posted"}`
    };

    $("awayName").value = state.teams.away.name;
    $("homeName").value = state.teams.home.name;

    state.batting = "away";
    state.half = "Top";
    setStatus(state.gameMeta.lineupStatus, awayLineup.length || homeLineup.length ? "success" : "error");
    render();
    startPolling();
    if (!awayLineup.length || !homeLineup.length) {
      alert("The game loaded, but one or both starting lineups were not posted yet. You can still enter players manually or reopen Game Setup later.");
    }
    $("setupScreen").classList.add("hidden");
  } catch (err) {
    setStatus(`Could not load the game feed. ${err.message}`, "error");
  }
}

function saveSnapshot(){
  state.history.push(JSON.stringify({
    inning: state.inning, half: state.half, batting: state.batting, outs: state.outs,
    balls: state.balls, strikes: state.strikes,
    bases: state.bases, teams: state.teams, log: state.log, gameMeta: state.gameMeta,
    scorecard: state.scorecard
  }));
  if (state.history.length > 100) state.history.shift();
}

function restoreSnapshot(){
  const snap = state.history.pop();
  if (!snap) return;
  const data = JSON.parse(snap);
  Object.assign(state, data);
  render();
}

function currentTeam(){ return state.teams[state.batting]; }
function otherTeam(){ return state.teams[state.batting === "away" ? "home" : "away"]; }
function currentInningIndex(){ return Math.min(state.inning-1, 8); }
function batterLabel(){
  const team = currentTeam();
  const p = team.lineup[team.batter];
  return `${team.name} #${team.batter+1}${p.name ? " — " + p.name : ""}`;
}

function addRun(side = state.batting, count = 1){
  const team = state.teams[side];
  team.runs[currentInningIndex()] += count;
  const p = currentTeam().lineup[currentTeam().batter];
  if (side === state.batting && p) p.r += count;
}

function advanceBatter(){
  const team = currentTeam();
  team.batter = (team.batter + 1) % 9;
  state.balls = 0;
  state.strikes = 0;
}

function recordPA(result, reached){
  state.scorecard[state.batting].push({
    slot: currentTeam().batter,
    inning: state.inning,
    result,
    reached
  });
}

function countLOB(){
  return Object.values(state.bases).filter(Boolean).length;
}

function clearBases(){ state.bases = {1:false,2:false,3:false}; }

function advanceRunners(bases){
  let runs = 0;
  const newBases = {1:false,2:false,3:false};
  if (bases >= 4) {
    runs += Object.values(state.bases).filter(Boolean).length + 1;
    clearBases();
    addRun(state.batting, runs);
    return {runs};
  }
  for (const b of [3,2,1]) {
    if (!state.bases[b]) continue;
    const dest = b + bases;
    if (dest >= 4) runs++;
    else newBases[dest] = true;
  }
  newBases[bases] = true;
  state.bases = newBases;
  addRun(state.batting, runs);
  return {runs};
}

function addOuts(n=1){
  state.outs += n;
  if (state.outs >= 3) endHalf();
}

function endHalf(){
  currentTeam().lob += countLOB();
  state.outs = 0;
  clearBases();
  if (state.half === "Top") {
    state.half = "Bottom";
    state.batting = "home";
  } else {
    state.half = "Top";
    state.batting = "away";
    state.inning += 1;
  }
}

function prevHalf(){
  saveSnapshot();
  if (state.half === "Bottom") {
    state.half = "Top";
    state.batting = "away";
  } else if (state.inning > 1) {
    state.inning -= 1;
    state.half = "Bottom";
    state.batting = "home";
  }
  render();
}

function scorePlay(btn){
  saveSnapshot();
  const play = btn.dataset.play;
  const type = btn.dataset.type;
  const bases = Number(btn.dataset.bases || 0);
  const team = currentTeam();
  const batter = team.lineup[team.batter];
  const beforeHalf = `${state.half} ${state.inning}`;
  let detail = "";

  if (type === "hit") {
    team.hits++;
    batter.h++;
    batter.ab++;
    const result = advanceRunners(bases);
    batter.rbi += result.runs;
    detail = `${batterLabel()} ${play}${result.runs ? `, ${result.runs} RBI` : ""}`;
    recordPA(play, Math.min(bases, 4));
    advanceBatter();
  } else if (type === "walk") {
    advanceRunners(1);
    detail = `${batterLabel()} ${play}`;
    recordPA(play, 1);
    advanceBatter();
  } else if (type === "out") {
    batter.ab++;
    detail = `${batterLabel()} ${play}`;
    recordPA(play, 0);
    advanceBatter();
    addOuts(1);
  } else if (type === "doubleplay") {
    batter.ab++;
    detail = `${batterLabel()} DP`;
    recordPA("DP", 0);
    advanceBatter();
    addOuts(2);
  } else if (type === "reach") {
    if (play === "E") otherTeam().errors++;
    batter.ab++;
    state.bases[1] = true;
    detail = `${batterLabel()} ${play}`;
    recordPA(play, 1);
    advanceBatter();
  } else {
    detail = `${batterLabel()} note: ${play}`;
  }

  state.log.unshift(`${beforeHalf}: ${detail}`);
  render();
}

function addCustom(){
  const text = $("customText").value.trim();
  if (!text) return;
  saveSnapshot();
  state.log.unshift(`${state.half} ${state.inning}: ${batterLabel()} — ${text}`);
  $("customText").value = "";
  render();
}

function renderCount(){
  [...$("ballsDots").children].forEach((dot, i) => dot.classList.toggle("active", i < state.balls));
  [...$("strikesDots").children].forEach((dot, i) => dot.classList.toggle("active", i < state.strikes));
}

function renderBases(){
  [1,2,3].forEach(b => {
    $(`base${b}`).classList.toggle("occupied", !!state.bases[b]);
    $(`seg${b}`).classList.toggle("active", !!state.bases[b]);
  });
}

function renderOuts(){
  [...$("outsDots").children].forEach((dot, i)=>dot.classList.toggle("active", i < state.outs));
}

function renderLineup(){
  const team = currentTeam();
  $("currentBatterLabel").textContent = batterLabel();
  $("awayToggle").textContent = state.teams.away.name || "Visitor";
  $("homeToggle").textContent = state.teams.home.name || "Home";
  $("awayToggle").classList.toggle("active", state.batting === "away");
  $("homeToggle").classList.toggle("active", state.batting === "home");
  const el = $("lineup");
  el.innerHTML = "";
  team.lineup.forEach((p, i)=>{
    const row = document.createElement("div");
    row.className = "player-row" + (i === team.batter ? " current" : "");
    row.innerHTML = `
      <span>${i+1}</span>
      <input placeholder="Player name" value="${escapeAttr(p.name)}" data-i="${i}" data-field="name" />
      <input placeholder="Pos" value="${escapeAttr(p.pos)}" data-i="${i}" data-field="pos" />`;
    el.appendChild(row);
  });
  el.querySelectorAll("input").forEach(input=>{
    input.addEventListener("input", e=>{
      const i = Number(e.target.dataset.i);
      const field = e.target.dataset.field;
      team.lineup[i][field] = e.target.value;
      renderTopNamesOnly();
    });
  });
}

function escapeAttr(s){
  return String(s || "").replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("<","&lt;");
}

function totals(team){
  return {
    r: team.runs.reduce((a,b)=>a+b,0),
    h: team.hits,
    e: team.errors,
    lob: team.lob
  };
}

function buildScorecardCell(pa){
  if (!pa) return `<div class="sc-cell"></div>`;
  const r = pa.reached;
  const s = (n) => r >= n ? " sc-active" : "";
  return `<div class="sc-cell">
    <svg viewBox="0 0 56 56" class="sc-svg">
      ${r >= 4 ? `<polygon points="28,51 51,28 28,5 5,28" class="sc-fill"/>` : ""}
      <polyline points="28,51 51,28 28,5 5,28 28,51" class="sc-outline"/>
      <line x1="28" y1="51" x2="51" y2="28" class="sc-seg${s(1)}"/>
      <line x1="51" y1="28" x2="28" y2="5"  class="sc-seg${s(2)}"/>
      <line x1="28" y1="5"  x2="5"  y2="28" class="sc-seg${s(3)}"/>
      <line x1="5"  y1="28" x2="28" y2="51" class="sc-seg${s(4)}"/>
      <text x="28" y="31" class="sc-result-text">${pa.result}</text>
    </svg>
  </div>`;
}

function renderScorecard(){
  const el = $("scorecardGrid");
  if (!el) return;
  const key = state.batting;
  const team = state.teams[key];
  const pas = state.scorecard[key] || [];

  const lookup = {};
  pas.forEach(pa => {
    if (!lookup[pa.slot]) lookup[pa.slot] = {};
    lookup[pa.slot][pa.inning] = pa;
  });

  const cols = Math.max(state.inning, 9);
  let html = `<div class="sc-grid" style="--sc-cols:${cols}">`;
  html += `<div class="sc-hdr sc-hdr-name"></div>`;
  for (let i = 1; i <= cols; i++) html += `<div class="sc-hdr">${i}</div>`;

  for (let slot = 0; slot < 9; slot++){
    const p = team.lineup[slot];
    const lastName = p.name ? p.name.split(" ").pop() : `#${slot+1}`;
    const current = slot === team.batter;
    html += `<div class="sc-name${current ? " sc-current" : ""}">${escapeAttr(lastName)}</div>`;
    for (let inn = 1; inn <= cols; inn++){
      html += buildScorecardCell(lookup[slot]?.[inn]);
    }
  }

  html += `</div>`;
  el.innerHTML = html;
}

function renderBoxScore(){
  const tbody = $("boxScore").querySelector("tbody");
  tbody.innerHTML = "";
  // half-inning index: Top of N = (N-1)*2, Bottom of N = (N-1)*2+1
  const halfIdx = (state.inning - 1) * 2 + (state.half === "Bottom" ? 1 : 0);
  for (const key of ["away","home"]) {
    const team = state.teams[key];
    const t = totals(team);
    const tr = document.createElement("tr");
    const inn = team.runs.map((r, i) => {
      // away done after top of inning i+1; home done after bottom of inning i+1
      const done = key === "away" ? halfIdx > i * 2 : halfIdx > i * 2 + 1;
      return `<td>${done ? r : ""}</td>`;
    }).join("");
    tr.innerHTML = `<td>${team.name}</td>${inn}<td>${t.r}</td><td>${t.h}</td><td>${t.e}</td><td>${t.lob}</td>`;
    tbody.appendChild(tr);
  }
}

function renderLog(){
  const log = $("playLog");
  log.innerHTML = "";
  state.log.forEach(item=>{
    const li = document.createElement("li");
    li.textContent = item;
    log.appendChild(li);
  });
}

function renderMeta(){
  const el = $("gameMeta");
  if (!state.gameMeta) {
    el.innerHTML = "<span>No MLB game loaded yet.</span>";
    return;
  }
  const m = state.gameMeta;
  el.innerHTML = `
    <span>${m.gameDate ? new Date(m.gameDate).toLocaleString([], {weekday:"short", month:"short", day:"numeric", hour:"numeric", minute:"2-digit"}) : "Date TBD"}</span>
    <span>${m.venue || "Ballpark TBD"}</span>
    <span>${m.status || "Status TBD"}</span>
    <span>${m.lineupStatus}</span>
    ${m.awayProbable || m.homeProbable ? `<span>Probables: ${m.awayProbable || "TBD"} vs ${m.homeProbable || "TBD"}</span>` : ""}
  `;
}

function renderTopNamesOnly(){
  $("awayName").value = state.teams.away.name;
  $("homeName").value = state.teams.home.name;
}

function render(){
  renderTopNamesOnly();
  $("inningNumber").textContent = state.inning;
  $("halfToggle").textContent = state.half;
  renderMeta();
  renderBases();
  renderOuts();
  renderCount();
  renderLineup();
  renderScorecard();
  renderBoxScore();
  renderLog();
  saveToStorage();
}

function downloadCsv(){
  const rows = [["Half/Inning","Play"], ...state.log.slice().reverse().map(x=>{
    const idx = x.indexOf(":");
    return [x.slice(0, idx), x.slice(idx+2)];
  })];
  const csv = rows.map(r=>r.map(v=>`"${String(v).replaceAll('"','""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], {type:"text/csv"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "baseball-play-log.csv";
  a.click();
}

async function goLive(){
  if (!state.gameMeta?.gamePk) {
    alert("No game loaded. Use Game Setup to load a game first.");
    return;
  }
  const btn = $("goLive");
  btn.disabled = true;
  btn.textContent = "Syncing…";
  try {
    const feed = await fetchJson(`https://statsapi.mlb.com/api/v1.1/game/${state.gameMeta.gamePk}/feed/live`);
    const linescore = feed.liveData?.linescore;
    const gameData  = feed.gameData || {};

    if (!linescore?.currentInning) {
      alert("No live data yet — game may not have started.");
      return;
    }

    saveSnapshot();

    // Per-inning runs + LOB from innings array
    let awayLob = 0, homeLob = 0;
    (linescore.innings || []).forEach(inn => {
      const idx = Math.min(inn.num - 1, 8);
      state.teams.away.runs[idx] = inn.away?.runs   ?? 0;
      state.teams.home.runs[idx] = inn.home?.runs   ?? 0;
      awayLob += inn.away?.leftOnBase || 0;
      homeLob += inn.home?.leftOnBase || 0;
    });

    // Team-level totals
    const lsAway = linescore.teams?.away || {};
    const lsHome = linescore.teams?.home || {};
    state.teams.away.hits   = lsAway.hits   ?? state.teams.away.hits;
    state.teams.away.errors = lsAway.errors ?? state.teams.away.errors;
    state.teams.away.lob    = awayLob;
    state.teams.home.hits   = lsHome.hits   ?? state.teams.home.hits;
    state.teams.home.errors = lsHome.errors ?? state.teams.home.errors;
    state.teams.home.lob    = homeLob;

    // Inning / half / count / outs
    state.inning  = linescore.currentInning;
    state.half    = linescore.inningHalf === "Bottom" ? "Bottom" : "Top";
    state.batting = state.half === "Top" ? "away" : "home";
    state.outs    = linescore.outs    || 0;
    state.balls   = Math.min(linescore.balls   || 0, 3);
    state.strikes = Math.min(linescore.strikes || 0, 2);

    // Bases
    const offense = linescore.offense || {};
    state.bases[1] = !!offense.first;
    state.bases[2] = !!offense.second;
    state.bases[3] = !!offense.third;

    // Advance to current batter if found in lineup by name
    if (offense.batter?.fullName) {
      const team = currentTeam();
      const idx  = team.lineup.findIndex(p => p.name === offense.batter.fullName);
      if (idx >= 0) team.batter = idx;
    }

    state.gameMeta.status = gameData.status?.detailedState || state.gameMeta.status;
    state.log.unshift(`[Go Live] Synced to ${state.half} ${state.inning} — ${state.gameMeta.status}`);
    render();
    startPolling();
  } catch(err) {
    alert(`Could not sync live data: ${err.message}`);
  } finally {
    btn.disabled = false;
    btn.textContent = "Advance to Real Time";
  }
}

function updatePollIndicator(active){
  const el = $("pollStatus");
  if (!el) return;
  el.hidden = !active;
}

function detectCurrentLineup(teamBox){
  const players = teamBox?.players || {};
  const slots = {};
  Object.values(players).forEach(p => {
    const order = Number(p.battingOrder || 0);
    if (!order) return;
    const slot = Math.floor(order / 100);
    if (slot < 1 || slot > 9) return;
    if (!slots[slot] || order > slots[slot].order){
      slots[slot] = { order, name: p.person?.fullName || "", pos: p.position?.abbreviation || "" };
    }
  });
  return slots;
}

async function pollForSubs(){
  if (!state.gameMeta?.gamePk){ stopPolling(); return; }
  try {
    const feed = await fetchJson(`https://statsapi.mlb.com/api/v1.1/game/${state.gameMeta.gamePk}/feed/live`);
    const status = feed.gameData?.status?.detailedState || "";
    if (status) state.gameMeta.status = status;
    if (status === "Final" || status === "Game Over"){ stopPolling(); return; }

    const boxTeams = feed.liveData?.boxscore?.teams || {};
    const boxSlots = [boxTeams.away, boxTeams.home].filter(Boolean);
    const findBox = id => boxSlots.find(t => t.team?.id === id) || boxSlots.find(t => !t.team?.id);

    let snapshotSaved = false;
    let anyChange = false;

    for (const key of ["away", "home"]){
      const box = findBox(state.teams[key].id);
      if (!box) continue;
      const apiSlots = detectCurrentLineup(box);
      const team = state.teams[key];

      for (let slot = 1; slot <= 9; slot++){
        const api = apiSlots[slot];
        if (!api?.name) continue;
        const current = team.lineup[slot - 1];
        if (api.name === current.name) continue;

        if (!snapshotSaved){ saveSnapshot(); snapshotSaved = true; }
        const oldName = current.name;
        team.lineup[slot - 1] = { name: api.name, pos: api.pos, ab: 0, r: 0, h: 0, rbi: 0 };
        anyChange = true;
        if (oldName){
          state.log.unshift(`${state.half} ${state.inning}: SUB — ${api.name}${api.pos ? " ("+api.pos+")" : ""} for ${oldName} [auto]`);
        }
      }
    }

    if (anyChange) render();
  } catch(_){}
}

function startPolling(){
  stopPolling();
  if (!state.gameMeta?.gamePk) return;
  updatePollIndicator(true);
  pollTimer = setInterval(pollForSubs, 30000);
}

function stopPolling(){
  if (pollTimer){ clearInterval(pollTimer); pollTimer = null; }
  updatePollIndicator(false);
}

// Setup event listeners
$("setupDate").value = todayLocalISO();
$("fetchGames").addEventListener("click", fetchGames);
$("skipSetup").addEventListener("click", ()=>$("setupScreen").classList.add("hidden"));
$("openSetup").addEventListener("click", ()=>$("setupScreen").classList.remove("hidden"));
$("goLive").addEventListener("click", goLive);

function openFlyoutDialog(){
  $("flyoutSelect").innerHTML = `<option value="">— or pick from list —</option>` + posOptions();
  $("flyoutDialog").classList.remove("hidden");
}
function closeFlyoutDialog(){ $("flyoutDialog").classList.add("hidden"); }

function scoreFlyout(pos){
  saveSnapshot();
  const play = `F${pos}`;
  const team = currentTeam();
  const batter = team.lineup[team.batter];
  const beforeHalf = `${state.half} ${state.inning}`;
  batter.ab++;
  recordPA(play, 0);
  state.log.unshift(`${beforeHalf}: ${batterLabel()} ${play}`);
  advanceBatter();
  addOuts(1);
  closeFlyoutDialog();
  render();
}

// Scoring event listeners
document.querySelectorAll(".play:not(#flyoutBtn):not(#groundoutBtn):not(#errorBtn)").forEach(btn=>btn.addEventListener("click", ()=>scorePlay(btn)));
function openGroundoutDialog(){
  $("groundoutFrom").innerHTML = posOptions("", "—");
  $("groundoutTo").innerHTML   = posOptions("3");
  $("groundoutPreview").textContent = "—";
  $("groundoutDialog").classList.remove("hidden");
}
function closeGroundoutDialog(){ $("groundoutDialog").classList.add("hidden"); }
function updateGroundoutPreview(){
  const f = $("groundoutFrom").value, t = $("groundoutTo").value;
  $("groundoutPreview").textContent = f && t ? `${f}-${t}` : f || t ? "—" : "—";
}
function scoreGroundout(){
  const from = $("groundoutFrom").value, to = $("groundoutTo").value;
  if (!from || !to) return;
  saveSnapshot();
  const team = currentTeam(), batter = team.lineup[team.batter];
  const beforeHalf = `${state.half} ${state.inning}`;
  batter.ab++;
  recordPA(`${from}-${to}`, 0);
  state.log.unshift(`${beforeHalf}: ${batterLabel()} ${from}-${to}`);
  advanceBatter();
  addOuts(1);
  closeGroundoutDialog();
  render();
}

function openErrorDialog(){
  $("errorPos").innerHTML = posOptions("", "— select fielder —");
  $("errorDialog").classList.remove("hidden");
}
function closeErrorDialog(){ $("errorDialog").classList.add("hidden"); }
function scoreError(){
  const pos = $("errorPos").value;
  if (!pos) return;
  saveSnapshot();
  const team = currentTeam(), batter = team.lineup[team.batter];
  const beforeHalf = `${state.half} ${state.inning}`;
  otherTeam().errors++;
  batter.ab++;
  state.bases[1] = true;
  recordPA(`E${pos}`, 1);
  state.log.unshift(`${beforeHalf}: ${batterLabel()} E${pos}`);
  advanceBatter();
  closeErrorDialog();
  render();
}

$("errorBtn").addEventListener("click", openErrorDialog);
$("errorCancel").addEventListener("click", closeErrorDialog);
$("errorDialog").addEventListener("click", e=>{ if(e.target===$("errorDialog")) closeErrorDialog(); });
$("errorPos").addEventListener("change", scoreError);

$("groundoutBtn").addEventListener("click", openGroundoutDialog);
$("groundoutCancel").addEventListener("click", closeGroundoutDialog);
$("groundoutDialog").addEventListener("click", e=>{ if(e.target===$("groundoutDialog")) closeGroundoutDialog(); });
$("groundoutFrom").addEventListener("change", updateGroundoutPreview);
$("groundoutTo").addEventListener("change",   updateGroundoutPreview);
$("groundoutRecord").addEventListener("click", scoreGroundout);

$("flyoutBtn").addEventListener("click", openFlyoutDialog);
$("flyoutCancel").addEventListener("click", closeFlyoutDialog);
$("flyoutDialog").addEventListener("click", e=>{ if (e.target === $("flyoutDialog")) closeFlyoutDialog(); });
document.querySelectorAll(".pos-btn").forEach(btn=>{
  btn.addEventListener("click", ()=>scoreFlyout(btn.dataset.pos));
});
$("flyoutSelect").addEventListener("change", ()=>{
  if ($("flyoutSelect").value) scoreFlyout($("flyoutSelect").value);
});
$("addCustom").addEventListener("click", addCustom);
$("customText").addEventListener("keydown", e=>{ if(e.key==="Enter") addCustom(); });
$("addOut").addEventListener("click", ()=>{saveSnapshot(); addOuts(1); render();});
$("clearOuts").addEventListener("click", ()=>{saveSnapshot(); state.outs=0; render();});
$("addBall").addEventListener("click", ()=>{saveSnapshot(); state.balls=Math.min(state.balls+1,3); render();});
$("addStrike").addEventListener("click", ()=>{saveSnapshot(); state.strikes=Math.min(state.strikes+1,3); render();});
$("clearCount").addEventListener("click", ()=>{saveSnapshot(); state.balls=0; state.strikes=0; render();});
$("clearBases").addEventListener("click", ()=>{saveSnapshot(); clearBases(); render();});
$("scoreRunner").addEventListener("click", ()=>{saveSnapshot(); addRun(); render();});
$("nextHalf").addEventListener("click", ()=>{saveSnapshot(); endHalf(); render();});
$("prevHalf").addEventListener("click", prevHalf);
$("undo").addEventListener("click", restoreSnapshot);
$("base1").addEventListener("click", ()=>{saveSnapshot(); state.bases[1]=!state.bases[1]; render();});
$("base2").addEventListener("click", ()=>{saveSnapshot(); state.bases[2]=!state.bases[2]; render();});
$("base3").addEventListener("click", ()=>{saveSnapshot(); state.bases[3]=!state.bases[3]; render();});
$("awayToggle").addEventListener("click", ()=>{state.batting="away"; state.half="Top"; render();});
$("homeToggle").addEventListener("click", ()=>{state.batting="home"; state.half="Bottom"; render();});
$("nextBatter").addEventListener("click", ()=>{saveSnapshot(); advanceBatter(); render();});
$("prevBatter").addEventListener("click", ()=>{saveSnapshot(); const t=currentTeam(); t.batter=(t.batter+8)%9; render();});
$("awayName").addEventListener("input", ()=>{ state.teams.away.name = $("awayName").value || "Opponent"; render(); });
$("homeName").addEventListener("input", ()=>{ state.teams.home.name = $("homeName").value || "Nationals"; render(); });
$("copyLog").addEventListener("click", async ()=>{
  await navigator.clipboard.writeText(state.log.slice().reverse().join("\n"));
  $("copyLog").textContent = "Copied!";
  setTimeout(()=>$("copyLog").textContent="Copy", 1000);
});
$("clearLog").addEventListener("click", ()=>{saveSnapshot(); state.log=[]; render();});
$("downloadCsv").addEventListener("click", downloadCsv);
$("resetGame").addEventListener("click", ()=>{
  if (!confirm("Reset the whole game?")) return;
  stopPolling();
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
});

const hasSavedGame = loadFromStorage();
render();
if (!hasSavedGame) fetchGames();
else startPolling();
