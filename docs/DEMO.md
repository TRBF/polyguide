# PolyGuide — demo script (3–4 minutes)

## Before the judges arrive (10 minutes)

1. Laptop: start the servers (server on 8787, web on 5174) and the tunnel (`ngrok http 5174`). Keep the laptop
   awake and plugged in.
2. Phone: open the ngrok link, tap **Visit Site**, tap **Start**, allow microphone, camera and motion.
3. Say **"system check"**. Everything should be green; each warning says what still works without it.
4. Presenting without walking? Open the link with **`?demo`** at the end (or Settings → **Demo walk**). The route
   then advances at walking pace by itself and elevator rides go through the floor sensor. The screen shows
   **DEMO · simulated walk**: say so to the judges, it is a feature, not a trick.
5. Volume up. Phone on the table facing the judges, or held at chest height.

## The story (say this)

> "1 in 4 students has a disability. ETH's main building has 15 floors and half floors, 580 rooms, and its
> signs are tiny plates beside doors. PolyGuide gets a blind or wheelchair user from any room to any room, by
> voice, with the phone's camera and sensors, and it is honest when it is unsure."

## Run of show

| # | Do / say | What the judges see and hear |
|---|----------|------------------------------|
| 1 | Tap **Start** | One tap starts everything; the app greets and listens. |
| 2 | "**I use a wheelchair**" | Needs set; routes avoid stairs. |
| 3 | "**I'm at the main entrance, take me to the Audimax**" | One sentence fills From and To and asks "Is that right?". |
| 4 | "**Yes**" | "Starting. 79 metres, about 2 minutes. No stairs. Uses 1 elevator." Navigation view opens over the live camera. |
| 5 | Wait (demo walk) | Steps advance, each new step vibrates its pattern (2 = left, 3 = right, long = floor change). |
| 6 | Elevator step | After the "ride", the floor sensor finishes the step: "You are on floor F." |
| 7 | "**Where am I?**" | One spoken sentence: floor, the room at hand, the nearest elevator and toilet. |
| 8 | "**Speak slower**", "**turn off vibration**" | Settings change by voice alone, instantly. |
| 9 | "**New route**" | Keeps where you are, asks where to go next. |
| 10 | Tap **Toilet** | Nearest step-free toilet, one tap. |
| 11 | Settings → **Run system check** (or say it) | Every part tested live with timings. |

Optional, if a room sign is at hand: point the camera at it and say "**where am I?**". It reads the sign, checks
the room number against where you probably are and the floor letter against the floor sensor (an "E 33" read
on floor F becomes F 33), and asks before trusting a big jump.

## Phrases that work (tested)

- Trips: "I'm in F 7, take me to F 30", "take me to the nearest toilet", "nearest exit", "number two".
- Walking: "next", "back", "repeat", "where am I", "what's ahead", "stop", "the elevator is not working".
- Settings: "speak slower/faster", "turn off vibration", "stop the beeping", "bigger text", "voice only mode",
  "speak German", "what are my settings".
- Anytime: "new route", "start over", "system check", "emergency".

## If something fails

| Problem | What to do | What still works |
|---------|------------|------------------|
| eduroam blocks or drops | Phone hotspot from a second phone; reload the ngrok link. | — |
| ngrok fails (Avast) | Present on the laptop: Chrome → DevTools → device toolbar (iPhone), `http://localhost:5174`. | Everything except phone sensors. |
| AI slow or down | Keep talking: commands fall back to on-device parsing; buttons do everything. | Routing, navigation, settings, haptics. |
| Microphone blocked | Tap the keyboard button and type the same sentences. | Everything. |
| Camera not allowed | Skip the camera part; say "I'm at F 33" to set the position. | Everything else. |
| Tracking drifts on a real walk | Say "next" at each step, or switch on Demo walk. | Everything. |
| Wrong floor after an elevator | The app says so; say "I'm on floor F" or "next". | — |

## Honest limits (if asked)

- Phone browsers do not expose the barometer, so floors come from elevator-ride acceleration, stairs counted by
  steps, and GPS altitude when available. A native wrapper would give the real barometer.
- Indoor position is the route plus checkpoints (signs, user's word, floor sensor). One camera reading never
  moves the user far or to another floor on its own: a second witness is required.
- Wheelchair reachability in ETH's own data is ~81 %; 56 half-floor rooms are stairs-only there, and the app says so.
