# Pocket Poker

Online no-limit Texas Hold'em for friends. One person creates a table, shares the
5-letter code or invite link, and up to 9 people play. Everything is in euros, and the game
keeps track of buy-ins and works out who pays whom at the end. The app never moves real
money; you settle up yourselves.

## House rules

- **Buy-in:** €5. Buy in again as often as you like (any time you're not in a hand).
- **Blinds:** €0.05 / €0.10.
- **7/2 bonus:** win a hand holding 7-2 (any suits) and every other player in the hand pays you €0.30.
- **6/7 bonus:** win a hand holding 6-7 and every other player in the hand pays you €0.20.
  Bonuses count even if everyone folds to you; your cards are turned face up so everyone sees them.
- **Stand-up:** everyone starts "standing" (🧍). Winning a hand sits you down. The last player
  still standing pays €0.20 to every other player, then everyone stands up again.
- Bonus and stand-up payments come straight out of chip stacks. If someone has less than
  they owe, they pay what they have.
- 30 seconds to act. If you time out you auto-check, or auto-fold and are sat out.
- Refreshing the page or losing connection keeps your seat. If you leave and come back under
  the same name, you sit down with the stack you left with.

## Scoreboard and settling up

Tap **🏆 Scores** at the table to see everyone's buy-ins, current stack, profit, and hands won,
sorted by who's up the most. When the host presses **End game & settle up**, the current hand
finishes, no more hands are dealt, and everyone sees the list of who pays who and how much,
using as few payments as possible.

## Run it on your computer

```bash
npm install
npm start
```

Open http://localhost:3000. To try it with more players on one PC, open the extra players at
http://127.0.0.1:3000 and http://[::1]:3000. They count as different browsers, so each gets its own seat.

## Run the tests

```bash
npm test
```

These cover hand rankings, blinds and action order, minimum raises, side pots, the 7/2 and 6/7
bonuses, the stand-up game, buy-ins and settling up, and 300 randomized games that check no
money is ever created or lost.

## Put it online (Render, free)

1. Push this folder to a new GitHub repository.
2. Go to https://dashboard.render.com, click **New → Blueprint**, and pick the repository.
   Render reads `render.yaml` and sets everything up.
3. When it finishes you get a URL like `https://pocket-poker.onrender.com`. Send that to friends.

Things to know about the free plan:
- The server sleeps after 15 minutes with no visitors. The first visit after that takes ~30-60 seconds to wake it.
- Tables live in memory, so a restart or redeploy ends any games in progress, including the scoreboard.

Vercel won't work for this. It can't keep the live connections a card game needs open.

## How it works

| File | What it does |
|---|---|
| `engine/cards.js` | Deck, shuffle (crypto-random), best-5-of-7 hand evaluator |
| `engine/table.js` | Game rules: blinds, betting, side pots, showdown, bonuses, stand-up, buy-ins, settle-up |
| `server.js` | Express + Socket.IO: room codes, turn timers, reconnects, ending the game |
| `public/app.js` | The table UI and scoreboard |

All amounts are stored as whole euro cents. The server holds the deck and every player's
cards. Each browser only receives its own hole cards (plus any cards shown), so nobody can
peek using dev tools.
