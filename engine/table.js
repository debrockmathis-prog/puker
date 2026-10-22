const { newDeck, shuffle, bestHand } = require('./cards');

const MAX_SEATS = 9;
const BETTING_PHASES = ['preflop', 'flop', 'turn', 'river'];

const SEVEN_TWO_BONUS = 30;  // cents each other player pays for winning with 7/2
const SIX_SEVEN_BONUS = 20;  // ... and for winning with 6/7
const STANDUP_PAYMENT = 20;  // last player standing pays this to each other player

// One Texas Hold'em table (no-limit). Pure game logic, no networking:
// the server calls these methods and sends view() to each player.
// All money is in euro cents.
class Table {
  constructor({ smallBlind = 5, bigBlind = 10, buyIn = 500 } = {}) {
    this.settings = { smallBlind, bigBlind, buyIn };
    // One entry per person who ever sat down, kept after they leave, for the scoreboard and settle-up.
    this.ledger = new Map(); // lowercase name -> { id, name, buyIns, cashOut, handsWon, bonusesWon, standupLosses }
    // Stand-up game: ids of players who haven't won a hand yet this round.
    this.standing = null;
    this.standupRound = new Set();
    this.seats = Array(MAX_SEATS).fill(null);
    this.phase = 'waiting'; // waiting | preflop | flop | turn | river | handover
    this.dealer = -1;
    this.sbSeat = -1;
    this.bbSeat = -1;
    this.turn = -1;
    this.board = [];
    this.deck = [];
    this.currentBet = 0;
    this.minRaise = bigBlind;
    this.handNumber = 0;
    this.lastResult = null;
    this.onLog = () => {};
  }

  get players() {
    return this.seats.filter(Boolean);
  }

  get handActive() {
    return BETTING_PHASES.includes(this.phase);
  }

  getPlayer(id) {
    return this.players.find((p) => p.id === id);
  }

  addPlayer({ id, name }) {
    const seat = this.seats.indexOf(null);
    if (seat === -1) throw new Error('Table is full');
    const key = name.toLowerCase();
    let entry = this.ledger.get(key);
    let chips;
    if (entry) {
      // Coming back after leaving: sit down with the stack you left with.
      if (entry.cashOut === null) throw new Error('That name is taken at this table');
      chips = entry.cashOut;
      entry.cashOut = null;
      entry.id = id;
      if (chips === 0) {
        chips = this.settings.buyIn;
        entry.buyIns++;
      }
    } else {
      entry = { id, name, buyIns: 1, cashOut: null, handsWon: 0, bonusesWon: 0, standupLosses: 0 };
      this.ledger.set(key, entry);
      chips = this.settings.buyIn;
    }
    const p = {
      id, name, seat, chips,
      hole: [], bet: 0, total: 0,
      folded: false, allIn: false, acted: false, locked: false,
      inHand: false, shown: false, sittingOut: false, connected: true, leaving: false,
    };
    this.seats[seat] = p;
    return p;
  }

  // Leaving mid-hand folds you; the seat frees up when the hand ends.
  removePlayer(id) {
    const p = this.getPlayer(id);
    if (!p) return;
    if (this.handActive && p.inHand && !p.folded) {
      if (this.turn === p.seat) {
        this.act(id, 'fold');
      } else {
        p.folded = true;
        this.onLog(`${p.name} folds`);
        this._advance();
      }
    }
    if (this.handActive && p.inHand) p.leaving = true;
    else this.seats[p.seat] = null;
    this._entry(p).cashOut = p.chips; // folded already, so this is final
    this.standing?.delete(p.id);
    this.standupRound.delete(p.id);
  }

  _entry(p) {
    return this.ledger.get(p.name.toLowerCase());
  }

  // Buy in again (any time you're not playing a hand), as often as you like.
  buyIn(id) {
    const p = this.getPlayer(id);
    if (!p || p.leaving) throw new Error('Not seated');
    if (this.handActive && p.inHand && !p.folded) throw new Error('Wait until your hand is over');
    p.chips += this.settings.buyIn;
    this._entry(p).buyIns++;
    this.onLog(`${p.name} buys in`);
  }

  eligiblePlayers() {
    return this.players.filter((p) => !p.sittingOut && !p.leaving && p.chips > 0);
  }

