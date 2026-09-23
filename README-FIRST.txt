BONDI — REAL ONLINE MULTIPLAYER v2.0
====================================

Cloudflare Workers + Durable Objects multiplayer build for 2–10 real players.

CORE RULES INCLUDED
- Standard 52-card deck, dealt one card at a time.
- Game 1: holder of A♠ starts, but may lead any card.
- Games 2–10: previous game's BONDI (0 points) starts.
- ALL PLAY proceeds ANTICLOCKWISE.
- If a player has the led suit, they must follow it.
- First off-suit card stops the trick immediately.
- BONDI resolution: highest card of the led suit picks up the complete Bustle.
- HINGAIFI resolution: if everyone follows, all played cards are discarded and the highest led-suit card leads next.
- Suit-break cards remain visible briefly so all players can clearly see the break card and winning led-suit card.
- A player who plays a last card finishes only after the trick resolves and only if they still have zero cards.
- Multiple normal finishers are ordered by the order their final cards were played.
- Whole-hand rule: only BETWEEN tricks, before a new suit is led. If a player has 1–5 cards, the immediately next active player anticlockwise from that player may take the entire hand. The player giving the hand finishes immediately.
- Whole-hand transfer is optional and completed before the next trick can begin.
- Finished players are skipped in turn order.
- Scoring with N players: 1st = N−1 points down to BONDI/last = 0.
- 10 games per match. Equal final totals are tied.

ONLINE FEATURES
- 5-character room code and shareable link.
- 2–10 real players.
- Private hands: each browser receives only its own cards.
- Server-authoritative legal move validation.
- Player icons show cards remaining and online/offline state.
- Anticlockwise table arrangement around each player's own seat.
- Leave Room control. During an active match the seat is reserved for reconnection.
- Host control transfers if the host intentionally leaves.
- Host cannot start a game while a seated player is offline.
- 10-game scoreboard and final tied-winner handling.
- Rules panel built into the game.

UPDATE YOUR EXISTING GITHUB / CLOUDFLARE APP
If your bondi-online repository is already connected to Cloudflare, replace these four files:
  public/index.html
  public/style.css
  public/app.js
  src/index.js
Then commit the changes. Cloudflare should deploy automatically.

FRESH DEPLOYMENT FROM GITHUB (NO NODE.JS ON YOUR PC)
1. Create/open a GitHub repository.
2. Upload all files from this package.
3. In Cloudflare Workers & Pages choose Import a repository.
4. Select the GitHub repository.
5. Leave Build command blank.
6. Deploy command: npx wrangler deploy
7. Deploy.

LOCAL/COMMAND-LINE DEPLOYMENT
- DEPLOY-BONDI.bat deploys from Windows if Node.js is installed.
- LOCAL-TEST.bat starts Wrangler locally for testing.

IMPORTANT
This is the current full play-test build. Test it with your actual BONDI group before treating it as a final public release.
