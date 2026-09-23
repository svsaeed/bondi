const $ = (selector) => document.querySelector(selector);
const SYM = { S: "♠", H: "♥", D: "♦", C: "♣" };
const SUIT_ORDER = ["S", "H", "D", "C"];
const RANK_ORDER = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
let socket = null;
let state = null;
let roomCode = "";
let myToken = "";
let sortMode = "suit";
let presentationTimer = null;
let lastShownResultKey = "";

const roomFromUrl = new URL(location.href).searchParams.get("room");
if (roomFromUrl) {
  roomCode = roomFromUrl.toUpperCase();
  $("#roomInput").value = roomCode;
  const rememberedName = localStorage.getItem(`bondi_name_${roomCode}`);
  const rememberedToken = localStorage.getItem(`bondi_token_${roomCode}`);
  if (rememberedName) $("#nameInput").value = rememberedName;
  if (rememberedName && rememberedToken) setTimeout(() => joinRoom(roomCode, rememberedName), 100);
}

function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" }[ch]));
}
function cardText(card) { return `${card.rank}${SYM[card.suit]}`; }
function isRed(card) { return card.suit === "H" || card.suit === "D"; }
function lockedNow() { return Number(state?.actionLockUntil || 0) > Date.now(); }
function message(text, bad = false) {
  $("#joinMessage").textContent = text;
  $("#joinMessage").classList.toggle("danger", bad);
}

$("#createBtn").onclick = async () => {
  const name = $("#nameInput").value.trim();
  if (!name) return message("Enter your name first.", true);
  message("Creating room...");
  try {
    const response = await fetch("/api/create", { method: "POST" });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Could not create room");
    roomCode = data.code;
    history.replaceState(null, "", `/?room=${roomCode}`);
    joinRoom(roomCode, name);
  } catch (error) { message(error.message, true); }
};

$("#joinBtn").onclick = () => {
  const name = $("#nameInput").value.trim();
  const code = $("#roomInput").value.trim().toUpperCase();
  if (!name) return message("Enter your name.", true);
  if (code.length !== 5) return message("Enter the 5-character room code.", true);
  joinRoom(code, name);
};