  startHand() {
    const eligible = this.eligiblePlayers();
    if (eligible.length < 2) {
      this.phase = 'waiting';
      return false;
    }
    this.handNumber++;
    if (!this.standing) this._resetStandup();
    for (const p of this.players) {
      Object.assign(p, {
        hole: [], bet: 0, total: 0, folded: false, allIn: false,
        acted: false, locked: false, shown: false, inHand: eligible.includes(p),
      });
    }
    this.board = [];
    this.deck = shuffle(newDeck());
    this.lastResult = null;
    this.currentBet = 0;
    this.minRaise = this.settings.bigBlind;

    const inHand = (p) => p.inHand;
    this.dealer = this._nextSeat(this.dealer, inHand);
    // Heads-up: the dealer posts the small blind and acts first preflop.
    this.sbSeat = eligible.length === 2 ? this.dealer : this._nextSeat(this.dealer, inHand);
    this.bbSeat = this._nextSeat(this.sbSeat, inHand);

    this.onLog(`— Hand #${this.handNumber} —`);
    this._postBlind(this.sbSeat, this.settings.smallBlind);
    this._postBlind(this.bbSeat, this.settings.bigBlind);
    this.currentBet = this.settings.bigBlind;

    for (let round = 0; round < 2; round++) {
      let seat = this.sbSeat;
      do {
        this.seats[seat].hole.push(this.deck.pop());
        seat = this._nextSeat(seat, inHand);
      } while (seat !== this.sbSeat);
    }

    this.phase = 'preflop';
    this.turn = this.bbSeat;
    this._advance();
    return true;
  }

  // What the current player is allowed to do right now.
  options(id) {
    const p = this.seats[this.turn];
    if (!this.handActive || !p || p.id !== id) return null;
    const toCall = Math.min(this.currentBet - p.bet, p.chips);
    const maxTo = p.bet + p.chips;
    const canRaise = !p.locked && p.chips > this.currentBet - p.bet;
    return {
      toCall,
      canCheck: toCall === 0,
      canRaise,
      minRaiseTo: Math.min(this.currentBet + this.minRaise, maxTo),
      maxRaiseTo: maxTo,
    };
  }

  act(id, type, amount) {
    const opts = this.options(id);
    if (!opts) throw new Error('Not your turn');
    const p = this.seats[this.turn];

    if (type === 'allin') {
      if (opts.canRaise) [type, amount] = ['raise', opts.maxRaiseTo];
      else type = 'call';
    }

    switch (type) {
      case 'fold':
        p.folded = true;
        this.onLog(`${p.name} folds`);
        break;
      case 'check':
        if (!opts.canCheck) throw new Error(`You must call ${opts.toCall} or fold`);
        this.onLog(`${p.name} checks`);
        break;
      case 'call':
        if (opts.canCheck) {
          this.onLog(`${p.name} checks`);
        } else {
          this._commit(p, opts.toCall);
          this.onLog(`${p.name} calls ${opts.toCall}${p.allIn ? ' (all-in)' : ''}`);
        }
        break;
      case 'raise': {
        if (!opts.canRaise) throw new Error("You can't raise right now");
        const raiseTo = Math.min(Math.floor(Number(amount)), opts.maxRaiseTo);
        if (!(raiseTo >= opts.minRaiseTo)) throw new Error(`Minimum raise is to ${opts.minRaiseTo}`);
        const raiseBy = raiseTo - this.currentBet;
        const wasBet = this.currentBet === 0;
        this._commit(p, raiseTo - p.bet);
        const others = this.players.filter((o) => o !== p && o.inHand && !o.folded && !o.allIn);
        if (raiseBy >= this.minRaise) {
          // Full raise: everyone gets to act again, with raising allowed.
          this.minRaise = raiseBy;
          for (const o of others) Object.assign(o, { acted: false, locked: false });
        } else {
          // Short all-in raise: people who already acted may only call or fold.
          for (const o of others) if (o.acted) Object.assign(o, { acted: false, locked: true });
        }
        this.currentBet = raiseTo;
        this.onLog(`${p.name} ${wasBet ? 'bets' : 'raises to'} ${raiseTo}${p.allIn ? ' (all-in)' : ''}`);
        break;
      }
      default:
        throw new Error('Unknown action');
    }
    p.acted = true;
    this._advance();
  }

  _nextSeat(from, pred) {
    for (let i = 1; i <= MAX_SEATS; i++) {
      const seat = (((from + i) % MAX_SEATS) + MAX_SEATS) % MAX_SEATS;
      const p = this.seats[seat];
      if (p && pred(p)) return seat;
    }
    return -1;
  }

  _commit(p, amount) {
    const a = Math.min(amount, p.chips);
    p.chips -= a;
    p.bet += a;
    p.total += a;
    if (p.chips === 0) p.allIn = true;
  }

  _postBlind(seat, amount) {
    const p = this.seats[seat];
    this._commit(p, amount);
    this.onLog(`${p.name} posts ${p.bet}${p.allIn ? ' (all-in)' : ''}`);
  }

