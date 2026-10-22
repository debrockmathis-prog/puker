// Run with: npm test
const assert = require('assert');
const { bestHand } = require('../engine/cards');
const { Table } = require('../engine/table');

const h = (s) => bestHand(s.split(' '));
const beats = (a, b) => assert.ok(h(a).score > h(b).score, `${a} should beat ${b}`);
const ties = (a, b) => assert.strictEqual(h(a).score, h(b).score, `${a} should tie ${b}`);

// --- Hand evaluator ---
assert.strictEqual(h('As Ks Qs Js Ts 2d 3c').name, 'Straight Flush');
assert.strictEqual(h('5h 4h 3h 2h Ah Kd Kc').name, 'Straight Flush');
assert.strictEqual(h('9c 9d 9h 9s 2c 3d 4h').name, 'Four of a Kind');
assert.strictEqual(h('9c 9d 9h 2s 2c 3d 4h').name, 'Full House');
assert.strictEqual(h('Ac 9c 7c 4c 2c Kd Qh').name, 'Flush');
assert.strictEqual(h('Ac 2d 3h 4s 5c Kd Qh').name, 'Straight');
assert.strictEqual(h('7c 7d 7h Ks 2c 3d 9h').name, 'Three of a Kind');
assert.strictEqual(h('7c 7d Kh Ks 2c 3d 9h').name, 'Two Pair');
assert.strictEqual(h('7c 7d Kh Qs 2c 3d 9h').name, 'Pair');
assert.strictEqual(h('7c 8d Kh Qs 2c 3d 9h').name, 'High Card');

beats('6c 2d 3h 4s 5c', 'Ac 2d 3h 4s 5d'); // 6-high straight beats the wheel
beats('Ah Ad Kc Qd Js', 'Ah Ad Kc Qd Ts'); // kicker
beats('Kh Kd Kc 2d 2s', 'Qh Qd Qc Ad As'); // full house ranked by trips
beats('Ah Ad 3c 3d 2s', 'Kh Kd Qc Qd As'); // two pair ranked by top pair
beats('2c 3c 4c 5c 7c', 'As Ks Qs Jd Th'); // flush beats straight
ties('Ah Kd Qc Js 9h', 'Ad Kc Qh Jd 9s');

// --- Helpers for table tests ---
function makeTable(stacks, opts = {}) {
  const t = new Table({ smallBlind: 10, bigBlind: 20, startingChips: 1000, ...opts });
  stacks.forEach((chips, i) => {
    const p = t.addPlayer({ id: `p${i}`, name: `P${i}` });
    p.chips = chips;
  });
  return t;
}
const chipsInPlay = (t) => t.players.reduce((s, p) => s + p.chips + p.total, 0);
const current = (t) => t.seats[t.turn];

// --- Heads-up blinds and action order ---
{
  const t = makeTable([1000, 1000]);
  t.startHand();
  assert.strictEqual(t.dealer, 0);
  assert.strictEqual(t.sbSeat, 0, 'dealer posts SB heads-up');
  assert.strictEqual(t.turn, 0, 'dealer acts first preflop heads-up');
  t.act('p0', 'call');
  assert.strictEqual(t.turn, 1, 'big blind gets the option');
  t.act('p1', 'check');
  assert.strictEqual(t.phase, 'flop');
  assert.strictEqual(t.turn, 1, 'big blind acts first after the flop heads-up');
}

// --- 3-handed: everyone folds to the big blind ---
{
  const t = makeTable([1000, 1000, 1000]);
  t.startHand(); // dealer 0, SB 1, BB 2, first to act 0
  assert.strictEqual(t.turn, 0);
  t.act('p0', 'fold');
  t.act('p1', 'fold');
  assert.strictEqual(t.phase, 'handover');
  assert.strictEqual(t.getPlayer('p2').chips, 1010);
  assert.strictEqual(chipsInPlay(t), 3000);
}

// --- Min-raise enforcement ---
{
  const t = makeTable([1000, 1000, 1000]);
  t.startHand();
  assert.throws(() => t.act('p0', 'raise', 30), /Minimum raise/);
  t.act('p0', 'raise', 60); // raise by 40
  assert.throws(() => t.act('p1', 'raise', 80), /Minimum raise is to 100/);
  t.act('p1', 'raise', 100);
  assert.throws(() => t.act('p2', 'check'), /must call/);
  assert.throws(() => t.act('p1', 'call'), /Not your turn/);
}

// --- Side pots: short stack all-in, two bigger stacks keep betting ---
{
  const t = makeTable([100, 500, 500]);
  t.startHand(); // dealer p0, SB p1, BB p2
  t.act('p0', 'allin'); // 100
  t.act('p1', 'call');
  t.act('p2', 'call');
  assert.strictEqual(t.phase, 'flop');
  t.act('p1', 'raise', 200);
  t.act('p2', 'call');
  const pots = t._buildPots();
  assert.deepStrictEqual(pots.map((p) => p.amount), [300, 400]);
  assert.deepStrictEqual(pots[0].eligible.map((p) => p.id).sort(), ['p0', 'p1', 'p2']);
  assert.deepStrictEqual(pots[1].eligible.map((p) => p.id).sort(), ['p1', 'p2']);
}

// --- Short all-in raise does not reopen raising for players who already acted ---
{
  const t = makeTable([1000, 1000, 1000, 50]);
  t.startHand(); // dealer p0, SB p1, BB p2, UTG p3
  t.act('p3', 'call'); // 20
  t.act('p0', 'call');
  t.act('p1', 'call');
  t.act('p2', 'check');
  assert.strictEqual(t.phase, 'flop');
  t.act('p1', 'raise', 20); // bet 20
  t.act('p2', 'call');
  t.act('p3', 'allin'); // 30 total: a raise of only 10
  t.act('p0', 'raise', 50); // p0 hadn't acted, so may raise
  assert.strictEqual(current(t).id, 'p1');
  t.act('p1', 'call');
  assert.strictEqual(t.options('p2').canRaise, true, 'full raise by p0 reopens action');
}

// --- Fuzz: random games never crash and never create or lose chips ---
{
  const actions = ['fold', 'check', 'call', 'raise', 'allin'];
  for (let game = 0; game < 300; game++) {
    const n = 2 + (game % 8);
    const t = makeTable(Array.from({ length: n }, () => 50 + Math.floor(Math.random() * 2000)));
    const total = chipsInPlay(t);
    for (let hand = 0; hand < 30 && t.startHand(); hand++) {
      let guard = 0;
      while (t.handActive) {
        assert.ok(guard++ < 500, 'hand did not terminate');
        const p = current(t);
        const o = t.options(p.id);
        const pick = actions[Math.floor(Math.random() * actions.length)];
        try {
          const amt = o.minRaiseTo + Math.floor(Math.random() * (o.maxRaiseTo - o.minRaiseTo + 1));
          t.act(p.id, pick, amt);
        } catch (e) {
          t.act(p.id, o.canCheck ? 'check' : 'fold');
        }
        assert.strictEqual(chipsInPlay(t), total, 'chips conserved mid-hand');
      }
      assert.strictEqual(t.players.reduce((s, p) => s + p.chips, 0), total, 'chips conserved after hand');
      assert.ok(t.players.every((p) => p.chips >= 0));
    }
  }
}

console.log('All engine tests passed');
