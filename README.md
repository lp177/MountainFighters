# ⛏️ Mountain Fighters

**Seven dwarfs. One billionaire. One very bad idea.**

Elon Musk has kidnapped Snow White. He intends to dissect her and work out why
everybody loves her and everybody hates her at the same time — and then build a
perfect robot clone of her, get it crowned queen of the world, and use the job
to rubber-stamp every scheme he has ever had.

The dwarfs have put down the pickaxes, put on the leather, and gone to work.

A satirical browser beat-em-up. Street Fighter's combat depth in a Final Fight
chassis, with a great deal of screen shake.

▶ **[Play it](https://lp177.github.io/mountainfighters/)**

---

## What it is

- **70 maps**, a boss every fifth one — a developer, a Shiba Inu, an autonomous
  car, Donald Trump, and ten more, ending with the man himself.
- **7 playable dwarfs**, each with their own moveset, weapon and ultimate.
  Pick one and watch him swap the tunic for a spiked leather jacket and
  sunglasses. The hat stays on.
- **Enemies** worth punching: suited guards with earpieces, taser goons,
  riot shields, security robots, autonomous vacuums, IoT fridges that fight
  back, delivery drones, unpaid interns, and lobbyists.
- **Weapons get dropped and picked up** — chains, bats, iron bars, riot
  shields, a Cybertruck door. One key takes what is at your feet, and pressing
  it over something better trades the two, so being armed never means being
  stuck with what you are holding.
- **Eleven of the seventy maps park something with an engine** in your way — a
  bike, a Cybertruck, a hyperloop pod, a rocket. Same key to get on, same key to
  get off. Riding is roughly twice a run, and running a guard over does more
  than punching him would.
- **An opening cinematic** that shows you the kidnapping rather than
  explaining it: the cottage, the headlights, the door coming off its hinges,
  the lab, and seven dwarfs putting on the leather. Skippable, and it only
  plays once.
- **Local multiplayer** on one keyboard or with gamepads, up to four players.
- **Online multiplayer** by sending a link. Your friend clicks it, picks a
  dwarf, and is in the fight. That is the entire flow — from the home screen or
  from the pause menu mid-game.

## Controls

| Action | Player 1 | Player 2 | Gamepad |
| --- | --- | --- | --- |
| Move | `WASD` — `ZQSD` on AZERTY | Arrows | Left stick / d-pad |
| Light attack | `F` | `Numpad 1` | A / ✕ |
| Heavy attack | `G` | `Numpad 2` | B / ○ |
| Jump | `Space` | `Numpad 0` | X / □ |
| Special | `H` | `Numpad 3` | Y / △ |
| Block | `Shift` | `Numpad .` | RB / R1 |
| Grab | `R` | `Numpad 5` | LB / L1 |
| Pick up / Use | `E` | `Numpad 4` | LT / L2 / ZL |
| Super | `T` | `Numpad +` | RT / R2 / ZR |
| Pause | `Esc` | `Esc` | Start |

Double-tap a direction to dash. Block just as a hit lands to parry.

**Pick up / Use** is one key for everything at your feet: take the weapon lying
there, trade the one in your hands for it, get on the bike, get off the bike,
or — with nothing in reach — put down what you are carrying. When there is
something to press it on, the key and what it would do float above your dwarf's
head, named the way your own keyboard or your own pad names it.

**Those are key positions, not letters.** Every binding is stored by where the
key physically sits on the board, so the movement diamond is the same four keys
under the same four fingers whatever your keyboard is: `ZQSD` on a French
AZERTY, `WASD` on a US QWERTY, `WASD` with Y and Z swapped elsewhere on a German
QWERTZ. Nobody has to configure anything and nothing has to be detected for the
game to play correctly.

Labels are a different matter, and the game does not guess at those if it can
help it: it asks the browser what is actually engraved on your keys and prints
that. On browsers that refuse to say (Firefox, Safari) it infers a layout from
your language and admits in the menu that it is assuming.

And if any of it is wrong, or you simply want Jump somewhere else: **every key
is rebindable** in Controls, from the title screen or from the pause menu
mid-fight. Rebinds apply immediately — walk out of the pause menu and the new
key is already the key.

## Running it

```bash
npm install
npm run dev      # http://localhost:5173
npm run build    # outputs to docs/ for GitHub Pages
```

## Notable constraints

This repository contains **no image files and no audio files.** Every character,
prop, backdrop and effect is vector geometry drawn from a skeletal rig at
runtime, and every sound — punches, gunshots, the music — is synthesised with
WebAudio. That is a deliberate constraint, and it is why the art has a
consistent house style and the whole game downloads in a couple of hundred
kilobytes.

The simulation is deterministic at a fixed 60Hz, which is what makes lockstep
netcode possible without a game server. See
[ARCHITECTURE.md](ARCHITECTURE.md) for how it all fits together.

## Multiplayer, technically

WebRTC data channels, brokered by the public PeerJS cloud server. There is no
game server — peers talk directly to each other and the broker is only used for
the initial handshake. If you would rather run your own, point `NetConfig.host`
at a self-hosted PeerServer.

**You almost certainly need a TURN relay.** Peer-to-peer only works when at
least one side's network will accept an inbound packet at a predictable
address. On a LAN that is always true. Across the internet it is a coin flip,
and on mobile or carrier-grade-NAT connections it essentially never works — ICE
fails with *"add a TURN server"* and the two players never meet. STUN cannot fix
this; it only reports your own public address. A TURN server relays the traffic
when a direct route does not exist.

The game fetches short-lived relay credentials at runtime from `/ice`, so
nothing secret is baked into the bundle — the credential a player can read out
of devtools expires in a couple of hours. Point `VITE_ICE_ENDPOINT` at your own
issuer, or set a static `VITE_TURN_*` in `.env` (see `.env.example`) if you
would rather configure one directly.

A room keeps the grant its Peer was created with. If a lobby is deliberately
left open longer than the issuer's credential TTL (two hours on the default
endpoint), recreate the room before accepting new players.

Before a match starts, the host measures the actual gameplay lane and negotiates
an input buffer large enough for its RTT and jitter. Input packets travel on a
separate unordered data channel while lobby and scene state stays ordered. The
lobby shows whether that lane selected direct P2P or TURN and, for a relay, UDP
or TCP. Match epochs reject late packets from a previous fight, and the opening
frames stay ordered behind the start handshake. TURN/UDP is strongly preferred
for play; TURN/TCP is a reachability fallback and needs a larger buffer. Very
distant routes can therefore remain smooth but will still feel delayed; hiding
that physical latency requires rollback/prediction.

If no relay can be reached, the game falls back to STUN and still works on a LAN
and between permissive networks, and says so plainly instead of hanging.

## On the satire

This game is rude on purpose. It is political satire of public figures, in the
tradition of every editorial cartoon ever drawn, and it is not subtle about it.

## Licence

MIT.