async function joinRoom(code, name) {
  roomCode = code.toUpperCase();
  message("Checking room...");
  try {
    const check = await fetch(`/api/room/${roomCode}`);
    const info = await check.json();
    if (!info.exists) return message("Room not found.", true);
  } catch (_) { return message("Could not contact the BONDI server.", true); }

  if (socket) try { socket.close(); } catch (_) {}
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/ws/${roomCode}`);
  myToken = localStorage.getItem(`bondi_token_${roomCode}`) || "";

  socket.onopen = () => socket.send(JSON.stringify({ type: "join", name, token: myToken }));
  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "error") return alert(data.message);
    if (data.type === "joined") {
      myToken = data.token;
      localStorage.setItem(`bondi_token_${roomCode}`, data.token);
      localStorage.setItem(`bondi_name_${roomCode}`, data.name);
      history.replaceState(null, "", `/?room=${roomCode}`);
    }
    if (data.type === "left") {
      if (!data.preserveSeat) {
        localStorage.removeItem(`bondi_token_${roomCode}`);
        localStorage.removeItem(`bondi_name_${roomCode}`);
      }
      state = null;
      myToken = data.preserveSeat ? myToken : "";
      $("#gameScreen").classList.add("hidden");
      $("#joinScreen").classList.remove("hidden");
      $("#roomInput").value = roomCode;
      history.replaceState(null, "", "/");
      message(data.preserveSeat ? "You left the table. Your seat is reserved if you want to rejoin." : "You left the room.");
      return;
    }
    if (data.type === "state") {
      state = data.state;
      $("#joinScreen").classList.add("hidden");
      $("#gameScreen").classList.remove("hidden");
      render();
    }
  };
  socket.onclose = () => { if (state) $("#status").textContent = "Connection lost — refresh to reconnect"; };
  socket.onerror = () => message("Could not join the room.", true);
}

function opponentPosition(index, count) {
  if (count <= 1) return "left:50%;top:4%;";
  const t = index / (count - 1);
  // Index 0 is the next seat anticlockwise from the user. From the bottom
  // seat that appears on the right side of the table, then progresses across
  // the top toward the left.
  const x = 91 - (82 * t);
  const y = 7 + (22 * Math.abs(2 * t - 1));
  return `left:${x.toFixed(1)}%;top:${y.toFixed(1)}%;`;
}

function opponentsInAnticlockwiseOrder() {
  const players = state.players || [];
  const myIndex = players.findIndex((p) => p.id === state.myId);
  if (myIndex < 0) return players.filter((p) => p.id !== state.myId);
  const out = [];
  for (let step = 1; step < players.length; step++) {
    out.push(players[(myIndex - step + players.length) % players.length]);
  }
  return out;
}

function playerHTML(p, index, count) {
  const backs = Math.min(5, Math.max(0, p.cardCount));
  const offerTarget = !lockedNow() && state.wholeHandOffer?.targetId === p.id;
  return `<div class="player ${state.turn===p.id?"turn":""} ${p.finish?"finished":""} ${p.online?"":"offline"} ${offerTarget?"whole-hand-target":""}" style="${opponentPosition(index,count)}">
    <div class="avatar">${esc(p.name.charAt(0).toUpperCase())}<span>${p.cardCount}</span></div>
    <span class="player-name">${esc(p.name)}${p.finish?` ✓ #${p.finish}`:""}<i class="online-dot"></i></span>
    ${offerTarget ? `<span class="whole-hand-mini">WHOLE HAND • ${p.cardCount}</span>` : ""}
    ${p.finish || backs===0 ? "" : `<div class="opponent-fan" aria-hidden="true">${Array.from({length:backs},()=>'<i class="card-back"></i>').join("")}</div>`}
  </div>`;
}

function displayEntries() {
  const trick = state.trick || [];
  if (trick.length) return { entries: trick, mode: "live", resolution: null };
  const r = state.lastResolution;
  if (r?.cards?.length && (lockedNow() || Date.now() - r.at < 450)) return { entries: r.cards, mode: r.type, resolution: r };
  return { entries: [], mode: "empty", resolution: null };
}

function playedCardHTML(entry, index, resolution) {
  const card = entry.card;
  const breakId = resolution?.breakerCardId;
  const winnerId = resolution?.winnerCardId;
  const classes = ["played-card"];
  if (isRed(card)) classes.push("red");
  if (resolution) classes.push("resolution-card");
  if (breakId && card.id === breakId && index === resolution.cards.length - 1) classes.push("break-card");
  if (winnerId && card.id === winnerId) classes.push("winner-card");
  return `<div class="${classes.join(" ")}" title="${esc(entry.playerName)} played ${esc(cardText(card))}"><span>${cardText(card)}</span><small class="who">${esc(entry.playerName)}</small></div>`;
}

function render() {
  if (!state) return;
  clearTimeout(presentationTimer);
  $("#roomCode").textContent = roomCode;
  $("#gameNo").textContent = state.gameNo;
  $("#status").textContent = state.message || "";
  $("#ledSuit").textContent = state.ledSuit ? SYM[state.ledSuit] : (lockedNow() && state.lastResolution?.ledSuit ? SYM[state.lastResolution.ledSuit] : "—");

  const me = state.players.find((p) => p.id === state.myId);
  $("#myName").textContent = me?.name || "";
  $("#myCount").textContent = me?.cardCount ?? 0;
  $("#myBadge").classList.toggle("turn", state.turn === state.myId);

  const opponents = opponentsInAnticlockwiseOrder();
  $("#players").innerHTML = opponents.map((p,i) => playerHTML(p,i,opponents.length)).join("");

  const shown = displayEntries();
  const bustle = $("#bustle");
  bustle.classList.toggle("pickup-mode", shown.mode === "pickup");
  bustle.classList.toggle("discard-mode", shown.mode === "discard");
  bustle.innerHTML = shown.entries.length
    ? shown.entries.map((entry,i) => playedCardHTML(entry,i,shown.resolution)).join("")
    : `<span class="bustle-label">BUSTLE</span>`;

  renderResolution();
  renderWholeHandOffer();
  renderHand();
  renderScoreboard();
  renderHostActions();
  maybeShowResult();

  if (lockedNow()) {
    const wait = Math.max(60, Number(state.actionLockUntil) - Date.now() + 50);
    presentationTimer = setTimeout(render, wait);
  }
}

function renderResolution() {
  const box = $("#resolution");
  const r = state.lastResolution;
  if (!r || Date.now() - r.at > 9000) return box.classList.add("hidden");
  box.classList.remove("hidden", "bondi-event", "hingaifi-event", "wholehand-event");
  box.replaceChildren();

  const label = document.createElement("span");
  label.className = "event-label";
  const detail = document.createElement("span");

  if (r.type === "pickup") {
    box.classList.add("bondi-event");
    label.textContent = "BONDI";
    detail.textContent = r.pickerName || "";
  } else if (r.type === "wholehand") {
    box.classList.add("wholehand-event");
    label.textContent = "Whole Hand";
    detail.textContent = `${r.requesterName} takes all ${r.cardCount} remaining cards from ${r.targetName}. ${r.targetName} immediately finishes #${r.finish}.`;
  } else {
    box.classList.add("hingaifi-event");
    label.textContent = "HINGAIFI";
    detail.textContent = "";
  }

  box.append(label);
  if (detail.textContent) box.append(detail);
}

