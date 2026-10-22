const crypto = require('crypto');

const RANKS = '23456789TJQKA';
const SUITS = 'shdc';
const HAND_NAMES = [
  'High Card', 'Pair', 'Two Pair', 'Three of a Kind', 'Straight',
  'Flush', 'Full House', 'Four of a Kind', 'Straight Flush',
];

function newDeck() {
  const deck = [];
  for (const r of RANKS) for (const s of SUITS) deck.push(r + s);
  return deck;
}

// Fisher-Yates with a cryptographic RNG so the deal can't be predicted.
function shuffle(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = crypto.randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

const rankValue = (card) => RANKS.indexOf(card[0]) + 2;

// Scores exactly 5 cards. Higher score = better hand.
function evaluate5(cards) {
  const vals = cards.map(rankValue).sort((a, b) => b - a);
  const flush = cards.every((c) => c[1] === cards[0][1]);

  let straightHigh = 0;
  if (new Set(vals).size === 5) {
    if (vals[0] - vals[4] === 4) straightHigh = vals[0];
    else if (vals[0] === 14 && vals[1] === 5) straightHigh = 5; // A-2-3-4-5 wheel
  }

  const counts = {};
  for (const v of vals) counts[v] = (counts[v] || 0) + 1;
  // Group by count first, then rank, so kickers come out in the right order.
  const groups = Object.entries(counts)
    .map(([v, c]) => [Number(v), c])
    .sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const byGroup = groups.map((g) => g[0]);

  let cat, kickers;
  if (straightHigh && flush) [cat, kickers] = [8, [straightHigh]];
  else if (groups[0][1] === 4) [cat, kickers] = [7, byGroup];
  else if (groups[0][1] === 3 && groups[1][1] === 2) [cat, kickers] = [6, byGroup];
  else if (flush) [cat, kickers] = [5, vals];
  else if (straightHigh) [cat, kickers] = [4, [straightHigh]];
  else if (groups[0][1] === 3) [cat, kickers] = [3, byGroup];
  else if (groups[0][1] === 2 && groups[1][1] === 2) [cat, kickers] = [2, byGroup];
  else if (groups[0][1] === 2) [cat, kickers] = [1, byGroup];
  else [cat, kickers] = [0, vals];

  let score = cat;
  for (let i = 0; i < 5; i++) score = score * 15 + (kickers[i] || 0);
  return { score, cat };
}

// Best 5-card hand out of 5-7 cards.
function bestHand(cards) {
  let best = null;
  const n = cards.length;
  for (let a = 0; a < n; a++)
    for (let b = a + 1; b < n; b++)
      for (let c = b + 1; c < n; c++)
        for (let d = c + 1; d < n; d++)
          for (let e = d + 1; e < n; e++) {
            const combo = [cards[a], cards[b], cards[c], cards[d], cards[e]];
            const res = evaluate5(combo);
            if (!best || res.score > best.score) best = { ...res, cards: combo };
          }
  return { score: best.score, name: HAND_NAMES[best.cat], cards: best.cards };
}

module.exports = { newDeck, shuffle, bestHand, HAND_NAMES };
