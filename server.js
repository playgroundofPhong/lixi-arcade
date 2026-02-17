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

const START_BALANCE = 10000;   // chip demo
const MIN_BET = 10;
const MAX_BET = 500000;

function clampInt(n, a, b) {
  n = Math.floor(Number(n));
  if (!Number.isFinite(n)) return a;
  return Math.max(a, Math.min(b, n));
}
function safeText(s, maxLen) {
  s = String(s ?? "");
  if (s.length > maxLen) s = s.slice(0, maxLen);
  return s;
}
function allocPlayerId(room) {
  const used = new Set(room.players.values());
  if (!used.has(1)) return 1;
  if (!used.has(2)) return 2;
  return 0; // spectator
}
function broadcastPresence(roomId, room) {
  const ids = [...room.players.values()].filter(Boolean).sort((a, b) => a - b);
  io.to(roomId).emit("presence", { players: ids });
}
function ensureBalance(room, pid) {
  if (!room.balances[pid]) room.balances[pid] = START_BALANCE;
}
function canBet(room, pid, bet) {
  ensureBalance(room, pid);
  return bet >= MIN_BET && bet <= MAX_BET && room.balances[pid] >= bet;
}
function settle(room, pid, bet, payoutTotal) {
  // balance = balance - bet + payoutTotal
  ensureBalance(room, pid);
  room.balances[pid] = clampInt(room.balances[pid] - bet + payoutTotal, 0, 10_000_000_000);
  return room.balances[pid];
}
function roomSnapshot(room) {
  return {
    balances: room.balances,
    player: room.player,
    bj: bjSnapshot(room.bj),
    limits: { MIN_BET, MAX_BET, START_BALANCE }
  };
}

// ===== Wheel (bonus wheel / slot-like) =====
// "mult" là hệ số trả về TỔNG (return). Ví dụ mult=2 => trả 2x cược (lãi 1x).
// RTP ~ 97% với weights dưới đây (house edge nhẹ).
const WHEEL_SEGMENTS = [
  { label: "x0",   mult: 0.0,  weight: 0 },
  { label: "x0.5", mult: 0.5,  weight: 20 },
  { label: "x1",   mult: 1.0,  weight: 20 },
  { label: "x1.5",   mult: 1.5,  weight: 20 },
  { label: "x2",   mult: 2.0,  weight: 20  },
  { label: "x2.5",  mult: 2.5, weight: 20  }
];
const WHEEL_TOTAL_WEIGHT = WHEEL_SEGMENTS.reduce((a, s) => a + s.weight, 0);
function wheelPickIndex() {
  let r = crypto.randomInt(WHEEL_TOTAL_WEIGHT);
  for (let i = 0; i < WHEEL_SEGMENTS.length; i++) {
    r -= WHEEL_SEGMENTS[i].weight;
    if (r < 0) return i;
  }
  return 0;
}

// ===== Tai/Xiu (Sic Bo) =====
function rollDie() { return crypto.randomInt(1, 7); }
function isTriple(d1, d2, d3) { return d1 === d2 && d2 === d3; }
function txOutcome(sum) {
  // Big/Tai: 11–17, Small/Xiu: 4–10
  return (sum >= 11) ? "tai" : "xiu";
}

// ===== Roulette (European 0–36) =====
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
function rlPayoutTotal(betType, bet, win) {
  if (!win) return 0;
  if (betType === "number") return bet * 36; // 35:1 + stake
  return bet * 2; // even money 1:1 + stake
}

// ===== Blackjack =====
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
function newBjState() {
  return {
    deck: [],
    player: [],
    dealer: [],
    inRound: false,
    dealerHidden: true,
    turn: 1,
    wagerPid: 1,
    wager: 0,
    lastOutcome: null,
    lastProfit: 0
  };
}
function bjSnapshot(s) {
  return {
    player: s.player,
    dealer: s.dealer,
    inRound: s.inRound,
    dealerHidden: s.dealerHidden,
    turn: s.turn,
    wagerPid: s.wagerPid,
    wager: s.wager,
    lastOutcome: s.lastOutcome,
    lastProfit: s.lastProfit
  };
}
function endBjRound(room, outcome, bet, payoutTotal) {
  const state = room.bj;
  state.inRound = false;
  state.dealerHidden = false;
  state.lastOutcome = outcome;
  state.lastProfit = payoutTotal - bet; // lãi/lỗ
  state.wager = 0;

  // đổi lượt
  state.turn = (state.turn === 1) ? 2 : 1;
  state.wagerPid = state.turn;
}

function defaultPlayerState() {
  return {
    tab: "wheel",
    wheelBet: 100,
    txPick: "tai",
    txBet: 100,
    rlBetType: "red",
    rlNumber: 7,
    rlBet: 100,
    bjBet: 200
  };
}

function getRoom(roomId) {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      players: new Map(),
      balances: { 1: START_BALANCE, 2: START_BALANCE },
      player: { 1: defaultPlayerState(), 2: defaultPlayerState() },
      bj: newBjState(),
      cursors: { 1: null, 2: null }
    });
  }
  return rooms.get(roomId);
}