  // Moves play forward: next player, next street, or end of hand.
  _advance() {
    const active = this.players.filter((p) => p.inHand && !p.folded);
    if (active.length === 1) return this._winUncontested(active[0]);

    const canAct = active.filter((p) => !p.allIn);
    const roundDone =
      canAct.every((p) => p.acted && p.bet === this.currentBet) ||
      (canAct.length <= 1 && canAct.every((p) => p.bet >= this.currentBet));

    if (!roundDone) {
      this.turn = this._nextSeat(
        this.turn,
        (p) => p.inHand && !p.folded && !p.allIn && (!p.acted || p.bet < this.currentBet),
      );
      return;
    }

    for (const p of this.players) Object.assign(p, { bet: 0, acted: false, locked: false });
    this.currentBet = 0;
    this.minRaise = this.settings.bigBlind;

    if (this.phase === 'river') return this._showdown();
    this.deck.pop(); // burn
    if (this.phase === 'preflop') {
      this.board.push(this.deck.pop(), this.deck.pop(), this.deck.pop());
      this.phase = 'flop';
    } else {
      this.board.push(this.deck.pop());
      this.phase = this.phase === 'flop' ? 'turn' : 'river';
    }
    this.onLog(`${this.phase[0].toUpperCase() + this.phase.slice(1)}: ${this.board.join(' ')}`);
    // If at most one player can still bet, this recursion runs out the board.
    this.turn = this.dealer;
    this._advance();
  }

  _buildPots() {
    const contributors = this.players.filter((p) => p.total > 0);
    const levels = [...new Set(contributors.filter((p) => p.inHand && !p.folded).map((p) => p.total))]
      .sort((a, b) => a - b);
    const pots = [];
    let prev = 0;
    for (const level of levels) {
      let amount = 0;
      for (const p of contributors) amount += Math.max(0, Math.min(p.total, level) - prev);
      const eligible = contributors.filter((p) => p.inHand && !p.folded && p.total >= level);
      pots.push({ amount, eligible });
      prev = level;
    }
    const leftover = contributors.reduce((s, p) => s + Math.max(0, p.total - prev), 0);
    if (leftover && pots.length) pots[pots.length - 1].amount += leftover;
    return pots;
  }

  _winUncontested(p) {
    const amount = this.players.reduce((s, o) => s + o.total, 0);
    p.chips += amount;
    this.lastResult = { pots: [{ amount, winners: [{ id: p.id, name: p.name }], handName: null }] };
    this.onLog(`${p.name} wins ${amount}`);
    this._sideGames([p]);
    this._endHand();
  }

  // Moves up to `amount` from one stack to another; returns what was actually paid.
  _pay(from, to, amount) {
    const a = Math.min(amount, from.chips);
    from.chips -= a;
    to.chips += a;
    return a;
  }

  _resetStandup() {
    const ids = this.players.filter((p) => !p.leaving).map((p) => p.id);
    this.standing = new Set(ids);
    this.standupRound = new Set(ids);
  }

  // 6/7 and 7/2 bonuses, then the stand-up game. Paid straight from chip stacks.
  _sideGames(winners) {
    const extras = [];
    for (const w of winners) {
      const ranks = w.hole.map((c) => c[0]).sort().join('');
      const each = ranks === '27' ? SEVEN_TWO_BONUS : ranks === '67' ? SIX_SEVEN_BONUS : 0;
      if (!each) continue;
      w.shown = true; // everyone gets to see it
      let total = 0;
      for (const o of this.players) if (o !== w && o.inHand && !o.leaving) total += this._pay(o, w, each);
      this._entry(w).bonusesWon += total;
      const hand = ranks === '27' ? '7/2' : '6/7';
      extras.push({ type: 'bonus', name: w.name, hand, each, total });
      this.onLog(`${w.name} won with ${hand} and collects ${total}`);
    }

    for (const w of winners) {
      this._entry(w).handsWon++;
      this.standing.delete(w.id);
    }
    for (const id of this.standing) {
      const p = this.getPlayer(id);
      if (!p || p.leaving) this.standing.delete(id);
    }
    if (this.standing.size === 1 && this.standupRound.size > 1) {
      const loser = this.getPlayer([...this.standing][0]);
      let total = 0;
      for (const o of this.players) {
        if (o !== loser && !o.leaving && this.standupRound.has(o.id)) total += this._pay(loser, o, STANDUP_PAYMENT);
      }
      this._entry(loser).standupLosses++;
      extras.push({ type: 'standup', name: loser.name, each: STANDUP_PAYMENT, total });
      this.onLog(`${loser.name} is last standing and pays ${total}`);
      this._resetStandup();
    } else if (this.standing.size === 0) {
      this._resetStandup();
    }
    this.lastResult.extras = extras;
  }

