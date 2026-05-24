const suits = ["S", "H", "D", "C"];
const symbols = { S: "♠", H: "♥", D: "♦", C: "♣" };
const ranks = ["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"];
export const chipValues = [10, 50, 100, 500, 1000];
export function createDeck() { const deck = []; for (const suit of suits) for (const rank of ranks) deck.push({ suit: symbols[suit], rank, color: suit === "H" || suit === "D" ? "red" : "black" }); return shuffle(deck); }
export function shuffle(cards) { const copy = [...cards]; for (let i = copy.length - 1; i > 0; i -= 1) { const j = Math.floor(Math.random() * (i + 1)); [copy[i], copy[j]] = [copy[j], copy[i]]; } return copy; }
export function scoreHand(cards) { let total = 0; let aces = 0; for (const card of cards) { if (card.rank === "A") { total += 11; aces += 1; } else if (["K", "Q", "J"].includes(card.rank)) total += 10; else total += Number(card.rank); } while (total > 21 && aces > 0) { total -= 10; aces -= 1; } return { total, soft: aces > 0, blackjack: cards.length === 2 && total === 21, bust: total > 21 }; }
export class BlackjackRound {
  constructor(bet) { this.deck = createDeck(); this.dealer = []; this.hands = [{ cards: [], bet, done: false, doubled: false, result: null }]; this.activeHand = 0; this.phase = "betting"; this.insuranceBet = 0; this.insuranceOffered = false; }
  dealOpening() { this.phase = "player"; this.hands[0].cards.push(this.draw()); this.dealer.push(this.draw()); this.hands[0].cards.push(this.draw()); this.dealer.push(this.draw()); this.insuranceOffered = this.dealer[0]?.rank === "A"; }
  draw() { if (this.deck.length < 12) this.deck.push(...createDeck()); return this.deck.pop(); }
  active() { return this.hands[this.activeHand]; }
  canSplit(balance) { const hand = this.active(); return this.phase === "player" && hand.cards.length === 2 && hand.cards[0].rank === hand.cards[1].rank && balance >= hand.bet; }
  canDouble(balance) { const hand = this.active(); return this.phase === "player" && hand.cards.length === 2 && balance >= hand.bet; }
  takeInsurance(balance) { const cost = Math.ceil(this.hands[0].bet / 2); if (!this.insuranceOffered || this.insuranceBet || balance < cost) return 0; this.insuranceBet = cost; return cost; }
  hit() { const hand = this.active(); hand.cards.push(this.draw()); if (scoreHand(hand.cards).bust) this.finishHand(); }
  stand() { this.finishHand(); }
  doubleDown() { const hand = this.active(); hand.bet *= 2; hand.doubled = true; hand.cards.push(this.draw()); this.finishHand(); }
  split() { const hand = this.active(); const moved = hand.cards.pop(); this.hands.splice(this.activeHand + 1, 0, { cards: [moved], bet: hand.bet, done: false, doubled: false, result: null }); hand.cards.push(this.draw()); this.hands[this.activeHand + 1].cards.push(this.draw()); }
  finishHand() { this.active().done = true; const next = this.hands.findIndex((hand) => !hand.done); if (next === -1) this.phase = "dealer"; else this.activeHand = next; }
  playDealer() { while (true) { const score = scoreHand(this.dealer); if (score.total >= 17) break; this.dealer.push(this.draw()); } this.phase = "complete"; return this.settle(); }
  settle() { const dealerScore = scoreHand(this.dealer); let totalPayout = 0; let net = 0; const outcomes = []; const dealerBlackjack = dealerScore.blackjack; if (this.insuranceBet) { if (dealerBlackjack) { totalPayout += this.insuranceBet * 3; net += this.insuranceBet * 2; } else net -= this.insuranceBet; }
    for (const hand of this.hands) { const playerScore = scoreHand(hand.cards); let label = "Push"; let payout = hand.bet; let handNet = 0; if (playerScore.bust) { label = "Defeat"; payout = 0; handNet = -hand.bet; } else if (playerScore.blackjack && !dealerBlackjack && this.hands.length === 1) { label = "Blackjack"; payout = hand.bet + Math.floor(hand.bet * 1.5); handNet = payout - hand.bet; } else if (dealerScore.bust || playerScore.total > dealerScore.total) { label = "Victory"; payout = hand.bet * 2; handNet = hand.bet; } else if (dealerScore.total > playerScore.total || dealerBlackjack) { label = "Defeat"; payout = 0; handNet = -hand.bet; } totalPayout += payout; net += handNet; hand.result = label; outcomes.push({ label, net: handNet, cards: hand.cards, bet: hand.bet }); }
    return { totalPayout, net, outcomes, insuranceNet: this.insuranceBet ? (dealerBlackjack ? this.insuranceBet * 2 : -this.insuranceBet) : 0 };
  }
}
