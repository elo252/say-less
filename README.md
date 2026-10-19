# Say Less

**The anonymous party game that makes everyone a sharper speaker.**
Everyone plays on their own phone — including the host. No app download, no TV needed.

Two modes, played in rotation:

| Mode | What players do | Votes for |
|---|---|---|
| **The Missing Link** | Two random objects appear. Explain how they're connected (40 words max). | *Most Creative* and *Most Convincing* |
| **One Line Pitch** | Squeeze something complicated into one sentence (20 words max). | *Clearest & Funniest* |

Answers are shown under random aliases ("Masked Penguin"), you can't vote for your own, and every round ends with a coach's tip. Each vote is worth 100 points, and winning a category adds 100 more.

## How a game works

1. **Host:** open the site, type your name, tap **Create a room**. You're player #1 and you also get the host controls.
2. **Everyone else:** scan the QR code on the host's phone (or use **Share invite link**), or open the site and type the 4-letter room code.
3. With **at least 3 players** (the host counts), the host taps **Start the game**. A game is 6 rounds.
4. Each round: everyone answers → everyone votes → results and scores. The host taps **Next round**.

If the host's phone drops out for more than 45 seconds, the host controls pass to the next player automatically.

---

## Run it on your computer

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

Open **http://localhost:3000**. Phones on the same Wi-Fi can join at the address printed in the terminal.

## Put it online (password protected)

The repo includes `render.yaml` for [Render](https://render.com)'s free tier. With `GAME_PASSWORD` set, every page and every game connection needs the password; each device enters it once (a 30-day cookie). With `REQUIRE_PASSWORD=true` and no password set, the whole site stays closed.

Free Render apps sleep after ~15 minutes without visitors; the first visit after that takes about a minute.

---

## The prompt bank

Everything players see comes from plain lists in `src/bank/` — edit them freely:

| File | What's in it | Variety |
|---|---|---|
| `objects.js` | Things for The Missing Link | ~290 objects → 42,000+ pairs |
| `pitch.js` | "Summarize…" prompts, plus concepts × audiences for "Explain X to Y" | 80 summaries + ~8,000 combinations |
| `tips.js` | Coach's tips shown after each round | 12 per mode |
| `aliases.js` | Anonymous names and avatars | 30 × 30 aliases |

Prompts never repeat within a game. Nothing in the game uses AI.

## Settings

| Environment variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `GAME_PASSWORD` | — | Turns on the site-wide password |
| `REQUIRE_PASSWORD` | — | `true` keeps the site closed until `GAME_PASSWORD` is set |
| `SESSION_SECRET` | — | Optional extra secret for the login cookie |
| `MIN_PLAYERS` | `3` | Players needed to start, host included |
| `ROUNDS` | `6` | Rounds per game |
| `PUBLIC_URL` | — | Address the invite QR code points to (only needed behind a tunnel) |

In the lobby the host can turn either mode off and choose whether names are revealed after voting or stay anonymous.

## How it's built

```
server.js            Express + Socket.io server, QR codes, routes events to the game
src/game.js          All game rules: rooms, host, rounds, timers, anonymity, voting, scoring
src/prompts.js       Draws prompts from the bank without repeats
src/bank/            The prompt bank
src/auth.js          Optional password gate
public/index.html    The one screen everyone uses (player.js), styled by style.css
test/                Rule tests, a full simulated game, and password tests
render.yaml          Deploy config for Render
```

Rooms live in memory, so restarting or redeploying the server ends games in progress. Phones can reload mid-game and rejoin.

```bash
npm test
```
