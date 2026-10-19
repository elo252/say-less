# Say Less

**The anonymous party game that makes everyone a sharper speaker.**
Jackbox-style: one screen on the TV, everyone plays on their phone. No app download.

Three modes, played in rotation:

| Mode | What players do | How it's scored |
|---|---|---|
| **The Missing Link** | Two random objects appear. Explain how they're connected (40 words max). | Votes for *Most Creative* and *Most Convincing* |
| **No 'Ums' Allowed** | Talk for 30–45 s on an absurd topic. The voice is disguised on playback. | Fluency points from a filler-word count + votes for *Most Entertaining*. Too many fillers = **BUST** (buzzer, 0 fluency points) |
| **One Line Pitch** | Squeeze something complicated into one sentence (20 words max). Read aloud by text-to-speech. | Votes for *Clearest & Funniest* |

Answers are revealed under random aliases ("Masked Penguin"), you can't vote for yourself, and after each round there's a short coach's tip.

---

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
npm install
npm start
```

1. On the laptop/TV, open **http://localhost:3000/host** and click **Create a room**.
2. Players scan the QR code (or type the address and 4-letter code) on their phones. Phones must be on the **same Wi-Fi** as the laptop.
3. Pick rounds and modes, then **Start the game**. You need at least 3 players.

### Voice rounds need an https link

Phones only allow the microphone on secure (https) pages. On a plain Wi-Fi address like `http://192.168.1.20:3000`, the text rounds work but "No 'Ums' Allowed" can't record (players can still type an answer instead).

Easiest fix — a free tunnel that gives you an https address:

```bash
# in a second terminal, with the game running
npx cloudflared tunnel --url http://localhost:3000
# or: ngrok http 3000
```

Then restart the game with that address so the QR code uses it:

```bash
PUBLIC_URL=https://your-tunnel-address.trycloudflare.com npm start
```

(On Windows PowerShell: `$env:PUBLIC_URL="https://..."; npm start`)

You can also deploy it to any Node host that supports WebSockets (Render, Railway, Fly.io) — those give you https automatically.

### Put it online (password protected)

The repo includes `render.yaml`, so it deploys to [Render](https://render.com)'s free tier in a few clicks:

1. Push this folder to a GitHub repo (private is fine).
2. On Render: **New → Blueprint**, pick the repo.
3. When asked, type a **GAME_PASSWORD** (and optionally an **OPENAI_API_KEY**), then **Apply**.
4. Open `https://<your-app>.onrender.com/host`. Render gives you https, so voice rounds work on phones.

With `GAME_PASSWORD` set, every page and every game connection requires the password. Each device enters it once (a 30-day cookie), and scanning the QR code brings players straight back to the room after they type it. Change the password in Render's environment settings to sign everyone out. Locally, password protection is off unless you set `GAME_PASSWORD`.

Free Render apps go to sleep after ~15 minutes of no traffic; the first visit after that takes about a minute to wake up. Open the host page a minute before you play.

### Filler-word counting

- **Default (free):** the phone's built-in speech recognition (Chrome on Android, Safari on iPhone) transcribes while you talk and counts the ums live. It sometimes tidies fillers away, so counts can run low.
- **Better:** set an OpenAI API key and the server transcribes each clip with Whisper, using a prompt that nudges it to keep fillers:

  ```bash
  OPENAI_API_KEY=sk-... npm start
  ```

  Research suggests Whisper also tends to drop fillers by default, so **test this with a few real recordings before trusting the scores.**
- If neither produces a transcript, the clip still plays and gets votes; it just isn't scored for fluency (and never busts).

The bust rule is per minute: at least 3 fillers **and** more than 5 per minute (the rough point where research finds audiences start marking speakers down). Change it with `BUST_PER_MIN`.

---

## Settings

| Environment variable | Default | What it does |
|---|---|---|
| `PORT` | `3000` | Port to listen on |
| `PUBLIC_URL` | — | Address the QR code points to (use your https tunnel/deploy URL) |
| `GAME_PASSWORD` | — | Turns on the site-wide password |
| `SESSION_SECRET` | — | Optional extra secret for the login cookie (Render generates one) |
| `OPENAI_API_KEY` | — | Turns on Whisper transcription |
| `TRANSCRIBE_MODEL` | `whisper-1` | Transcription model to use |
| `MIN_PLAYERS` | `3` | Players needed to start (set to `2` for quick testing) |
| `BUST_PER_MIN` | `5` | Fillers per minute that trigger a bust |

In the lobby the host can choose 3/6/9 rounds, which modes to play, the voice disguise (random, helium, deep, robot, off), and whether authors are revealed after voting or stay anonymous.

---

## How it's built

```
server.js            Express + Socket.io server, QR codes, routes events to the game
src/auth.js          Optional password gate (GAME_PASSWORD)
render.yaml          One-click deploy config for Render
src/game.js          All game rules: rounds, timers, anonymity, voting, scoring
src/prompts.js       Prompt decks — add your own lines here
src/transcribe.js    Optional Whisper transcription
public/host.html/js  TV screen: lobby, reveals with voice disguise + text-to-speech, results
public/index.html    Phone screen (player.js): join, type/record, vote
public/fillers.js    Filler detection + fluency scoring (shared by server and phones)
public/style.css     All styling
test/                Rule tests + a full simulated game over real sockets
```

- **Anonymity:** the server never sends author names to any screen until the results phase (and not at all if "Stay anonymous" is on). Each round gets fresh aliases, so you can't track someone across rounds.
- **Voice disguise:** done on the TV with the Web Audio API — pitch up/down, or ring-modulated "robot". The original recording never plays undisguised unless the host turns disguise off.
- **State:** rooms live in memory on one server. Restarting the server ends all games. Phones and the host can reload mid-game and rejoin.

Run the tests:

```bash
npm test
```

## Not built yet (good next steps)

- "Guess the Speaker" bonus round
- Saving each player's filler rate over time so they can see progress (the "measurable" part of the pitch)
- Accounts, team/classroom dashboards, more prompt packs
- A proper pitch-shifter that changes pitch without changing speed
