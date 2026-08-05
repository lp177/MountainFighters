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
  shields, a Cybertruck door. Vehicle sections when walking gets boring.
- **Local multiplayer** on one keyboard or with gamepads, up to four players.
- **Online multiplayer** by sending a link. Your friend clicks it, picks a
  dwarf, and is in the fight. That is the entire flow — from the home screen or
  from the pause menu mid-game.

## Controls

| Action | Player 1 | Player 2 | Gamepad |
| --- | --- | --- | --- |
| Move | `WASD` | Arrows | Left stick / d-pad |
| Light attack | `F` | `Numpad 1` | A / ✕ |
| Heavy attack | `G` | `Numpad 2` | B / ○ |
| Jump | `Space` | `Numpad 0` | X / □ |
| Special | `H` | `Numpad 3` | Y / △ |
| Block | `Shift` | `Numpad .` | RB / R1 |
| Grab | `R` | `Numpad 5` | LB / L1 |
| Super | `T` | `Numpad +` | RT / R2 |
| Pause | `Esc` | `Esc` | Start |

Double-tap a direction to dash. Block just as a hit lands to parry.

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
game server and no infrastructure to run — peers talk directly to each other and
the broker is only used for the initial handshake. If you would rather run your
own, point `NetConfig.host` at a self-hosted PeerServer.

## On the satire

This game is rude on purpose. It is political satire of public figures, in the
tradition of every editorial cartoon ever drawn, and it is not subtle about it.

## Licence

MIT.
