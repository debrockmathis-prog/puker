const socket = io();
const $ = (id) => document.getElementById(id);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

// A secret per browser so a refresh puts you back in your seat.
let token = store.get('poker_token');
if (!token) {
  token = window.crypto?.randomUUID?.() ||
    Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  store.set('poker_token', token);
}

let S = null;            // latest state from the server
let roomCode = null;     // the table we're at (or trying to join)
let clockOffset = 0;     // server time minus our time
let controlsKey = null;
let seenCards = new Set();
let seenHand = -1;
let shownEnd = false;    // opened the settle-up screen for this game already

const SUIT = { s: '♠', h: '♥', d: '♦', c: '♣' };
// Amounts are euro cents, shown like €1.25
const euros = new Intl.NumberFormat('en-IE', { style: 'currency', currency: 'EUR', minimumFractionDigits: 2 });
const fmt = (cents) => euros.format(cents / 100);
const signed = (cents) => (cents > 0 ? '+' : cents < 0 ? '−' : '') + fmt(Math.abs(cents));
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

// ---------- Home screen ----------
$('name').value = store.get('poker_name') || '';
const params = new URLSearchParams(location.search);
if (params.get('room')) $('code').value = params.get('room').toUpperCase();

function getName() {
  const name = $('name').value.trim();
  if (!name) { $('homeError').textContent = 'Enter your name first'; $('name').focus(); return null; }
  store.set('poker_name', name);
  return name;
}

function enter(code) {
  roomCode = code;
  history.replaceState(null, '', `?room=${code}`);
  $('home').classList.add('hidden');
  $('game').classList.remove('hidden');
}

function goHome(message = '') {
  roomCode = null;
  S = null;
  controlsKey = null;
  shownEnd = false;
  $('scores').classList.add('hidden');
  history.replaceState(null, '', location.pathname);
  $('game').classList.add('hidden');
  $('home').classList.remove('hidden');
  $('homeError').textContent = message;
}

function joinRoom(code, name) {
  socket.emit('join', { code, name, token }, (res) => {
    if (res.error) return goHome(res.error);
    enter(res.code);
  });
}

$('createBtn').onclick = () => {
  const name = getName();
  if (!name) return;
  socket.emit('create', { name, token }, (res) => {
    if (res.error) return ($('homeError').textContent = res.error);
    enter(res.code);
  });
};

$('joinBtn').onclick = () => {
  const name = getName();
  const code = $('code').value.trim().toUpperCase();
  if (!name) return;
  if (code.length !== 5) return ($('homeError').textContent = 'Table codes are 5 letters');
  joinRoom(code, name);
};
$('code').addEventListener('keydown', (e) => e.key === 'Enter' && $('joinBtn').click());

// Followed an invite link and we already know your name: sit right down.
if (params.get('room') && store.get('poker_name')) roomCode = params.get('room').toUpperCase();

socket.on('connect', () => {
  if (roomCode) joinRoom(roomCode, store.get('poker_name'));
});
socket.on('kicked', (msg) => goHome(msg));
socket.on('state', (state) => {
  S = state;
  clockOffset = state.serverNow - Date.now();
  render();
});

// ---------- Game screen buttons ----------
function send(event, payload = {}) {
  socket.emit(event, payload, (res) => res?.error && toast(res.error));
}

$('leaveBtn').onclick = () => {
  if (S?.table.handActive === false || confirm('Leave the table? You will fold this hand.')) {
    socket.emit('leave', {}, () => goHome());
  }
};
$('sitoutBtn').onclick = () => send('sitout', { value: !me()?.sittingOut });
$('copyBtn').onclick = async () => {
  const link = `${location.origin}/?room=${S.code}`;
  try {
    await navigator.clipboard.writeText(link);
    toast('Invite link copied', true);
  } catch {
    prompt('Copy this link and send it to your friends:', link);
  }
};
$('scoresBtn').onclick = () => $('scores').classList.remove('hidden');
$('closeScores').onclick = () => $('scores').classList.add('hidden');
$('scores').onclick = (e) => e.target === $('scores') && $('scores').classList.add('hidden');
$('buyinBtn').onclick = () => send('buyin');
$('endBtn').onclick = () => {
  if (confirm('End the game for everyone and work out who pays whom?')) send('end');
};

