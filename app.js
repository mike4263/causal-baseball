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
  history: []
};

for (const side of ["away","home"]) {
  for (let i=1;i<=11;i++) state.teams[side].lineup.push({name:"", pos:"", ab:0, r:0, h:0, rbi:0});
}

const $ = (id)=>document.getElementById(id);
const API_BASE = "https://statsapi.mlb.com/api/v1";
const STORAGE_KEY = "cbs_state";

function saveToStorage(){
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch(_){}
}

function loadFromStorage(){
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    Object.assign(state, JSON.parse(raw));
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
  for (let i=0; i<11; i++) {
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
    bases: state.bases, teams: state.teams, log: state.log, gameMeta: state.gameMeta
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
    advanceBatter();
  } else if (type === "walk") {
    advanceRunners(1);
    detail = `${batterLabel()} ${play}`;
    advanceBatter();
  } else if (type === "out") {
    batter.ab++;
    detail = `${batterLabel()} ${play}`;
    advanceBatter();
    addOuts(1);
  } else if (type === "doubleplay") {
    batter.ab++;
    detail = `${batterLabel()} DP`;
    advanceBatter();
    addOuts(2);
  } else if (type === "reach") {
    if (play === "E") otherTeam().errors++;
    batter.ab++;
    state.bases[1] = true;
    detail = `${batterLabel()} ${play}`;
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
      <input placeholder="Pos" value="${escapeAttr(p.pos)}" data-i="${i}" data-field="pos" />
      <div class="stat">${p.h}-${p.ab}<br>${p.rbi} RBI</div>`;
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

function renderBoxScore(){
  const tbody = $("boxScore").querySelector("tbody");
  tbody.innerHTML = "";
  for (const key of ["away","home"]) {
    const team = state.teams[key];
    const t = totals(team);
    const tr = document.createElement("tr");
    const inn = team.runs.map(r=>`<td>${r || ""}</td>`).join("");
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
  const at = totals(state.teams.away);
  const ht = totals(state.teams.home);
  $("awayRunsTop").textContent = at.r;
  $("homeRunsTop").textContent = ht.r;
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

// Setup event listeners
$("setupDate").value = todayLocalISO();
$("fetchGames").addEventListener("click", fetchGames);
$("skipSetup").addEventListener("click", ()=>$("setupScreen").classList.add("hidden"));
$("openSetup").addEventListener("click", ()=>$("setupScreen").classList.remove("hidden"));

function openFlyoutDialog(){ $("flyoutSelect").value = ""; $("flyoutDialog").classList.remove("hidden"); }
function closeFlyoutDialog(){ $("flyoutDialog").classList.add("hidden"); }

function scoreFlyout(pos){
  saveSnapshot();
  const play = `F${pos}`;
  const team = currentTeam();
  const batter = team.lineup[team.batter];
  const beforeHalf = `${state.half} ${state.inning}`;
  batter.ab++;
  state.log.unshift(`${beforeHalf}: ${batterLabel()} ${play}`);
  advanceBatter();
  addOuts(1);
  closeFlyoutDialog();
  render();
}

// Scoring event listeners
document.querySelectorAll(".play:not(#flyoutBtn)").forEach(btn=>btn.addEventListener("click", ()=>scorePlay(btn)));
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
$("addBall").addEventListener("click", ()=>{saveSnapshot(); state.balls=Math.min(state.balls+1,4); render();});
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
  localStorage.removeItem(STORAGE_KEY);
  location.reload();
});

const hasSavedGame = loadFromStorage();
render();
if (!hasSavedGame) fetchGames();