  // Scoreboard rows, best first. Net = chips now (or when you left) minus what you bought in for.
  scoreboard() {
    return [...this.ledger.values()].map((e) => {
      const p = e.cashOut === null ? this.getPlayer(e.id) : null;
      const chips = p ? p.chips + p.total : e.cashOut;
      return {
        id: e.id, name: e.name, buyIns: e.buyIns, chips, left: e.cashOut !== null,
        net: chips - e.buyIns * this.settings.buyIn,
        handsWon: e.handsWon, bonusesWon: e.bonusesWon, standupLosses: e.standupLosses,
        standing: Boolean(this.standing?.has(e.id)),
      };
    }).sort((a, b) => b.net - a.net || b.handsWon - a.handsWon);
  }

  // Who pays whom at the end: biggest loser pays biggest winner until everyone is even.
  settlement() {
    const rows = this.scoreboard();
    const owes = rows.filter((r) => r.net < 0).map((r) => ({ name: r.name, amt: -r.net }));
    const gets = rows.filter((r) => r.net > 0).map((r) => ({ name: r.name, amt: r.net }));
    const transfers = [];
    while (owes.length && gets.length) {
      owes.sort((a, b) => b.amt - a.amt);
      gets.sort((a, b) => b.amt - a.amt);
      const amount = Math.min(owes[0].amt, gets[0].amt);
      transfers.push({ from: owes[0].name, to: gets[0].name, amount });
      owes[0].amt -= amount;
      gets[0].amt -= amount;
      if (!owes[0].amt) owes.shift();
      if (!gets[0].amt) gets.shift();
    }
    return transfers;
  }

  _showdown() {
    const active = this.players.filter((p) => p.inHand && !p.folded);
    const hands = new Map();
    for (const p of active) {
      p.shown = true;
      hands.set(p, bestHand([...p.hole, ...this.board]));
      this.onLog(`${p.name} shows ${p.hole.join(' ')} — ${hands.get(p).name}`);
    }
    // Odd chips go to the first winner left of the dealer.
    const order = (p) => (p.seat - this.dealer - 1 + MAX_SEATS) % MAX_SEATS;

    const results = [];
    for (const pot of this._buildPots()) {
      const top = Math.max(...pot.eligible.map((p) => hands.get(p).score));
      const winners = pot.eligible.filter((p) => hands.get(p).score === top).sort((a, b) => order(a) - order(b));
      const share = Math.floor(pot.amount / winners.length);
      let remainder = pot.amount - share * winners.length;
      for (const w of winners) {
        w.chips += share + (remainder > 0 ? 1 : 0);
        remainder--;
      }
      const handName = hands.get(winners[0]).name;
      results.push({ amount: pot.amount, winners: winners.map((w) => ({ id: w.id, name: w.name })), handName });
      this.onLog(`${winners.map((w) => w.name).join(' & ')} ${winners.length > 1 ? 'split' : 'wins'} ${pot.amount} with ${handName}`);
    }
    this.lastResult = {
      pots: results,
      hands: Object.fromEntries([...hands].map(([p, h]) => [p.id, { name: h.name, cards: h.cards }])),
    };
    const allWinners = new Set(results.flatMap((r) => r.winners.map((w) => w.id)));
    this._sideGames(this.players.filter((p) => allWinners.has(p.id)));
    this._endHand();
  }

  _endHand() {
    this.phase = 'handover';
    this.turn = -1;
    for (const p of this.players) {
      p.bet = 0;
      p.total = 0;
      if (p.leaving) this.seats[p.seat] = null;
    }
  }

  // The table as one player is allowed to see it (no peeking at others' cards).
  view(forId) {
    const pot = this.players.reduce((s, p) => s + p.total, 0);
    return {
      settings: this.settings,
      phase: this.phase,
      handActive: this.handActive,
      handNumber: this.handNumber,
      board: this.board,
      dealer: this.dealer,
      sbSeat: this.sbSeat,
      bbSeat: this.bbSeat,
      turn: this.turn,
      currentBet: this.currentBet,
      pot,
      lastResult: this.lastResult,
      scoreboard: this.scoreboard(),
      standing: this.standing ? [...this.standing] : [],
      options: this.options(forId),
      seats: this.seats.map((p) => p && {
        id: p.id,
        name: p.name,
        seat: p.seat,
        chips: p.chips,
        bet: p.bet,
        folded: p.folded,
        allIn: p.allIn,
        inHand: p.inHand,
        sittingOut: p.sittingOut,
        connected: p.connected,
        hasCards: p.inHand && !p.folded && p.hole.length > 0,
        cards: p.id === forId || p.shown ? p.hole : null,
      }),
    };
  }
}

module.exports = { Table, MAX_SEATS };
