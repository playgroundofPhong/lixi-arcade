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
function parseLines(text) {
  return String(text || "")
    .split("\n")
    .map(s => s.trim())
    .filter(Boolean);
}
function pick(arr) {
  if (!arr || arr.length === 0) return "—";
  return arr[crypto.randomInt(arr.length)];
}
function safeText(s, maxLen) {
  s = String(s ?? "");
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
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

function newBjState() {
  return {
    deck: [],
    player: [],
    dealer: [],
    inRound: false,
    dealerHidden: true,
    turn: 1,
    lastOutcome: null,
    lastReward: "—"
  };
}
function bjSnapshot(s) {
  return {
    player: s.player,
    dealer: s.dealer,
    inRound: s.inRound,
    dealerHidden: s.dealerHidden,
    turn: s.turn,
    lastOutcome: s.lastOutcome,
    lastReward: s.lastReward
  };
}
function endBjRound(state, outcome, reward) {
  state.inRound = false;
  state.dealerHidden = false;
  state.lastOutcome = outcome;
  state.lastReward = reward ?? "—";
  state.turn = state.turn === 1 ? 2 : 1;
}

function defaultState() {
  return {
    tab: "wheel",

    wheelItems: `10,000₫
20,000₫
50,000₫
100,000₫
200,000₫
500,000₫
1,000,000₫
Nhân đôi
Thêm lượt`,
    wheelSpeed: 6,

    txWinRewards: `50,000₫
100,000₫
200,000₫
Trà sữa`,
    txLoseRewards: `10,000₫
20,000₫
Ôm 1 cái`,

    bjWinRewards: `100,000₫
200,000₫
500,000₫`,
    bjPushRewards: `50,000₫
Trà sữa`,
    bjLoseRewards: `10,000₫
20,000₫`,

    rlWinRewards: `100,000₫
200,000₫
500,000₫`,
    rlLoseRewards: `10,000₫
20,000₫`,

    txPick: { 1: "tai", 2: "xiu" },
    rlBet: {
      1: { betType: "red", betNumber: 7 },
      2: { betType: "black", betNumber: 7 }
    }
  };
}

const FIELD_RULES = {
  tab: v => ["wheel", "taixiu", "blackjack", "roulette"].includes(v) ? v : "wheel",

  wheelItems: v => safeText(v, 4000),
  wheelSpeed: v => clamp(v, 1, 10),

  txWinRewards: v => safeText(v, 4000),
  txLoseRewards: v => safeText(v, 4000),

  bjWinRewards: v => safeText(v, 4000),
  bjPushRewards: v => safeText(v, 4000),
  bjLoseRewards: v => safeText(v, 4000),

  rlWinRewards: v => safeText(v, 4000),
  rlLoseRewards: v => safeText(v, 4000),

  "txPick.1": v => (v === "tai" ? "tai" : "xiu"),
  "txPick.2": v => (v === "tai" ? "tai" : "xiu"),

  "rlBet.1.betType": v => ["red","black","odd","even","low","high","number"].includes(v) ? v : "red",
  "rlBet.2.betType": v => ["red","black","odd","even","low","high","number"].includes(v) ? v : "black",
  "rlBet.1.betNumber": v => clamp(v, 0, 36),
  "rlBet.2.betNumber": v => clamp(v, 0, 36)
};

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      players: new Map(),
      locks: new Map(),
      state: defaultState(),
      bj: newBjState()
    });
  }
  return rooms.get(roomId);
}

function allocPlayerId(room) {
  const used = new Set(room.players.values());
  if (!used.has(1)) return 1;
  if (!used.has(2)) return 2;
  return 0;
}

function broadcastPresence(roomId, room) {
  const ids = [...room.players.values()].filter(Boolean).sort((a,b)=>a-b);
  io.to(roomId).emit("presence", { players: ids });
}

function lockOwnerPid(room, field) {
  const ownerSocketId = room.locks.get(field);
  if (!ownerSocketId) return 0;
  return room.players.get(ownerSocketId) || 0;
}

function releaseLocksBySocket(room, socketId) {
  for (const [field, owner] of room.locks.entries()) {
    if (owner === socketId) room.locks.delete(field);
  }
}

function setByPath(obj, path, value) {
  const parts = path.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const k = parts[i];
    if (!(k in cur)) cur[k] = {};
    cur = cur[k];
  }
  cur[parts[parts.length - 1]] = value;
}

