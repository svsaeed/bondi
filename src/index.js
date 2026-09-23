const SUITS = ["S", "H", "D", "C"];
const RANKS = ["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"];
const rankValue = (rank) => RANKS.indexOf(rank);
const uuid = () => crypto.randomUUID();

function makeDeck() {
  return SUITS.flatMap((suit) => RANKS.map((rank) => ({ suit, rank, id: suit + rank })));
}

function shuffle(cards) {
  for (let i = cards.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

function makeRoomCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  return code;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/api/create" && request.method === "POST") {
      for (let attempt = 0; attempt < 12; attempt++) {
        const code = makeRoomCode();
        const room = env.ROOMS.get(env.ROOMS.idFromName(code));
        const response = await room.fetch("https://bondi.internal/init", {
          method: "POST",
          body: JSON.stringify({ code })
        });
        const result = await response.json();
        if (result.created) return Response.json({ code });
      }
      return Response.json({ error: "Could not create a room. Please try again." }, { status: 500 });
    }

    const roomStatus = url.pathname.match(/^\/api\/room\/([A-Z0-9]+)$/i);
    if (roomStatus && request.method === "GET") {
      const code = roomStatus[1].toUpperCase();
      const room = env.ROOMS.get(env.ROOMS.idFromName(code));
      return room.fetch("https://bondi.internal/status");
    }

    const wsMatch = url.pathname.match(/^\/ws\/([A-Z0-9]+)$/i);
    if (wsMatch) {
      const code = wsMatch[1].toUpperCase();
      const room = env.ROOMS.get(env.ROOMS.idFromName(code));
      return room.fetch(request);
    }

    return env.ASSETS.fetch(request);
  }
};

