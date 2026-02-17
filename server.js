const express = require("express");
const http = require("http");
const path = require("path");
const crypto = require("crypto");
const { Server } = require("socket.io");

const app = express();
app.use(express.static(path.join(__dirname, "public")));

const server = http.createServer(app);
const io = new Server(server, { transports: ["websocket", "polling"] });

const PORT = process.env.PORT || 8080;

const rooms = new Map();

function clamp(n, a, b) {
  n = Number(n);
  if (!Number.isFinite(n)) return a;
  return Math.max(a, Math.min(b, n));
}
function safeLines(arr, maxLines, maxLen) {
  if (!Array.isArray(arr)) return [];
  return arr
    .map(x => String(x ?? "").trim())
    .filter(Boolean)
    .slice(0, maxLines)
    .map(s => (s.length > maxLen ? s.slice(0, maxLen) : s));
}
function pick(arr) {
  if (!arr || arr.length === 0) return "—";
  return arr[crypto.randomInt(arr.length)];
}

function newBjState() {
  return { deck: [], player: [], dealer: [], inRound: false, dealerHidden: true, turn: 1, lastOutcome: null, lastReward: "—" };
}
function bjSnapshot(s) {
  return { player: s.player, dealer: s.dealer, inRound: s.inRound, dealerHidden: s.dealerHidden, turn: s.turn, lastOutcome: s.lastOutcome, lastReward: s.lastReward };
}

const suits = ["♠","♥","♦","♣"];
const ranks = ["A","2","3","4","5","6","7","8","9","10","J","Q","K"];

function buildDeck() {
  const d = [];
  for (const s of suits) for (const r of ranks) d.push({ r, s });
  return d;
}
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}
function handValue(hand) {
  let total = 0;
  let aces = 0;
  for (const c of hand) {
    if (c.r === "A") { aces++; total += 11; }
    else if (c.r === "K" || c.r === "Q" || c.r === "J") total += 10;
    else total += Number(c.r);
  }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}
function isBlackjack(hand) {
  return hand.length === 2 && handValue(hand) === 21;
}
function dealerPlay(state) {
  while (handValue(state.dealer) < 17) state.dealer.push(state.deck.pop());
}
function endBjRound(state, outcome, reward) {
  state.inRound = false;
  state.dealerHidden = false;
  state.lastOutcome = outcome;
  state.lastReward = reward ?? "—";
  state.turn = state.turn === 1 ? 2 : 1;
}

const redNums = new Set([1,3,5,7,9,12,14,16,18,19,21,23,25,27,30,32,34,36]);
function rlColor(n) {
  if (n === 0) return "green";
  return redNums.has(n) ? "red" : "black";
}
function rlBetWin(betType, betNumber, rolled) {
  if (betType === "number") return rolled === betNumber;
  if (rolled === 0) return false;
  switch (betType) {
    case "red": return rlColor(rolled) === "red";
    case "black": return rlColor(rolled) === "black";
    case "odd": return rolled % 2 === 1;
    case "even": return rolled % 2 === 0;
    case "low": return rolled >= 1 && rolled <= 18;
    case "high": return rolled >= 19 && rolled <= 36;
    default: return false;
  }
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) rooms.set(roomId, { players: new Map(), bj: newBjState() });
  return rooms.get(roomId);
}
function allocPlayerId(room) {
  const used = new Set(room.players.values());
  if (!used.has(1)) return 1;
  if (!used.has(2)) return 2;
  return 0;
}
function playerIdOf(room, socketId) {
  return room.players.get(socketId) || 0;
}
function mustBeTurnPlayer(room, socketId) {
  const pid = playerIdOf(room, socketId);
  return pid !== 0 && pid === room.bj.turn;
}