io.on("connection", socket => {
  const roomId = safeText(socket.handshake.query.room || "demo", 32);
  const room = getRoom(roomId);

  const pid = allocPlayerId(room);
  room.players.set(socket.id, pid);

  if (pid === 1 || pid === 2) {
    ensureBalance(room, pid);
    if (!room.player[pid]) room.player[pid] = defaultPlayerState();
  }

  socket.join(roomId);
  socket.emit("init", { room: roomId, playerId: pid, ...roomSnapshot(room) });

  broadcastPresence(roomId, room);
  io.to(roomId).emit("state:full", roomSnapshot(room));

  socket.on("disconnect", () => {
    room.players.delete(socket.id);
    broadcastPresence(roomId, room);
    if ([...room.players.values()].every(v => !v)) rooms.delete(roomId);
  });

  // ===== Cursor sync =====
  socket.on("cursor", data => {
    if (!(pid === 1 || pid === 2)) return;
    const x = Math.max(0, Math.min(1, Number(data?.x)));
    const y = Math.max(0, Math.min(1, Number(data?.y)));
    const tab = safeText(data?.tab || "", 16);
    room.cursors[pid] = { x, y, tab, ts: Date.now() };
    socket.to(roomId).emit("cursor", { by: pid, x, y, tab });
  });

  // ===== Player UI state (bets / picks / tab) =====
  socket.on("player:set", payload => {
    if (!(pid === 1 || pid === 2)) return;

    const key = safeText(payload?.key || "", 32);
    let value = payload?.value;

    const st = room.player[pid] || defaultPlayerState();

    switch (key) {
      case "tab":
        value = ["wheel","taixiu","blackjack","roulette"].includes(value) ? value : st.tab;
        st.tab = value;
        break;

      case "wheelBet":
      case "txBet":
      case "rlBet":
      case "bjBet":
        value = clampInt(value, MIN_BET, MAX_BET);
        st[key] = value;
        break;

      case "txPick":
        value = (value === "tai") ? "tai" : "xiu";
        st.txPick = value;
        break;

      case "rlBetType":
        value = ["red","black","odd","even","low","high","number"].includes(value) ? value : "red";
        st.rlBetType = value;
        break;

      case "rlNumber":
        value = clampInt(value, 0, 36);
        st.rlNumber = value;
        break;

      default:
        return;
    }

    room.player[pid] = st;
    io.to(roomId).emit("player:set", { by: pid, key, value });
  });

  // ===== Reset room (chỉ P1) =====
  socket.on("room:reset", () => {
    if (pid !== 1) return;
    room.balances = { 1: START_BALANCE, 2: START_BALANCE };
    room.player = { 1: defaultPlayerState(), 2: defaultPlayerState() };
    room.bj = newBjState();
    io.to(roomId).emit("room:reset", roomSnapshot(room));
  });

  // ===== Wheel spin =====
  socket.on("wheel:spin", () => {
    if (!(pid === 1 || pid === 2)) return;

    const bet = clampInt(room.player[pid]?.wheelBet ?? 0, MIN_BET, MAX_BET);
    if (!canBet(room, pid, bet)) {
      socket.emit("error:msg", { msg: "Không đủ chip hoặc cược ngoài giới hạn." });
      return;
    }

    const idx = wheelPickIndex();
    const seg = WHEEL_SEGMENTS[idx];
    const payoutTotal = Math.floor(bet * seg.mult);
    const newBal = settle(room, pid, bet, payoutTotal);
    const profit = payoutTotal - bet;

    io.to(roomId).emit("wheel:result", {
      by: pid,
      bet,
      segmentIndex: idx,
      segment: seg,
      payoutTotal,
      profit,
      balances: room.balances
    });
  });

  // ===== Tai/Xiu roll =====
  socket.on("tx:roll", () => {
    if (!(pid === 1 || pid === 2)) return;

    const st = room.player[pid] || defaultPlayerState();
    const bet = clampInt(st.txBet ?? 0, MIN_BET, MAX_BET);
    const pickSide = st.txPick === "tai" ? "tai" : "xiu";

    if (!canBet(room, pid, bet)) {
      socket.emit("error:msg", { msg: "Không đủ chip hoặc cược ngoài giới hạn." });
      return;
    }

    const d1 = rollDie(), d2 = rollDie(), d3 = rollDie();
    const sum = d1 + d2 + d3;
    const out = txOutcome(sum);
    const triple = isTriple(d1, d2, d3);

    // casino-like: triple thua cho cược Tài/Xỉu
    const win = (!triple) && (out === pickSide);
    const payoutTotal = win ? bet * 2 : 0;
    const newBal = settle(room, pid, bet, payoutTotal);
    const profit = payoutTotal - bet;

    io.to(roomId).emit("tx:result", {
      by: pid,
      bet,
      pick: pickSide,
      d1, d2, d3, sum,
      out,
      triple,
      win,
      payoutTotal,
      profit,
      balances: room.balances
    });
  });

  // ===== Roulette spin =====
  socket.on("rl:spin", () => {
    if (!(pid === 1 || pid === 2)) return;

    const st = room.player[pid] || defaultPlayerState();
    const bet = clampInt(st.rlBet ?? 0, MIN_BET, MAX_BET);
    const betType = ["red","black","odd","even","low","high","number"].includes(st.rlBetType) ? st.rlBetType : "red";
    const betNumber = clampInt(st.rlNumber ?? 7, 0, 36);

    if (!canBet(room, pid, bet)) {
      socket.emit("error:msg", { msg: "Không đủ chip hoặc cược ngoài giới hạn." });
      return;
    }

    const rolled = crypto.randomInt(37);
    const color = rlColor(rolled);
    const win = rlBetWin(betType, betNumber, rolled);
    const payoutTotal = rlPayoutTotal(betType, bet, win);
    const newBal = settle(room, pid, bet, payoutTotal);
    const profit = payoutTotal - bet;

    io.to(roomId).emit("rl:result", {
      by: pid,
      bet,
      betType,
      betNumber,
      rolled,
      color,
      win,
      payoutTotal,
      profit,
      balances: room.balances
    });
  });

  // ===== Blackjack (turn-based P1 rồi P2) =====
  function mustBeTurnPlayer() {
    return (pid === 1 || pid === 2) && pid === room.bj.turn;
  }

  socket.on("bj:new", () => {
    if (pid !== 1) return; // cho gọn: P1 reset ván
    room.bj = newBjState();
    io.to(roomId).emit("bj:state", { bj: bjSnapshot(room.bj), balances: room.balances });
  });

  socket.on("bj:deal", () => {
    if (!mustBeTurnPlayer()) return;

    const turnPid = room.bj.turn;
    const bet = clampInt(room.player[turnPid]?.bjBet ?? 0, MIN_BET, MAX_BET);
    if (!canBet(room, turnPid, bet)) {
      socket.emit("error:msg", { msg: "Không đủ chip để chia Blackjack." });
      return;
    }

    const state = room.bj;
    state.deck = shuffle(buildDeck());
    state.player = [state.deck.pop(), state.deck.pop()];
    state.dealer = [state.deck.pop(), state.deck.pop()];
    state.inRound = true;
    state.dealerHidden = true;
    state.wagerPid = turnPid;
    state.wager = bet;
    state.lastOutcome = null;
    state.lastProfit = 0;

    // Trừ cược ngay khi chia
    settle(room, turnPid, bet, 0);

    const pBJ = isBlackjack(state.player);
    const dBJ = isBlackjack(state.dealer);

    if (pBJ || dBJ) {
      state.dealerHidden = false;
      state.inRound = false;

      let payoutTotal = 0;
      let outcome = "lose";

      if (pBJ && dBJ) {
        outcome = "push";
        payoutTotal = bet; // hoàn cược
      } else if (pBJ) {
        outcome = "blackjack";
        payoutTotal = Math.floor(bet * 2.5); // 3:2 + stake
      } else {
        outcome = "lose";
        payoutTotal = 0;
      }

      // cộng trả
      room.balances[turnPid] += payoutTotal;

      endBjRound(room, outcome, bet, payoutTotal);
    }

    io.to(roomId).emit("bj:state", { bj: bjSnapshot(room.bj), balances: room.balances });
  });

  socket.on("bj:hit", () => {
    if (!mustBeTurnPlayer()) return;
    const state = room.bj;
    if (!state.inRound) return;
    if (state.wagerPid !== pid) return;

    state.player.push(state.deck.pop());

    const pVal = handValue(state.player);
    if (pVal > 21) {
      state.dealerHidden = false;
      dealerPlay(state);

      const bet = state.wager;
      const payoutTotal = 0;
      const outcome = "bust";

      endBjRound(room, outcome, bet, payoutTotal);

      io.to(roomId).emit("bj:state", { bj: bjSnapshot(room.bj), balances: room.balances });
      return;
    }

    io.to(roomId).emit("bj:state", { bj: bjSnapshot(room.bj), balances: room.balances });
  });

  socket.on("bj:stand", () => {
    if (!mustBeTurnPlayer()) return;
    const state = room.bj;
    if (!state.inRound) return;
    if (state.wagerPid !== pid) return;

    state.dealerHidden = false;
    dealerPlay(state);

    const bet = state.wager;
    const pVal = handValue(state.player);
    const dVal = handValue(state.dealer);

    let outcome = "push";
    let payoutTotal = bet;

    if (dVal > 21) { outcome = "win"; payoutTotal = bet * 2; }
    else if (pVal > dVal) { outcome = "win"; payoutTotal = bet * 2; }
    else if (pVal < dVal) { outcome = "lose"; payoutTotal = 0; }
    else { outcome = "push"; payoutTotal = bet; }

    room.balances[pid] += payoutTotal;

    endBjRound(room, outcome, bet, payoutTotal);

    io.to(roomId).emit("bj:state", { bj: bjSnapshot(room.bj), balances: room.balances });
  });
});

server.listen(PORT, "0.0.0.0", () => {});