export class BondiRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.game = null;
    this.code = null;
    this.loaded = false;
    this.clients = new Map();
  }

  async load() {
    if (this.loaded) return;
    this.code = (await this.state.storage.get("code")) || null;
    this.game = (await this.state.storage.get("game")) || null;
    this.loaded = true;
  }

  async save() {
    await this.state.storage.put({ code: this.code, game: this.game });
  }

  async fetch(request) {
    await this.load();
    const url = new URL(request.url);

    if (url.pathname === "/init" && request.method === "POST") {
      if (this.code) return Response.json({ created: false });
      const data = await request.json();
      this.code = String(data.code || "").toUpperCase();
      await this.save();
      return Response.json({ created: true });
    }

    if (url.pathname === "/status") {
      return Response.json({ exists: !!this.code, phase: this.game?.phase || "empty" });
    }

    if (!this.code) return new Response("Room not found", { status: 404 });
    if (request.headers.get("Upgrade") !== "websocket") return new Response("WebSocket required", { status: 426 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.clients.set(server, { playerId: null });
    server.addEventListener("message", (event) => this.onMessage(server, event.data));
    server.addEventListener("close", () => this.onClose(server));
    server.addEventListener("error", () => this.onClose(server));
    return new Response(null, { status: 101, webSocket: client });
  }

  send(socket, payload) {
    try { socket.send(JSON.stringify(payload)); } catch (_) {}
  }

  socketIsOpenFor(playerId) {
    for (const meta of this.clients.values()) if (meta.playerId === playerId) return true;
    return false;
  }

  publicStateFor(player) {
    if (!this.game) return null;
    return {
      code: this.code,
      phase: this.game.phase,
      gameNo: this.game.gameNo,
      hostId: this.game.hostId,
      turn: this.game.turn,
      leader: this.game.leader,
      ledSuit: this.game.ledSuit,
      trick: this.game.trick,
      message: this.game.message,
      myId: player?.id || null,
      myHand: player?.hand || [],
      players: this.game.players.map((p) => ({
        id: p.id,
        name: p.name,
        cardCount: p.hand.length,
        score: p.score,
        finish: p.finish,
        online: this.socketIsOpenFor(p.id)
      })),
      scores: this.game.scores,
      lastResolution: this.game.lastResolution || null,
      actionLockUntil: this.game.actionLockUntil || 0,
      direction: "anticlockwise",
      wholeHandOffer: this.wholeHandOfferFor(player)
    };
  }

  broadcast() {
    for (const [socket, meta] of this.clients) {
      const player = this.game?.players.find((p) => p.id === meta.playerId) || null;
      this.send(socket, { type: "state", state: this.publicStateFor(player) });
    }
  }

  async onClose(socket) {
    this.clients.delete(socket);
    this.broadcast();
  }

  async onMessage(socket, raw) {
    let action;
    try { action = JSON.parse(raw); } catch (_) { return; }

    if (action.type === "join") {
      await this.join(socket, action);
      return;
    }

    const playerId = this.clients.get(socket)?.playerId;
    const player = this.game?.players.find((p) => p.id === playerId);
    if (!player) return this.send(socket, { type: "error", message: "Join the room first." });

    if (action.type === "leave") {
      await this.leaveRoom(socket, player);
      return;
    }

    if (action.type === "start") {
      if ((this.game.actionLockUntil || 0) > Date.now()) return this.send(socket, { type: "error", message: "Wait for the bustle animation to finish." });
      if (playerId !== this.game.hostId) return this.send(socket, { type: "error", message: "Only the host can start a game." });
      if (!['lobby', 'between'].includes(this.game.phase)) return;
      if (this.game.players.length < 2) return this.send(socket, { type: "error", message: "At least 2 players are required." });
      const offline = this.game.players.filter((p) => !this.socketIsOpenFor(p.id));
      if (offline.length) return this.send(socket, { type: "error", message: `All players must be online before starting. Waiting for: ${offline.map((p) => p.name).join(", ")}.` });
      this.startGame();
      await this.save();
      this.broadcast();
      return;
    }

    if (action.type === "newMatch") {
      if ((this.game.actionLockUntil || 0) > Date.now()) return;
      if (playerId !== this.game.hostId || this.game.phase !== "matchover") return;
      this.resetMatch();
      await this.save();
      this.broadcast();
      return;
    }

    if (action.type === "takeHand") {
      await this.takeWholeHand(socket, player);
      return;
    }

    if (action.type === "play") {
      await this.playCard(socket, player, String(action.cardId || ""));
    }
  }

  async join(socket, action) {
    const name = String(action.name || "").trim().slice(0, 20);
    const token = String(action.token || "").trim();
    if (!name) return this.send(socket, { type: "error", message: "Enter your name." });

    if (!this.game) {
      this.game = {
        phase: "lobby",
        gameNo: 0,
        hostId: null,
        players: [],
        scores: [],
        turn: null,
        leader: null,
        ledSuit: null,
        trick: [],
        playSequence: 0,
        nextStarterId: null,
        message: "Waiting for players",
        lastResolution: null,
        actionLockUntil: 0
      };
    }

    let player = token ? this.game.players.find((p) => p.token === token) : null;

    if (!player) {
      if (this.game.phase !== "lobby") return this.send(socket, { type: "error", message: "This match has already started. Only existing players can reconnect." });
      if (this.game.players.length >= 10) return this.send(socket, { type: "error", message: "This room already has 10 players." });
      if (this.game.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) return this.send(socket, { type: "error", message: "That player name is already being used in this room." });

      player = {
        id: uuid(),
        token: token || uuid(),
        name,
        hand: [],
        score: 0,
        finish: null,
        lastCardSequence: null
      };
      this.game.players.push(player);
      if (!this.game.hostId) this.game.hostId = player.id;
      await this.save();
    }

    this.clients.get(socket).playerId = player.id;
    this.send(socket, { type: "joined", playerId: player.id, token: player.token, name: player.name });
    this.broadcast();
  }

  async leaveRoom(socket, player) {
    const g = this.game;
    const preserveSeat = g.phase === "playing" || g.phase === "between";

    // Hand host control to another player so an intentional departure cannot
    // block the room from starting the next game.
    if (g.hostId === player.id) {
      const replacement = g.players.find((p) => p.id !== player.id && this.socketIsOpenFor(p.id))
        || g.players.find((p) => p.id !== player.id)
        || null;
      g.hostId = replacement?.id || null;
    }

    if (!preserveSeat) {
      g.players = g.players.filter((p) => p.id !== player.id);
      if (g.players.length === 0) {
        g.hostId = null;
        g.message = "Waiting for players";
      } else {
        g.message = `${player.name} left the room.`;
      }
    } else {
      g.message = `${player.name} left the table. Their seat is reserved for reconnection.`;
    }

    await this.save();
    this.send(socket, { type: "left", preserveSeat });
    this.clients.delete(socket);
    try { socket.close(1000, "Left BONDI room"); } catch (_) {}
    this.broadcast();
  }

  resetMatch() {
    this.game.gameNo = 0;
    this.game.scores = [];
    this.game.turn = null;
    this.game.leader = null;
    this.game.ledSuit = null;
    this.game.trick = [];
    this.game.playSequence = 0;
    this.game.nextStarterId = null;
    this.game.message = "New 10-game match ready";
    this.game.lastResolution = null;
    this.game.actionLockUntil = 0;
    this.game.phase = "lobby";
    for (const p of this.game.players) {
      p.hand = [];
      p.score = 0;
      p.finish = null;
      p.lastCardSequence = null;
    }
  }

  startGame() {
    const g = this.game;
    g.gameNo += 1;
    g.phase = "playing";
    g.turn = null;
    g.leader = null;
    g.ledSuit = null;
    g.trick = [];
    g.playSequence = 0;
    g.lastResolution = null;
    g.actionLockUntil = 0;

    for (const p of g.players) {
      p.hand = [];
      p.finish = null;
      p.lastCardSequence = null;
    }

    const cards = shuffle(makeDeck());
    // Seats are stored clockwise by join order. Dealing proceeds one card at a
    // time anticlockwise, matching the direction of BONDI play.
    let step = 0;
    while (cards.length) {
      const seat = (g.players.length - (step % g.players.length)) % g.players.length;
      g.players[seat].hand.push(cards.shift());
      step += 1;
    }

    let starter;
    if (g.gameNo === 1) starter = g.players.find((p) => p.hand.some((c) => c.id === "SA"));
    else starter = g.players.find((p) => p.id === g.nextStarterId) || g.players[0];

    g.leader = starter.id;
    g.turn = starter.id;
    g.message = `${starter.name} starts Game ${g.gameNo}. Play proceeds anticlockwise. They may lead any card.`;
  }

  activePlayers() {
    return this.game.players.filter((p) => p.finish === null);
  }

  // Player seats are stored clockwise. BONDI play itself moves anticlockwise,
  // so the next turn is the previous seat in the stored array.
  nextActiveAfter(playerId) {
    const players = this.game.players;
    const start = players.findIndex((p) => p.id === playerId);
    if (start < 0) return null;
    for (let step = 1; step <= players.length; step++) {
      const p = players[(start - step + players.length) % players.length];
      if (p.finish === null) return p;
    }
    return null;
  }

  nextActiveClockwiseAfter(playerId) {
    const players = this.game.players;
    const start = players.findIndex((p) => p.id === playerId);
    if (start < 0) return null;
    for (let step = 1; step <= players.length; step++) {
      const p = players[(start + step) % players.length];
      if (p.finish === null) return p;
    }
    return null;
  }

  betweenTricksState() {
    const g = this.game;
    return g.phase === "playing" && !g.ledSuit && g.trick.length === 0;
  }

  wholeHandOfferFor(requester) {
    // The offer is included in state even during the short resolution pause so
    // the client can reveal it immediately when that pause expires. The server
    // still rejects the action until actionLockUntil has passed.
    if (!requester || requester.finish !== null || !this.betweenTricksState()) return null;
    // If target T has 1-5 cards, the immediately next active player
    // anticlockwise from T may take T's whole hand. From the requester's
    // viewpoint, that target is the immediately adjacent active player
    // clockwise. Finished players are skipped.
    const target = this.nextActiveClockwiseAfter(requester.id);
    if (!target || target.id === requester.id || target.finish !== null) return null;
    if (target.hand.length < 1 || target.hand.length > 5) return null;
    return { targetId: target.id, targetName: target.name, cardCount: target.hand.length };
  }

  hasLedSuit(player) {
    return !!this.game.ledSuit && player.hand.some((c) => c.suit === this.game.ledSuit);
  }

  winnerOfTrick() {
    const led = this.game.ledSuit;
    return this.game.trick
      .filter((entry) => entry.card.suit === led)
      .reduce((best, entry) => rankValue(entry.card.rank) > rankValue(best.card.rank) ? entry : best);
  }

  confirmZeroCardFinishers(exceptPlayerId = null) {
    const g = this.game;
    const zeroPlayers = g.players
      .filter((p) => p.finish === null && p.hand.length === 0 && p.id !== exceptPlayerId)
      .sort((a, b) => (a.lastCardSequence ?? Infinity) - (b.lastCardSequence ?? Infinity));

    for (const p of zeroPlayers) {
      p.finish = g.players.filter((x) => x.finish !== null).length + 1;
    }
  }

  async takeWholeHand(socket, requester) {
    const g = this.game;
    if (g.phase !== "playing") return this.send(socket, { type: "error", message: "The game is not currently being played." });
    if ((g.actionLockUntil || 0) > Date.now()) return this.send(socket, { type: "error", message: "Wait for the current table action to finish." });
    if (g.ledSuit || g.trick.length) return this.send(socket, { type: "error", message: "The whole-hand request is allowed only between tricks, before a new suit is led." });

    const offer = this.wholeHandOfferFor(requester);
    if (!offer) return this.send(socket, { type: "error", message: "No eligible 1-5 card whole hand is available to you right now." });
    const target = g.players.find((p) => p.id === offer.targetId);
    if (!target || target.finish !== null || target.hand.length < 1 || target.hand.length > 5) return this.send(socket, { type: "error", message: "That whole-hand request is no longer available." });

    const count = target.hand.length;
    requester.hand.push(...target.hand);
    target.hand = [];
    target.lastCardSequence = null;
    target.finish = g.players.filter((p) => p.finish !== null).length + 1;

    // If the player who was due to lead has just finished via the transfer,
    // pass the lead to the next active player anticlockwise.
    if (g.turn === target.id || g.leader === target.id) {
      const next = this.nextActiveAfter(target.id);
      g.turn = next?.id || null;
      g.leader = next?.id || null;
    }

    const at = Date.now();
    g.lastResolution = {
      type: "wholehand",
      requesterId: requester.id,
      requesterName: requester.name,
      targetId: target.id,
      targetName: target.name,
      cardCount: count,
      finish: target.finish,
      at
    };
    g.actionLockUntil = at + 1700;
    g.message = `Whole Hand — ${requester.name} takes all ${count} cards from ${target.name}. ${target.name} finishes #${target.finish}.`;

    this.finishGameIfNeeded();
    await this.save();
    this.broadcast();
  }

  async playCard(socket, player, cardId) {
    const g = this.game;
    if (g.phase !== "playing") return;
    if ((g.actionLockUntil || 0) > Date.now()) {
      return this.send(socket, { type: "error", message: "Wait a moment while the bustle is being resolved." });
    }
    if (g.turn !== player.id) return this.send(socket, { type: "error", message: "It is not your turn." });

    const index = player.hand.findIndex((c) => c.id === cardId);
    if (index < 0) return this.send(socket, { type: "error", message: "That card is not in your hand." });
    const card = player.hand[index];

    if (g.ledSuit && this.hasLedSuit(player) && card.suit !== g.ledSuit) {
      return this.send(socket, { type: "error", message: `You must follow ${g.ledSuit}.` });
    }

    if (!g.ledSuit) g.ledSuit = card.suit;

    player.hand.splice(index, 1);
    g.playSequence += 1;
    if (player.hand.length === 0) player.lastCardSequence = g.playSequence;
    g.trick.push({ playerId: player.id, playerName: player.name, card });

    const brokeSuit = card.suit !== g.ledSuit;
    if (brokeSuit) {
      this.resolveBrokenTrick(player);
      await this.save();
      this.broadcast();
      return;
    }

    const played = new Set(g.trick.map((entry) => entry.playerId));
    const everybodyPlayed = this.activePlayers().every((p) => played.has(p.id));
    if (everybodyPlayed) {
      this.resolveCompletedTrick();
      await this.save();
      this.broadcast();
      return;
    }

    let next = this.nextActiveAfter(player.id);
    while (next && played.has(next.id)) next = this.nextActiveAfter(next.id);
    if (next) g.turn = next.id;
    g.message = `${next?.name || "Next player"}'s turn`;
    g.lastResolution = null;
    g.actionLockUntil = 0;
    await this.save();
    this.broadcast();
  }

  resolveBrokenTrick(breaker) {
    const g = this.game;
    const winnerEntry = this.winnerOfTrick();
    const picker = g.players.find((p) => p.id === winnerEntry.playerId);
    const cards = g.trick.map((entry) => entry.card);
    const displayTrick = g.trick.map((entry) => ({ playerName: entry.playerName, card: entry.card }));

    picker.hand.push(...cards);
    picker.lastCardSequence = null;
    this.confirmZeroCardFinishers(picker.id);

    const resolutionAt = Date.now();
    g.lastResolution = {
      type: "pickup",
      breakerName: breaker.name,
      breakerCard: g.trick[g.trick.length - 1]?.card || null,
      breakerCardId: g.trick[g.trick.length - 1]?.card?.id || null,
      pickerName: picker.name,
      pickerId: picker.id,
      winnerCardId: winnerEntry.card.id,
      ledSuit: g.ledSuit,
      cardCount: cards.length,
      cards: displayTrick,
      at: resolutionAt
    };
    // Keep all played cards visible long enough for every player to clearly see
    // the off-suit break card before the next play is accepted.
    g.actionLockUntil = resolutionAt + 2600;
    g.message = `Bondi — ${breaker.name} broke suit. ${picker.name} had the highest card of the led suit and picks up all ${cards.length} cards.`;
    g.trick = [];
    g.ledSuit = null;

    if (this.finishGameIfNeeded()) return;
    g.leader = picker.id;
    g.turn = picker.id;
  }

  resolveCompletedTrick() {
    const g = this.game;
    const winnerEntry = this.winnerOfTrick();
    const winner = g.players.find((p) => p.id === winnerEntry.playerId);
    const displayTrick = g.trick.map((entry) => ({ playerName: entry.playerName, card: entry.card }));

    this.confirmZeroCardFinishers();
    const resolutionAt = Date.now();
    g.lastResolution = {
      type: "discard",
      winnerName: winner.name,
      winnerId: winner.id,
      winnerCardId: winnerEntry.card.id,
      ledSuit: g.ledSuit,
      cardCount: g.trick.length,
      cards: displayTrick,
      at: resolutionAt
    };
    // A shorter pause for a normal completed trick lets players see the
    // highest card before the bustle is visually discarded.
    g.actionLockUntil = resolutionAt + 1700;
    g.message = `Hingaifi — Everyone followed ${g.lastResolution.ledSuit}. ${g.lastResolution.cardCount} cards are discarded. ${winner.name} had the highest card and leads next.`;
    g.trick = [];
    g.ledSuit = null;

    if (this.finishGameIfNeeded()) return;

    if (winner.finish === null) {
      g.leader = winner.id;
      g.turn = winner.id;
    } else {
      const next = this.nextActiveAfter(winner.id);
      g.leader = next.id;
      g.turn = next.id;
    }
  }

  finishGameIfNeeded() {
    const g = this.game;
    const active = this.activePlayers();
    if (active.length > 1) return false;

    if (active.length === 1) active[0].finish = g.players.length;
    const order = [...g.players].sort((a, b) => a.finish - b.finish);
    const points = {};
    for (let i = 0; i < order.length; i++) {
      const pts = g.players.length - 1 - i;
      order[i].score += pts;
      points[order[i].id] = pts;
    }

    const bondi = order[order.length - 1];
    g.nextStarterId = bondi.id;
    g.scores.push({
      game: g.gameNo,
      points,
      order: order.map((p) => p.id),
      bondiId: bondi.id
    });
    g.turn = null;
    g.leader = null;
    g.ledSuit = null;
    g.trick = [];

    if (g.gameNo >= 10) {
      g.phase = "matchover";
      const maxScore = Math.max(...g.players.map((p) => p.score));
      const winners = g.players.filter((p) => p.score === maxScore).map((p) => p.name);
      g.message = winners.length > 1
        ? `Match complete. ${winners.join(" & ")} are tied on ${maxScore} points.`
        : `Match complete. ${winners[0]} has the highest total with ${maxScore} points.`;
    } else {
      g.phase = "between";
      g.message = `${bondi.name} is BONDI with 0 points and will lead Game ${g.gameNo + 1}. Play continues anticlockwise.`;
    }
    return true;
  }
}
