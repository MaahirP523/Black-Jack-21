import { AudioManager } from "./audio.js";
import { chipValues, scoreHand } from "./blackjack.js";
import { Particles } from "./particles.js";
import { loadPlayer, savePlayer } from "./storage.js";

const $ = (id) => document.getElementById(id);
const player = loadPlayer();
const audio = new AudioManager(player.settings);
const particles = new Particles($("particle-canvas"));
const suitSymbols = { S: "♠", H: "♥", D: "♦", C: "♣" };
let socket = null;
let state = null;
let pendingBet = 0;
let lastCompleteKey = "";

boot();

function boot() {
  $("balance-display").textContent = format(player.balance);
  $("player-name").value = localStorage.getItem("aurum21.name") || `Player${Math.floor(Math.random() * 90 + 10)}`;
  $("room-code").value = new URLSearchParams(location.search).get("room") || "";
  $("server-url").value = localStorage.getItem("aurum21.serverUrl") || defaultServerUrl();
  buildChips();
  bind();
  setStatus("Create or join a room");
}

function bind() {
  $("back-home").addEventListener("click", () => (location.href = "./index.html"));
  $("create-room").addEventListener("click", () => connect(randomRoom()));
  $("join-room").addEventListener("click", () => connect(($("room-code").value || "A21").toUpperCase()));
  $("clear-bet").addEventListener("click", () => {
    pendingBet = 0;
    updateBet();
  });
  $("ready-button").addEventListener("click", () => send({ type: "bet", bet: pendingBet }));
  $("next-round").addEventListener("click", () => {
    pendingBet = 0;
    send({ type: "next" });
  });
  $("hit-button").addEventListener("click", () => sendAction("hit"));
  $("stand-button").addEventListener("click", () => sendAction("stand"));
  $("double-button").addEventListener("click", () => sendAction("double"));
  $("split-button").addEventListener("click", () => sendAction("split"));
  $("insurance-button").addEventListener("click", () => sendAction("insurance"));
}

function buildChips() {
  $("chip-rack").innerHTML = "";
  chipValues.forEach((value) => {
    const button = document.createElement("button");
    button.className = `chip chip-${value}`;
    button.type = "button";
    button.textContent = value;
    button.ariaLabel = `Bet ${value} chips`;
    button.addEventListener("click", () => {
      unlockAudio();
      if (state && state.phase !== "betting" && state.phase !== "complete") return;
      if (pendingBet + value > player.balance) return setStatus("Not enough local chips");
      pendingBet += value;
      audio.sound("chip");
      updateBet();
      animateBetChip(value);
    });
    $("chip-rack").append(button);
  });
}

function connect(room) {
  unlockAudio();
  const name = $("player-name").value.trim() || "Player";
  const serverUrl = normalizeServerUrl($("server-url").value);
  localStorage.setItem("aurum21.name", name);
  localStorage.setItem("aurum21.serverUrl", serverUrl);
  $("room-code").value = room;
  socket?.close();
  socket = new WebSocket(serverUrl);
  $("connection-status").textContent = "Server: connecting...";
  socket.addEventListener("open", () => {
    $("connection-status").textContent = "Server: connected";
    send({ type: "join", room, name, balance: player.balance });
    history.replaceState(null, "", `?room=${room}`);
  });
  socket.addEventListener("message", (event) => {
    state = JSON.parse(event.data);
    render();
  });
  socket.addEventListener("close", () => {
    $("connection-status").textContent = "Server: disconnected. Start server.py and reconnect.";
    setStatus("Disconnected");
  });
  socket.addEventListener("error", () => {
    $("connection-status").textContent = "Server: unavailable";
    showConnectPanel();
  });
}

function send(data) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data));
}

function sendAction(type) {
  unlockAudio();
  audio.sound(type === "insurance" ? "chip" : "deal");
  send({ type });
}

function render() {
  if (!state) return;
  $("connect-panel").classList.add("hidden");
  $("multiplayer-table").classList.remove("hidden");
  $("room-display").textContent = state.room;
  const me = mySeat();
  if (me) {
    player.balance = me.balance;
    savePlayer(player);
    $("balance-display").textContent = format(player.balance);
  }
  renderDealer();
  renderPlayers();
  renderControls();
  if (state.phase === "complete") renderComplete(me);
}

function renderDealer() {
  $("dealer-hand").innerHTML = "";
  const dealer = state.dealer || [];
  if (!dealer.length) {
    $("dealer-hand").append(cardBack(), cardBack());
  } else {
    dealer.forEach((card) => $("dealer-hand").append(card.hidden ? cardBack() : cardEl(card)));
  }
  $("dealer-score").textContent = state.dealerScore || 0;
}