function renderWholeHandOffer() {
  const box = $("#wholeHandOffer");
  const offer = state.wholeHandOffer;
  if (!offer || state.phase !== "playing" || state.ledSuit || (state.trick || []).length || lockedNow()) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }
  box.classList.remove("hidden");
  box.innerHTML = `<span><b>Whole hand available:</b> ${esc(offer.targetName)} has ${offer.cardCount} card${offer.cardCount===1?"":"s"}.</span> <button id="takeWholeHandBtn">Take all ${offer.cardCount}</button>`;
  $("#takeWholeHandBtn").onclick = () => {
    if (!confirm(`Take all ${offer.cardCount} cards from ${offer.targetName}? ${offer.targetName} will finish immediately.`)) return;
    socket.send(JSON.stringify({ type: "takeHand" }));
  };
}

function sortedHand() {
  const cards = [...(state.myHand || [])];
  if (sortMode === "suit") cards.sort((a,b) => SUIT_ORDER.indexOf(a.suit)-SUIT_ORDER.indexOf(b.suit) || RANK_ORDER.indexOf(b.rank)-RANK_ORDER.indexOf(a.rank));
  else cards.sort((a,b) => RANK_ORDER.indexOf(b.rank)-RANK_ORDER.indexOf(a.rank) || SUIT_ORDER.indexOf(a.suit)-SUIT_ORDER.indexOf(b.suit));
  return cards;
}

function handCardHTML(card, index, count, disabled) {
  const spread = Math.min(26, 150 / Math.max(1,count-1));
  const rotation = count <= 1 ? 0 : -13 + (26 * index / (count - 1));
  const y = Math.abs(rotation) * 0.45;
  const suit = SYM[card.suit];
  return `<button class="hand-card ${isRed(card)?"red":""}" data-card="${esc(card.id)}" style="--fan-r:${rotation.toFixed(1)}deg;--fan-y:${y.toFixed(1)}px" ${disabled?"disabled":""} aria-label="${esc(card.rank)} ${esc(suit)}">
    <span class="tl">${esc(card.rank)}<br>${suit}</span><span class="suit-big">${suit}</span><span class="br">${esc(card.rank)}<br>${suit}</span>
  </button>`;
}

function renderHand() {
  const cards = sortedHand();
  const hasLed = state.ledSuit && cards.some((c) => c.suit === state.ledSuit);
  const lock = lockedNow();
  $("#hand").innerHTML = cards.map((card,i) => {
    const illegal = lock || state.phase !== "playing" || state.turn !== state.myId || (hasLed && card.suit !== state.ledSuit);
    return handCardHTML(card,i,cards.length,illegal);
  }).join("");
  document.querySelectorAll(".hand-card").forEach((button) => button.onclick = () => {
    if (lockedNow()) return;
    socket.send(JSON.stringify({ type: "play", cardId: button.dataset.card }));
  });

  let note = document.querySelector(".input-lock-note");
  if (lock) {
    if (!note) { note = document.createElement("div"); note.className = "input-lock-note"; document.querySelector(".my-zone").appendChild(note); }
    const left = Math.max(0, Number(state.actionLockUntil) - Date.now());
    if (state.lastResolution?.type === "pickup") note.textContent = `Showing suit break • next play in ${(left/1000).toFixed(1)}s`;
    else if (state.lastResolution?.type === "wholehand") note.textContent = `Completing whole-hand transfer • ${(left/1000).toFixed(1)}s`;
    else note.textContent = `Resolving bustle • ${(left/1000).toFixed(1)}s`;
  } else if (note) note.remove();
}