let toastTimer;
function toast(text, ok = false) {
  const el = $('toast');
  el.textContent = text;
  el.className = `toast show${ok ? ' ok' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = 'toast'), 2500);
}

// ---------- Rendering ----------
const me = () => S?.table.seats.find((p) => p && p.id === S.you);

function cardHtml(card, where, extra = '') {
  const key = `${where}:${card}`;
  const fresh = !seenCards.has(key);
  seenCards.add(key);
  const red = card[1] === 'h' || card[1] === 'd';
  const rank = card[0] === 'T' ? '10' : card[0];
  return `<div class="card${red ? ' red' : ''}${fresh ? ' fresh' : ''} ${extra}"><span class="r">${rank}</span><span class="s">${SUIT[card[1]]}</span></div>`;
}

// Players sit evenly around an ellipse; you are always at the bottom, next player to your left.
function spot(slot, count, rx, ry) {
  const a = Math.PI / 2 + (slot * 2 * Math.PI) / count;
  return { x: 50 + rx * Math.cos(a), y: 50 + ry * Math.sin(a) };
}

function render() {
  const t = S.table;
  const mine = me();
  const mySeat = mine ? mine.seat : 0;
  const isHost = S.hostId === S.you;
  const standing = new Set(t.standing);

  if (t.handNumber !== seenHand) { seenCards = new Set(); seenHand = t.handNumber; }

  $('roomCode').textContent = S.code;
  $('sitoutBtn').textContent = mine?.sittingOut ? "I'm back" : 'Sit out';

  // Showdown highlights
  const result = t.phase === 'handover' ? t.lastResult : null;
  const winners = new Set(result ? result.pots.flatMap((p) => p.winners.map((w) => w.id)) : []);
  const winCards = new Set();
  if (result?.hands) {
    for (const w of result.pots[0].winners) result.hands[w.id]?.cards.forEach((c) => winCards.add(c));
  }
  const cardClass = (c) => (result?.hands ? (winCards.has(c) ? 'win' : 'dim') : '');

  // Board
  let board = '';
  for (let i = 0; i < 5; i++) {
    board += t.board[i] ? cardHtml(t.board[i], 'board', cardClass(t.board[i])) : '<div class="slot"></div>';
  }
  $('board').innerHTML = board;
  $('pot').textContent = t.pot > 0 ? `Pot ${fmt(t.pot)}` : '';

  let message = '';
  if (S.ended) {
    message = 'Game over. Open 🏆 Scores to see who pays who.';
  } else if (result) {
    const lines = result.pots.map((p) => {
      const names = p.winners.map((w) => esc(w.name)).join(' & ');
      return `${names} ${p.winners.length > 1 ? 'split' : 'wins'} ${fmt(p.amount)}${p.handName ? ` with ${p.handName}` : ''}`;
    });
    for (const x of result.extras || []) {
      lines.push(x.type === 'bonus'
        ? `<span class="bonus">🎉 ${esc(x.name)} won with ${x.hand}: everyone pays ${fmt(x.each)} (${fmt(x.total)})</span>`
        : `<span class="bonus">🧍 ${esc(x.name)} was last standing: pays everyone ${fmt(x.each)} (${fmt(x.total)})</span>`);
    }
    message = lines.join('<br>');
  } else if (!S.started) {
    message = isHost ? 'Share the invite link, then start the game' : 'Waiting for the host to start';
  }
  $('result').innerHTML = message;

  // Seats, bets, dealer button
  let html = '';
  const seated = t.seats.filter(Boolean)
    .sort((a, b) => ((a.seat - mySeat + 9) % 9) - ((b.seat - mySeat + 9) % 9));
  const count = Math.max(seated.length, 2);
  seated.forEach((p, rel) => {
    const pos = spot(rel, count, 47, 48);
    const classes = ['seat'];
    if (p.id === S.you) classes.push('me');
    if (t.turn === p.seat) classes.push('turn');
    if (winners.has(p.id)) classes.push('winner');
    if (p.folded) classes.push('folded');
    if (p.sittingOut || (!p.inHand && t.handActive)) classes.push('out');
    if (!p.connected) classes.push('offline');

    let cards = '';
    if (p.cards) {
      cards = p.cards.map((c) => cardHtml(c, `seat${p.seat}`, cardClass(c))).join('');
    } else if (p.hasCards) {
      cards = '<div class="card back"></div><div class="card back"></div>';
    }

    let tag = '';
    if (p.sittingOut) tag = 'Sitting out';
    else if (p.chips === 0 && !p.allIn) tag = 'Busted';
    else if (p.allIn) tag = 'All-in';
    else if (p.folded) tag = 'Folded';
    else if (p.id === S.hostId && !S.started) tag = 'Host';

    const stand = S.started && !S.ended && standing.has(p.id)
      ? '<span class="standing" title="Still standing: hasn\'t won a hand this round">🧍</span>' : '';

    html += `
      <div class="${classes.join(' ')}" style="left:${pos.x}%;top:${pos.y}%">
        <div class="hole">${cards}</div>
        <div class="plate">
          ${stand}
          <div class="name">${esc(p.name)}</div>
          <div class="stack">${fmt(p.chips)}</div>
          ${tag ? `<div class="tag">${tag}</div>` : ''}
          ${t.turn === p.seat ? '<div class="timer"><i></i></div>' : ''}
        </div>
      </div>`;

    if (p.bet > 0) {
      const b = spot(rel, count, 30, 28);
      html += `<div class="bet" style="left:${b.x}%;top:${b.y}%"><span class="chip"></span>${fmt(p.bet)}</div>`;
    }
    if (t.dealer === p.seat && t.handNumber > 0) {
      const d = spot(rel - 0.35 * count / 9, count, 36, 34);
      html += `<div class="dealer-btn" style="left:${d.x}%;top:${d.y}%">D</div>`;
    }
  });
  $('seats').innerHTML = html;
  tickTimer();
  renderControls(mine, isHost);
  renderScores(mine, isHost);
}

// Leaderboard + buy-in tracker, and the settle-up list once the game has ended.
function renderScores(mine, isHost) {
  const t = S.table;
  const rows = t.scoreboard;
  $('scoresTitle').textContent = S.ended ? 'Final results' : 'Scoreboard';
  $('scoreRows').innerHTML = rows.map((r, i) => `
    <tr class="${r.id === S.you ? 'mine' : ''}">
      <td>${i === 0 && r.net > 0 ? '🥇' : i + 1}</td>
      <td>${esc(r.name)}${r.left ? ' <span class="muted">(left)</span>' : ''}</td>
      <td>${r.buyIns} <span class="muted">(${fmt(r.buyIns * t.settings.buyIn)})</span></td>
      <td>${fmt(r.chips)}</td>
      <td class="${r.net > 0 ? 'up' : r.net < 0 ? 'down' : ''}">${signed(r.net)}</td>
      <td>${r.handsWon}</td>
    </tr>`).join('');

  if (S.ended) {
    const list = S.settlement.length
      ? S.settlement.map((x) => `<li><b>${esc(x.from)}</b> pays <b>${esc(x.to)}</b> <span class="amt">${fmt(x.amount)}</span></li>`).join('')
      : '<li>Everyone is even. Nobody pays anything.</li>';
    $('settle').innerHTML = `<h3>Who pays who</h3><ul class="settle">${list}</ul>`;
  } else {
    $('settle').innerHTML = S.ending ? '<p class="sheet-note">The game ends after this hand…</p>' : '';
  }

  const standingNames = rows.filter((r) => r.standing && !r.left).map((r) => esc(r.name));
  $('standupInfo').innerHTML = S.ended || !S.started ? ''
    : `🧍 Still standing (no hand won this round): <b>${standingNames.join(', ') || 'nobody'}</b>. The last one pays everyone €0.20.`;

  const inHand = t.handActive && mine?.inHand && !mine?.folded;
  $('buyinBtn').classList.toggle('hidden', S.ended || !mine);
  $('buyinBtn').disabled = Boolean(inHand);
  $('buyinBtn').title = inHand ? 'You can buy in once you are out of this hand' : '';
  $('endBtn').classList.toggle('hidden', !isHost || S.ended || S.ending || !S.started);

  if (S.ended && !shownEnd) {
    shownEnd = true;
    $('scores').classList.remove('hidden');
  }
}

function renderControls(mine, isHost) {
  const t = S.table;
  const o = t.options;
  const ready = t.seats.filter((p) => p && !p.sittingOut && p.chips > 0).length;
  const key = JSON.stringify([t.handNumber, t.phase, t.turn, o, S.started, S.ended, isHost, mine?.chips, mine?.sittingOut, mine?.folded, ready]);
  if (key === controlsKey) return; // don't reset the raise slider on unrelated updates
  controlsKey = key;
  const el = $('controls');

  if (!mine) { el.innerHTML = ''; return; }

  if (o) {
    const callLabel = o.canCheck ? 'Check' : o.toCall >= mine.chips ? `All-in ${fmt(o.toCall)}` : `Call ${fmt(o.toCall)}`;
    const verb = t.currentBet === 0 ? 'Bet' : 'Raise to';
    el.innerHTML = `
      <div class="actions">
        <button class="btn danger" data-act="fold">Fold</button>
        <button class="btn" data-act="${o.canCheck ? 'check' : 'call'}">${callLabel}</button>
        ${o.canRaise ? `<button class="btn primary" id="raiseBtn" data-act="raise"></button>` : ''}
      </div>
      ${o.canRaise ? `
      <div class="raise-box">
        <div class="presets">
          <button class="btn small" data-preset="min">Min</button>
          <button class="btn small" data-preset="half">½ Pot</button>
          <button class="btn small" data-preset="pot">Pot</button>
          <button class="btn small" data-preset="max">All-in</button>
        </div>
        <input type="range" id="raiseRange" min="${o.minRaiseTo}" max="${o.maxRaiseTo}" step="1" value="${o.minRaiseTo}">
        <span class="euro">€</span>
        <input type="number" id="raiseNum" min="${o.minRaiseTo / 100}" max="${o.maxRaiseTo / 100}" step="0.05">
      </div>` : ''}`;

    // Amounts are cents internally; the number box shows euros.
    const setRaise = (cents) => {
      cents = Math.max(o.minRaiseTo, Math.min(o.maxRaiseTo, Math.round(Number(cents)) || o.minRaiseTo));
      $('raiseRange').value = cents;
      $('raiseNum').value = (cents / 100).toFixed(2);
      $('raiseBtn').textContent = cents === o.maxRaiseTo ? `All-in ${fmt(cents)}` : `${verb} ${fmt(cents)}`;
      $('raiseBtn').dataset.amount = cents;
    };
    if (o.canRaise) {
      setRaise(o.minRaiseTo);
      $('raiseRange').oninput = (e) => setRaise(e.target.value);
      $('raiseNum').onchange = (e) => setRaise(Number(e.target.value) * 100);
      // Pot-sized raise = call, then raise by the size of the pot after calling.
      const potAfterCall = t.pot + o.toCall;
      const presets = {
        min: o.minRaiseTo,
        half: t.currentBet + Math.floor(potAfterCall / 2),
        pot: t.currentBet + potAfterCall,
        max: o.maxRaiseTo,
      };
      el.querySelectorAll('[data-preset]').forEach((b) => (b.onclick = () => setRaise(presets[b.dataset.preset])));
    }
    el.querySelectorAll('[data-act]').forEach((b) => {
      b.onclick = () => send('action', { type: b.dataset.act, amount: Number(b.dataset.amount) });
    });
    return;
  }

  let msg = '';
  let button = '';
  if (S.ended) {
    msg = 'The game has ended.';
    button = `<button class="btn primary" id="settleBtn">See who pays who</button>`;
  } else if (mine.sittingOut) {
    msg = "You're sitting out.";
    button = `<button class="btn primary" id="backBtn">I'm back</button>`;
  } else if (mine.chips === 0 && !(t.handActive && mine.inHand)) {
    msg = "You're out of money.";
    button = `<button class="btn primary" id="rebuyBtn">Buy in ${fmt(t.settings.buyIn)}</button>`;
  } else if (!S.started) {
    if (isHost) {
      msg = ready < 2 ? 'Waiting for at least one more player…' : `${ready} players ready.`;
      button = `<button class="btn primary" id="startBtn" ${ready < 2 ? 'disabled' : ''}>Start game</button>`;
    } else {
      msg = 'Waiting for the host to start the game…';
    }
  } else if (t.handActive) {
    const turnName = t.seats[t.turn]?.name;
    msg = mine.inHand && !mine.folded ? `Waiting for ${esc(turnName)}…` : 'Waiting for the next hand…';
  } else if (ready < 2) {
    msg = 'Waiting for more players…';
  }
  el.innerHTML = `${msg ? `<div class="msg">${msg}</div>` : ''}${button}`;
  if ($('backBtn')) $('backBtn').onclick = () => send('sitout', { value: false });
  if ($('rebuyBtn')) $('rebuyBtn').onclick = () => send('buyin');
  if ($('startBtn')) $('startBtn').onclick = () => send('start');
  if ($('settleBtn')) $('settleBtn').onclick = () => $('scores').classList.remove('hidden');
}

function tickTimer() {
  const bar = document.querySelector('.timer i');
  if (!bar || !S?.turnDeadline) return;
  const left = S.turnDeadline - (Date.now() + clockOffset);
  const pct = Math.max(0, Math.min(1, left / S.turnMs));
  bar.style.width = `${pct * 100}%`;
  bar.classList.toggle('low', left < 8000);
}
setInterval(tickTimer, 200);