io.on("connection", socket => {
  const roomId = String(socket.handshake.query.room || "demo").slice(0, 32);
  const room = getRoom(roomId);

  const pid = allocPlayerId(room);
  room.players.set(socket.id, pid);

  socket.join(roomId);
  socket.emit("init", { room: roomId, playerId: pid, bj: bjSnapshot(room.bj) });

  socket.on("disconnect", () => {
    room.players.delete(socket.id);
    if (room.players.size === 0) rooms.delete(roomId);
  });

  socket.on("wheel:spin", payload => {
    const items = safeLines(payload?.items, 80, 40);
    const speed = clamp(payload?.speed, 1, 10);
    const targetIndex = items.length ? crypto.randomInt(items.length) : 0;
    io.to(roomId).emit("wheel:spinResult", { items, speed, targetIndex, by: pid });
  });

  socket.on("tx:roll", payload => {
    const pickSide = payload?.pick === "tai" ? "tai" : "xiu";
    const winRewards = safeLines(payload?.winRewards, 80, 60);
    const loseRewards = safeLines(payload?.loseRewards, 80, 60);

    const d1 = crypto.randomInt(1, 7);
    const d2 = crypto.randomInt(1, 7);
    const d3 = crypto.randomInt(1, 7);
    const sum = d1 + d2 + d3;
    const out = sum >= 11 ? "tai" : "xiu";
    const win = out === pickSide;
    const reward = win ? pick(winRewards) : pick(loseRewards);

    io.to(roomId).emit("tx:result", { d1, d2, d3, sum, out, pick: pickSide, win, reward, by: pid });
  });

  socket.on("rl:spin", payload => {
    const betType = String(payload?.betType || "red");
    const betNumber = clamp(payload?.betNumber, 0, 36);
    const winRewards = safeLines(payload?.winRewards, 80, 60);
    const loseRewards = safeLines(payload?.loseRewards, 80, 60);

    const rolled = crypto.randomInt(37);
    const win = rlBetWin(betType, betNumber, rolled);
    const reward = win ? pick(winRewards) : pick(loseRewards);

    io.to(roomId).emit("rl:result", { betType, betNumber, rolled, color: rlColor(rolled), win, reward, by: pid });
  });

  socket.on("bj:new", () => {
    room.bj = newBjState();
    io.to(roomId).emit("bj:state", bjSnapshot(room.bj));
  });

  socket.on("bj:deal", payload => {
    if (!mustBeTurnPlayer(room, socket.id)) return;

    const state = room.bj;
    state.deck = shuffle(buildDeck());
    state.player = [state.deck.pop(), state.deck.pop()];
    state.dealer = [state.deck.pop(), state.deck.pop()];
    state.inRound = true;
    state.dealerHidden = true;
    state.lastOutcome = null;
    state.lastReward = "—";

    const winRewards = safeLines(payload?.winRewards, 80, 60);
    const pushRewards = safeLines(payload?.pushRewards, 80, 60);
    const loseRewards = safeLines(payload?.loseRewards, 80, 60);

    const pBJ = isBlackjack(state.player);
    const dBJ = isBlackjack(state.dealer);
    if (pBJ || dBJ) {
      const outcome = pBJ && dBJ ? "push" : (pBJ ? "win" : "lose");
      const reward = outcome === "win" ? pick(winRewards) : outcome === "push" ? pick(pushRewards) : pick(loseRewards);
      endBjRound(state, outcome, reward);
    }

    io.to(roomId).emit("bj:state", bjSnapshot(state));
  });

  socket.on("bj:hit", payload => {
    if (!mustBeTurnPlayer(room, socket.id)) return;
    const state = room.bj;
    if (!state.inRound) return;

    state.player.push(state.deck.pop());

    const loseRewards = safeLines(payload?.loseRewards, 80, 60);

    if (handValue(state.player) > 21) {
      state.dealerHidden = false;
      dealerPlay(state);
      endBjRound(state, "lose", pick(loseRewards));
    }

    io.to(roomId).emit("bj:state", bjSnapshot(state));
  });

  socket.on("bj:stand", payload => {
    if (!mustBeTurnPlayer(room, socket.id)) return;
    const state = room.bj;
    if (!state.inRound) return;

    state.dealerHidden = false;
    dealerPlay(state);

    const p = handValue(state.player);
    const d = handValue(state.dealer);

    const winRewards = safeLines(payload?.winRewards, 80, 60);
    const pushRewards = safeLines(payload?.pushRewards, 80, 60);
    const loseRewards = safeLines(payload?.loseRewards, 80, 60);

    let outcome = "push";
    if (d > 21) outcome = "win";
    else if (p > d) outcome = "win";
    else if (p < d) outcome = "lose";

    const reward = outcome === "win" ? pick(winRewards) : outcome === "push" ? pick(pushRewards) : pick(loseRewards);
    endBjRound(state, outcome, reward);

    io.to(roomId).emit("bj:state", bjSnapshot(state));
  });
});

server.listen(PORT, "0.0.0.0", () => {});