function renderScoreboard() {
  const games = state.scores || [];
  $("#scoreTable").innerHTML = `<tr><th>Player</th>${games.map((g)=>`<th>G${g.game}</th>`).join("")}<th>Total</th></tr>` +
    state.players.map((p) => `<tr><td>${esc(p.name)}</td>${games.map((g)=>`<td>${g.points[p.id] ?? ""}</td>`).join("")}<td><b>${p.score}</b></td></tr>`).join("");
}

function renderHostActions() {
  const host = $("#hostActions");
  if (lockedNow()) { host.innerHTML = `<span class="waiting">Completing table action…</span>`; return; }
  if (state.hostId !== state.myId) {
    host.innerHTML = state.phase === "lobby" ? `<span class="waiting">Waiting for host to start</span>` : "";
    return;
  }
  if (state.phase === "lobby") host.innerHTML = `<button id="startGameBtn">Start Game 1</button>`;
  else if (state.phase === "between") host.innerHTML = `<button id="startGameBtn">Start Game ${state.gameNo + 1}</button>`;
  else if (state.phase === "matchover") host.innerHTML = `<button id="newMatchBtn">New 10-game match</button>`;
  else host.innerHTML = "";
  const start = $("#startGameBtn"); if (start) start.onclick = () => socket.send(JSON.stringify({ type: "start" }));
  const reset = $("#newMatchBtn"); if (reset) reset.onclick = () => socket.send(JSON.stringify({ type: "newMatch" }));
}

function maybeShowResult() {
  if (lockedNow()) return;
  if (!["between", "matchover"].includes(state.phase) || !state.scores.length) return;
  const latest = state.scores[state.scores.length - 1];
  const key = `${state.phase}:${latest.game}`;
  if (lastShownResultKey === key) return;
  lastShownResultKey = key;
  const order = latest.order.map((id) => state.players.find((p) => p.id === id));
  $("#resultTitle").textContent = state.phase === "matchover" ? "10-Game Match Complete" : `Game ${latest.game} Result`;
  let html = `<table><tr><th>Place</th><th>Player</th><th>Points</th><th>Total</th></tr>${order.map((p,i)=>`<tr><td>${i+1}</td><td>${esc(p.name)}</td><td>${latest.points[p.id]}</td><td>${p.score}</td></tr>`).join("")}</table>`;
  if (state.phase === "between") {
    const bondi = state.players.find((p) => p.id === latest.bondiId);
    html += `<p class="gold"><b>${esc(bondi.name)}</b> is BONDI and starts Game ${state.gameNo + 1}.</p>`;
  } else {
    const max = Math.max(...state.players.map((p) => p.score));
    const winners = state.players.filter((p) => p.score === max).map((p) => esc(p.name));
    html += `<p class="gold">${winners.join(" & ")} ${winners.length>1?"are tied with":"has"} ${max} points.</p>`;
  }
  $("#resultBody").innerHTML = html;
  $("#resultModal").classList.remove("hidden");
}

$("#leaveBtn").onclick = () => {
  if (!socket || socket.readyState !== WebSocket.OPEN || !state) {
    state = null;
    $("#gameScreen").classList.add("hidden");
    $("#joinScreen").classList.remove("hidden");
    history.replaceState(null, "", "/");
    return;
  }
  const preserveSeat = state.phase === "playing" || state.phase === "between";
  const prompt = preserveSeat
    ? "Leave this table? Your seat will stay reserved so you can rejoin this match later."
    : "Leave this BONDI room?";
  if (!confirm(prompt)) return;
  socket.send(JSON.stringify({ type: "leave" }));
};

$("#rulesBtn").onclick = () => $("#rulesModal").classList.remove("hidden");
$("#rulesClose").onclick = () => $("#rulesModal").classList.add("hidden");
$("#resultClose").onclick = () => $("#resultModal").classList.add("hidden");
$("#sortBtn").onclick = () => { sortMode = sortMode === "suit" ? "rank" : "suit"; renderHand(); };
$("#shareBtn").onclick = async () => {
  const url = `${location.origin}/?room=${roomCode}`;
  const text = `Join my BONDI room ${roomCode}`;
  if (navigator.share) {
    try { await navigator.share({ title: "BONDI", text, url }); return; } catch (_) {}
  }
  try {
    await navigator.clipboard.writeText(`${text}: ${url}`);
    alert("Invite link copied.");
  } catch (_) {
    prompt("Copy this BONDI invite link:", `${text}: ${url}`);
  }
};
