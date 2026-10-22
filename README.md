# Pocket Poker

Online no-limit Texas Hold'em for friends. One person creates a table, shares the
5-letter code or invite link, and up to 9 people play. Amounts are shown in euros, but it's
play money only. Players can turn on their camera and mic for a FaceTime-style video call
right at the table.

## Run it on your computer

```bash
npm install
npm start
```

Open http://localhost:3000. To try it with two players on one PC, open the second
player at http://127.0.0.1:3000. It counts as a different browser, so you get a separate seat.

## Run the tests

```bash
npm test
```

These cover hand rankings, blinds and action order, minimum raises, side pots, and
300 randomized games that check no chips are ever created or lost.

## Put it online (Render, free)

1. Push this folder to a new GitHub repository.
2. Go to https://dashboard.render.com, click **New → Blueprint**, and pick the repository.
   Render reads `render.yaml` and sets everything up.
3. When it finishes you get a URL like `https://pocket-poker.onrender.com`. Send that to friends.

Things to know about the free plan:
- The server sleeps after 15 minutes with no visitors. The first visit after that takes ~30-60 seconds to wake it.
- Tables live in memory, so a restart or redeploy ends any games in progress.

Vercel won't work for this. It can't keep the live connections a card game needs open.

### Video calls
- Cameras only work over **https** (Render gives you that) or on `localhost`.
- Video goes directly between players' browsers. That keeps it free, but on some strict
  networks (some offices, some mobile carriers) two players may not be able to see each other.
  The fix is a TURN relay server, for example a free account at https://www.metered.ca/stun-turn.
  Put its details in a Render environment variable named `ICE_SERVERS`, like:
  `[{"urls":"stun:stun.l.google.com:19302"},{"urls":"turn:YOUR-HOST:443","username":"...","credential":"..."}]`
- Everyone connects to everyone, so a full 9-player table with all cameras on is heavy on
  phones. It works best with up to about 6 cameras.

## How it works

| File | What it does |
|---|---|
| `engine/cards.js` | Deck, shuffle (crypto-random), best-5-of-7 hand evaluator |
| `engine/table.js` | Game rules: blinds, betting rounds, min-raise, side pots, showdown |
| `server.js` | Express + Socket.IO: room codes, turn timers, reconnects, video call setup |
| `public/app.js` | The table UI |
| `public/video.js` | Camera/mic and the WebRTC video connections between players |

The server holds the deck and every player's cards. Each browser only receives its
own hole cards (plus any cards shown at showdown), so nobody can peek using dev tools.

## Table rules

- 30 seconds to act. If you time out you auto-check, or auto-fold and are sat out.
- Refreshing the page or losing connection keeps your seat. You'll rejoin automatically.
- Players who run out of money can rebuy for the starting stack.
- Tap **Camera** to join the video call, **Mute** to silence your mic, and click anyone's video to see it big.
- The next hand deals automatically 5 seconds after the last one ends.