function renderPlayers() {
  $("players-grid").innerHTML = "";
  for (const seat of state.players) {
    const seatEl = document.createElement("article");
    seatEl.className = `player-seat glass-panel ${seat.id === state.activePlayer ? "active-hand" : ""}`;
    const isYou = seat.id === state.you ? "You" : seat.name;
    seatEl.innerHTML = `<div class="seat-header"><strong>${isYou}</strong><span>${format(seat.balance)} chips</span></div><div class="seat-meta"><span>Bet ${format(seat.bet)}</span><span>${seat.result || (seat.ready ? "Ready" : "Betting")}</span></div>`;
    const hands = document.createElement("div");
    hands.className = "seat-hands";
    if (!seat.hands.length) {
      hands.append(cardBack(), cardBack());
    }
    seat.hands.forEach((hand, index) => {
      const handEl = document.createElement("div");
      handEl.className = `seat-hand ${seat.id === state.you && index === seat.activeHand && state.activePlayer === seat.id ? "active-hand" : ""}`;
      handEl.innerHTML = `<div class="hand-meta"><span>Hand ${index + 1}</span><strong>${scoreLabel(hand.cards)}</strong><em>${format(hand.bet)}</em></div>`;
      const cards = document.createElement("div");
      cards.className = "hand";
      hand.cards.forEach((card) => cards.append(cardEl(card)));
      handEl.append(cards);
      if (hand.result) {
        const badge = document.createElement("span");
        badge.className = "result-badge";
        badge.textContent = hand.result;
        handEl.append(badge);
      }
      hands.append(handEl);
    });
    seatEl.append(hands);
    $("players-grid").append(seatEl);
  }
}

function renderControls() {
  const me = mySeat();
  const isBetting = state.phase === "betting" || state.phase === "complete";
  const isMyTurn = state.phase === "playing" && state.activePlayer === state.you;
  $("betting-zone").classList.toggle("hidden", !isBetting);
  $("action-panel").classList.toggle("hidden", !isMyTurn);
  $("next-round").classList.toggle("hidden", state.phase !== "complete");
  $("ready-button").disabled = pendingBet <= 0 || pendingBet > player.balance;
  const hand = activeHand(me);
  $("double-button").disabled = !hand || hand.cards.length !== 2 || player.balance < hand.bet;
  $("split-button").disabled = !hand || hand.cards.length !== 2 || hand.cards[0].rank !== hand.cards[1].rank || player.balance < hand.bet;
  $("insurance-button").disabled = !me || me.insurance > 0 || !state.dealer?.[0] || state.dealer[0].rank !== "A";
  if (state.phase === "betting") setStatus("Place bets. Round starts when all connected players are ready.");
  if (state.phase === "playing") setStatus(isMyTurn ? "Your turn" : `${activeName()} is playing`);
  if (state.phase === "dealer") setStatus("Dealer is resolving the table");
}

function renderComplete(me) {
  const key = `${state.room}:${state.players.map((p) => `${p.id}:${p.net}:${p.balance}`).join("|")}`;
  if (key === lastCompleteKey) return;
  lastCompleteKey = key;
  if (!me) return;
  const title = me.net > 0 ? "Victory" : me.net < 0 ? "Defeat" : "Push";
  setStatus(`${title} ${me.net >= 0 ? "+" : ""}${format(me.net)} chips`);
  if (me.net > 0) {
    particles.burst();
    audio.sound("win");
  } else {
    audio.sound(me.net < 0 ? "lose" : "push");
  }
}

function mySeat() {
  return state?.players.find((seat) => seat.id === state.you);
}

function activeHand(seat) {
  return seat?.hands?.[seat.activeHand];
}

function activeName() {
  return state.players.find((seat) => seat.id === state.activePlayer)?.name || "Another player";
}

function cardEl(card) {
  const suit = suitSymbols[card.suit] || card.suit;
  const color = card.suit === "H" || card.suit === "D" ? "red" : "black";
  const el = document.createElement("article");
  el.className = `card ${color} dealt`;
  el.innerHTML = `<span>${card.rank}</span><strong>${suit}</strong><span>${card.rank}</span>`;
  return el;
}

function cardBack() {
  const el = document.createElement("article");
  el.className = `card back ${player.settings.cardBack}`;
  el.innerHTML = "<strong>A21</strong>";
  return el;
}

function scoreLabel(cards) {
  const normalized = cards.map((card) => ({ ...card, suit: suitSymbols[card.suit] || card.suit, color: card.suit === "H" || card.suit === "D" ? "red" : "black" }));
  const handScore = scoreHand(normalized);
  return handScore.blackjack ? "Blackjack" : handScore.total;
}

function updateBet() {
  $("bet-display").textContent = format(pendingBet);
  $("ready-button").disabled = pendingBet <= 0 || pendingBet > player.balance;
}

function setStatus(text) {
  $("status-banner").textContent = text;
}

function showConnectPanel() {
  $("connect-panel").classList.remove("hidden");
  $("multiplayer-table").classList.add("hidden");
}

function unlockAudio() {
  audio.ensure();
  audio.startMusic();
}

function animateBetChip(value) {
  const chip = document.createElement("div");
  chip.className = `flying-chip chip chip-${value}`;
  chip.textContent = value;
  document.body.append(chip);
  setTimeout(() => chip.remove(), 720);
}

function randomRoom() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 5 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function defaultServerUrl() {
  return "wss://black-jack-21-1.onrender.com/ws";
}

function normalizeServerUrl(value) {
  const trimmed = value.trim();
  if (trimmed.startsWith("ws://") || trimmed.startsWith("wss://")) return trimmed;
  if (trimmed.startsWith("https://")) return `wss://${withWsPath(trimmed.slice(8))}`;
  if (trimmed.startsWith("http://")) return `ws://${withWsPath(trimmed.slice(7))}`;
  return defaultServerUrl();
}

function withWsPath(hostAndPath) {
  const clean = hostAndPath.replace(/\/$/, "");
  return clean.endsWith("/ws") ? clean : `${clean}/ws`;
}

function format(value) {
  return new Intl.NumberFormat("en-US").format(value || 0);
}