function getByPath(obj, path) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (!cur || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

io.on("connection", socket => {
  const roomId = safeText(socket.handshake.query.room || "demo", 32);
  const room = getRoom(roomId);

  const pid = allocPlayerId(room);
  room.players.set(socket.id, pid);

  socket.join(roomId);

  socket.emit("init", {
    room: roomId,
    playerId: pid,
    state: room.state,
    bj: bjSnapshot(room.bj),
    locks: Object.fromEntries([...room.locks.entries()].map(([f, sid]) => [f, room.players.get(sid) || 0]))
  });

  broadcastPresence(roomId, room);
  io.to(roomId).emit("lock:state", { locks: Object.fromEntries([...room.locks.entries()].map(([f, sid]) => [f, room.players.get(sid) || 0])) });

  socket.on("disconnect", () => {
    releaseLocksBySocket(room, socket.id);
    room.players.delete(socket.id);
    io.to(roomId).emit("lock:state", { locks: Object.fromEntries([...room.locks.entries()].map(([f, sid]) => [f, room.players.get(sid) || 0])) });
    broadcastPresence(roomId, room);
    if (room.players.size === 0) rooms.delete(roomId);
  });

  socket.on("state:set", payload => {
    const field = safeText(payload?.field || "", 64);
    if (!FIELD_RULES[field]) return;

    const lockedBy = lockOwnerPid(room, field);
    if (lockedBy && room.locks.get(field) !== socket.id) return;

    const value = FIELD_RULES[field](payload?.value);

    if (field.includes(".")) {
      setByPath(room.state, field, value);
    } else {
      room.state[field] = value;
    }

    socket.to(roomId).emit("state:set", { field, value, by: pid });
  });

  socket.on("lock:set", payload => {
    const field = safeText(payload?.field || "", 64);
    const locked = !!payload?.locked;
    if (!FIELD_RULES[field]) return;

    if (locked) {
      const curOwner = room.locks.get(field);
      if (!curOwner || curOwner === socket.id) {
        room.locks.set(field, socket.id);
      }
    } else {
      const curOwner = room.locks.get(field);
      if (curOwner === socket.id) room.locks.delete(field);
    }

    io.to(roomId).emit("lock:state", {
      locks: Object.fromEntries([...room.locks.entries()].map(([f, sid]) => [f, room.players.get(sid) || 0]))
    });
  });

  socket.on("ui:tab", payload => {
    const tab = FIELD_RULES.tab(String(payload?.tab || ""));
    const lockedBy = lockOwnerPid(room, "tab");
    if (lockedBy && room.locks.get("tab") !== socket.id) return;
    room.state.tab = tab;
    io.to(roomId).emit("ui:tab", { tab, by: pid });
    socket.to(roomId).emit("state:set", { field: "tab", value: tab, by: pid });
  });

  socket.on("wheel:spin", () => {
    const items = parseLines(room.state.wheelItems);
    const safeItems = items.length >= 2 ? items : ["10,000₫", "20,000₫"];
    const speed = clamp(room.state.wheelSpeed, 1, 10);
    const targetIndex = crypto.randomInt(safeItems.length);
    io.to(roomId).emit("wheel:spinResult", { items: safeItems, speed, targetIndex, by: pid });
  });

  socket.on("tx:roll", () => {
    const pickSide = (room.state.txPick?.[pid] === "tai") ? "tai" : "xiu";

    const winRewards = parseLines(room.state.txWinRewards);
    const loseRewards = parseLines(room.state.txLoseRewards);

    const d1 = crypto.randomInt(1, 7);
    const d2 = crypto.randomInt(1, 7);
    const d3 = crypto.randomInt(1, 7);
    const sum = d1 + d2 + d3;
    const out = sum >= 11 ? "tai" : "xiu";
    const win = out === pickSide;
    const reward = win ? pick(winRewards) : pick(loseRewards);

    io.to(roomId).emit("tx:result", { d1, d2, d3, sum, out, pick: pickSide, win, reward, by: pid });
  });

  socket.on("rl:spin", () => {
    const b = room.state.rlBet?.[pid] || { betType: "red", betNumber: 7 };
    const betType = ["red","black","odd","even","low","high","number"].includes(b.betType) ? b.betType : "red";
    const betNumber = clamp(b.betNumber, 0, 36);

    const winRewards = parseLines(room.state.rlWinRewards);
    const loseRewards = parseLines(room.state.rlLoseRewards);

    const rolled = crypto.randomInt(37);
    const win = rlBetWin(betType, betNumber, rolled);
    const reward = win ? pick(winRewards) : pick(loseRewards);

    io.to(roomId).emit("rl:result", { betType, betNumber, rolled, color: rlColor(rolled), win, reward, by: pid });
  });

  function mustBeTurnPlayer() {
    return pid !== 0 && pid === room.bj.turn;
  }

  socket.on("bj:new", () => {
    room.bj = newBjState();
    io.to(roomId).emit("bj:state", bjSnapshot(room.bj));
  });

  socket.on("bj:deal", () => {
    if (!mustBeTurnPlayer()) return;

    const state = room.bj;
    state.deck = shuffle(buildDeck());
    state.player = [state.deck.pop(), state.deck.pop()];
    state.dealer = [state.deck.pop(), state.deck.pop()];
    state.inRound = true;
    state.dealerHidden = true;
    state.lastOutcome = null;
    state.lastReward = "—";

    const winRewards = parseLines(room.state.bjWinRewards);
    const pushRewards = parseLines(room.state.bjPushRewards);
    const loseRewards = parseLines(room.state.bjLoseRewards);

    const pBJ = isBlackjack(state.player);
    const dBJ = isBlackjack(state.dealer);
    if (pBJ || dBJ) {
      const outcome = pBJ && dBJ ? "push" : (pBJ ? "win" : "lose");
      const reward = outcome === "win" ? pick(winRewards) : outcome === "push" ? pick(pushRewards) : pick(loseRewards);
      endBjRound(state, outcome, reward);
    }

    io.to(roomId).emit("bj:state", bjSnapshot(state));
  });

  socket.on("bj:hit", () => {
    if (!mustBeTurnPlayer()) return;
    const state = room.bj;
    if (!state.inRound) return;

    state.player.push(state.deck.pop());

    const loseRewards = parseLines(room.state.bjLoseRewards);

    if (handValue(state.player) > 21) {
      state.dealerHidden = false;
      dealerPlay(state);
      endBjRound(state, "lose", pick(loseRewards));
    }

    io.to(roomId).emit("bj:state", bjSnapshot(state));
  });

  socket.on("bj:stand", () => {
    if (!mustBeTurnPlayer()) return;
    const state = room.bj;
    if (!state.inRound) return;

    state.dealerHidden = false;
    dealerPlay(state);

    const p = handValue(state.player);
    const d = handValue(state.dealer);

    const winRewards = parseLines(room.state.bjWinRewards);
    const pushRewards = parseLines(room.state.bjPushRewards);
    const loseRewards = parseLines(room.state.bjLoseRewards);

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
