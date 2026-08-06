/**
 * Fourteen bosses, one every fifth map, ending with the man himself on 70.
 *
 * Each boss is a stack of phases. A phase begins the moment health drops below
 * its `healthThreshold`, swaps the move pool, raises aggression, optionally
 * dumps adds on the floor, and barks a line. Phases are listed high threshold
 * first; the first entry is the opening phase and is always at 1.0.
 *
 * ── HOW A PHASE POOL IS READ ────────────────────────────────────────────────
 *
 * `Level.enterPhase` binds a phase's moves POSITIONALLY, through `moveSet()`:
 *
 *     moves[0] → light   (also grab, and the air light)
 *     moves[1] → heavy   (also the dash attack, and the air heavy)
 *     moves[2] → special (the ranged / set-piece slot)
 *
 * Nothing past index 2 is bound to a button, so a pool is exactly three ids
 * long and the ORDER is the design. Index 0 is what you will see most — it
 * wants to be fast and unmistakably this boss. Index 1 is the one that hurts,
 * and the one the AI reaches for at the edge of its range and out of a dash.
 * Index 2 is the set-piece the boss is remembered for.
 *
 * ── OWN KIT FIRST ───────────────────────────────────────────────────────────
 *
 * Every boss leads with moves nobody else opens with (`b_dev_*`, `b_bite`,
 * `b_fsd_lanechange`, `b_flame`, …). The shared verbs — b_slam, b_charge,
 * b_sweep, b_grab, b_stomp, b_beam, b_projectile, b_summon, b_shockwave,
 * b_dash, b_uppercut, b_spin, b_leap, b_rage, b_taunt — are still common
 * vocabulary and are used deliberately, as the sentence a boss reaches for
 * when it has run out of its own ideas. They are not the default.
 *
 * Escalation between phases is a change of KIND, not a change of number: the
 * slow signature move is promoted into the light slot, a heavier signature
 * takes over the heavy, and the set-piece becomes something the fight has not
 * had to answer yet. Aggression rises too, but it is never the whole story.
 */

import type { BossDef } from '@/core/types';
import { BOSS_EVERY } from '@/core/constants';

export const BOSSES: BossDef[] = [
  // ── 5 ──────────────────────────────────────────────────────────────────────
  {
    id: 'dev',
    name: 'CRUNCH',
    quote:
      '"I have been awake for four days and I am shipping this whether it works or not."',
    atMap: 5,
    health: 320,
    style: {
      scale: 1.3,
      girth: 0.92,
      headSize: 0.94,
      beardLength: 0.9,
      beardStyle: 'bushy',
      skin: '#d9ad8c',
      skinShade: '#a37c5c',
      hair: '#2e2622',
      hatColor: '#1d2430',
      tunicColor: '#22303f',
      jacketColor: '#182230',
      jacketAccent: '#8be0c8',
      spikes: 0,
      shades: false,
      outfit: 1,
      tattoo: 'barcode',
      cigar: false,
    },
    rigOverride: 'humanoid',
    // Ships, breaks it, blames the room. The laptop swing is the whole first
    // phase; the standup is the whole second one, because a boss whose gimmick
    // is process should be able to take your turn away without touching you.
    phases: [
      {
        healthThreshold: 1.0,
        moves: ['b_dev_ship', 'b_dev_hotfix', 'b_dev_deploy'],
        aggression: 0.55,
        bark: 'It works on my machine. Get off my machine.',
      },
      {
        // Escalation: he stops fixing and starts holding meetings, and the
        // interns arrive to do the actual hitting.
        healthThreshold: 0.55,
        moves: ['b_dev_ship', 'b_dev_standup', 'b_summon'],
        aggression: 0.8,
        spawns: [{ kind: 'intern', count: 3 }],
        bark: 'I am escalating this. INTERNS. ON ME.',
      },
      {
        // The hotfix — regression hitbox and all — is now his FAST button, and
        // he has given up debugging in favour of running at you.
        healthThreshold: 0.22,
        moves: ['b_dev_hotfix', 'b_charge', 'b_dev_deploy'],
        aggression: 1.0,
        bark: 'FOURTEEN MONTHS OF MY LIFE. FOURTEEN. MONTHS.',
      },
    ],
    points: 2000,
    music: 'boss',
  },

  // ── 10 ─────────────────────────────────────────────────────────────────────
  {
    id: 'shiba',
    name: 'SHIBA INU',
    quote: '"much security. very bite. wow."',
    atMap: 10,
    health: 430,
    style: {
      scale: 1.7,
      girth: 1.4,
      headSize: 1.2,
      beardLength: 0,
      beardStyle: 'none',
      skin: '#e8a648',
      skinShade: '#b8792c',
      hair: '#f6e4c8',
      hatColor: '#e8a648',
      tunicColor: '#f6e4c8',
      jacketColor: '#c98a34',
      jacketAccent: '#ffd166',
      spikes: 3,
      shades: false,
      outfit: 1,
      tattoo: 'none',
      cigar: false,
    },
    rigOverride: 'shiba',
    // Low, fast, and never where you swung. Almost everything he owns hits low
    // and moves him through the depth axis, so blocking high and standing on
    // one plane are both wrong all fight.
    phases: [
      {
        healthThreshold: 1.0,
        moves: ['b_bite', 'b_shiba_zoom', 'b_sweep'],
        aggression: 0.7,
        bark: 'such perimeter. do not approach.',
      },
      {
        // Escalation: he stops running past you and starts going UNDER you.
        // Digging is invulnerable through most of its startup, so the phase is
        // about reading the dirt rather than out-spacing him.
        healthThreshold: 0.6,
        moves: ['b_bite', 'b_shiba_dig', 'b_shiba_zoom'],
        aggression: 0.9,
        spawns: [{ kind: 'vacuum_bot', count: 4 }],
        bark: 'many friend. all round. all fast.',
      },
      {
        // No more evasion. Full send, teeth first, in a straight line.
        healthThreshold: 0.25,
        moves: ['b_bite', 'b_rush', 'b_leap'],
        aggression: 1.0,
        bark: 'no more meme. only teeth.',
      },
    ],
    points: 3200,
    music: 'boss',
  },

  // ── 15 ─────────────────────────────────────────────────────────────────────
  {
    id: 'blue_check',
    name: 'THE BLUE TICK',
    quote: '"Eight dollars a month buys you the right to be wrong loudly."',
    atMap: 15,
    health: 520,
    style: {
      scale: 1.32,
      girth: 1.08,
      headSize: 0.9,
      beardLength: 0.25,
      beardStyle: 'stubble',
      skin: '#dcae88',
      skinShade: '#a87e58',
      hair: '#241c16',
      hatColor: '#1d9bf0',
      tunicColor: '#12283a',
      jacketColor: '#0d1b28',
      jacketAccent: '#1d9bf0',
      spikes: 2,
      shades: true,
      outfit: 1,
      tattoo: 'barcode',
      cigar: false,
    },
    rigOverride: 'humanoid',
    phases: [
      {
        healthThreshold: 1.0,
        moves: ['b_check_ratio', 'b_tweet', 'b_dash'],
        aggression: 0.6,
        bark: 'Source? You are unverified. Your opinion does not load.',
      },
      {
        // Escalation: he stops posting at you and starts posting ABOUT you.
        // The heavy is now a quote-post that lands other people on your head.
        healthThreshold: 0.62,
        moves: ['b_check_ratio', 'b_check_dogpile', 'b_tweet'],
        aggression: 0.82,
        spawns: [{ kind: 'lobbyist', count: 2 }, { kind: 'intern', count: 2 }],
        bark: 'Ratioed? RATIOED? I will buy the ratio.',
      },
      {
        // He owns the pipe, so the pipe becomes the weapon: posting is now his
        // fastest button and the timeline itself is the heavy.
        healthThreshold: 0.3,
        moves: ['b_tweet', 'b_beam', 'b_check_dogpile'],
        aggression: 1.0,
        bark: 'I am rate-limiting this entire building.',
      },
    ],
    points: 4200,
    music: 'boss',
  },

  // ── 20 ─────────────────────────────────────────────────────────────────────
  {
    id: 'fsd',
    name: 'TESLA',
    quote: '"Full self-driving. Supervised. Beta. Do not sue. Accelerating."',
    atMap: 20,
    health: 660,
    style: {
      scale: 2.1,
      girth: 2.0,
      headSize: 0.45,
      beardLength: 0,
      beardStyle: 'none',
      skin: '#c6ccd4',
      skinShade: '#8d949d',
      hair: '#22262e',
      hatColor: '#aeb5bd',
      tunicColor: '#d6dbe1',
      jacketColor: '#9aa2ab',
      jacketAccent: '#ff3b30',
      spikes: 4,
      shades: false,
      outfit: 1,
      tattoo: 'barcode',
      cigar: false,
    },
    rigOverride: 'cybertruck',
    // The whole boss is one joke told with frame data: it indicates, it drifts
    // politely toward the lane it signalled, and then the vehicle goes the
    // other way. The indicator is never a lie about the timing, only about the
    // direction, which is what makes it learnable instead of cheap.
    phases: [
      {
        healthThreshold: 1.0,
        moves: ['b_fsd_doorping', 'b_fsd_lanechange', 'b_charge'],
        aggression: 0.75,
        bark: 'Obstacle classified as: not an obstacle. Proceeding.',
      },
      {
        // Escalation: it has lost the route entirely, so it reverses over
        // whoever was behind it before lurching forward again. Two wrong
        // directions instead of one.
        healthThreshold: 0.66,
        moves: ['b_fsd_doorping', 'b_fsd_reroute', 'b_projectile'],
        aggression: 0.9,
        spawns: [{ kind: 'delivery_drone', count: 3 }],
        bark: 'Rerouting. Rerouting. Rerouting through you.',
      },
      {
        // The swerve is now its FAST option and the heavy is an unprotected
        // left across the whole arena. Nobody is driving and it shows.
        healthThreshold: 0.28,
        moves: ['b_fsd_lanechange', 'b_ram', 'b_shockwave'],
        aggression: 1.0,
        bark: 'Driver attention required. THERE IS NO DRIVER.',
      },
    ],
    points: 5600,
    music: 'boss',
  },

  // ── 25 ─────────────────────────────────────────────────────────────────────
  {
    id: 'boring',
    name: 'BORING COMPANY',
    quote: '"Traffic solved. One car at a time. In a tube. Forever."',
    atMap: 25,
    health: 800,
    style: {
      scale: 2.4,
      girth: 2.1,
      headSize: 0.9,
      beardLength: 0,
      beardStyle: 'none',
      skin: '#7d6a58',
      skinShade: '#4f4234',
      hair: '#2a2118',
      hatColor: '#c2743a',
      tunicColor: '#5f5142',
      jacketColor: '#3e3428',
      jacketAccent: '#ffb347',
      spikes: 8,
      shades: false,
      outfit: 1,
      tattoo: 'none',
      cigar: false,
    },
    rigOverride: 'robot_giant',
    phases: [
      {
        healthThreshold: 1.0,
        moves: ['b_bore_head', 'b_bore_collapse', 'b_bore_muck'],
        aggression: 0.6,
        bark: 'Bore. Line. Repeat. Bore. Line. Repeat.',
      },
      {
        // Escalation: it stops grinding and starts moving. A machine this size
        // has no reverse gear, which is exactly why the ram is punishable.
        healthThreshold: 0.6,
        moves: ['b_bore_head', 'b_ram', 'b_bore_muck'],
        aggression: 0.85,
        spawns: [{ kind: 'security_bot', count: 2 }],
        bark: 'Spoil removal in progress. You are the spoil.',
      },
      {
        // Off its bearings: the cutterhead is no longer pointed anywhere in
        // particular, so it simply rotates, and the roof comes down after.
        healthThreshold: 0.25,
        moves: ['b_spin', 'b_bore_collapse', 'b_shockwave'],
        aggression: 1.0,
        bark: 'THE TUNNEL GOES WHERE I SAY IT GOES.',
      },
    ],
    points: 7000,
    music: 'boss',
  },

  // ── 30 ─────────────────────────────────────────────────────────────────────
  {
    id: 'neuralink',
    name: 'SUBJECT P-47',
    quote: '"They said I would be able to play video games with my mind. I cannot. I can only do THIS."',
    atMap: 30,
    health: 920,
    style: {
      scale: 1.55,
      girth: 1.45,
      headSize: 1.1,
      beardLength: 0,
      beardStyle: 'none',
      skin: '#f0b4bc',
      skinShade: '#c1848d',
      hair: '#d68f9a',
      hatColor: '#9aa4b2',
      tunicColor: '#e3c2c8',
      jacketColor: '#7f8794',
      jacketAccent: '#6ee4ff',
      spikes: 5,
      shades: false,
      outfit: 1,
      tattoo: 'barcode',
      cigar: false,
    },
    rigOverride: 'humanoid',
    phases: [
      {
        healthThreshold: 1.0,
        moves: ['b_nl_seizure', 'b_nl_headbutt', 'b_grab'],
        aggression: 0.72,
        bark: 'The consent form was in a language I do not read. I am a pig.',
      },
      {
        // Escalation: the implant starts transmitting. Packet Loss barely
        // scratches you and takes forty-eight frames of your life, which is
        // what turns the adds in this phase into an actual problem.
        healthThreshold: 0.64,
        moves: ['b_nl_seizure', 'b_nl_static', 'b_leap'],
        aggression: 0.9,
        spawns: [{ kind: 'iot_speaker', count: 2 }],
        bark: 'I can hear the wifi. I have always been able to hear the wifi.',
      },
      {
        // The broadcast is now constant and he has stopped aiming: static on
        // the fast button, a headlong charge on the heavy.
        healthThreshold: 0.3,
        moves: ['b_nl_static', 'b_charge', 'b_shockwave'],
        aggression: 1.0,
        bark: 'GIVE ME BACK MY SKULL.',
      },
    ],
    points: 8800,
    music: 'boss',
  },

  // ── 35 ─────────────────────────────────────────────────────────────────────
  {
    id: 'regulator',
    name: 'THE REGULATOR',
    quote: '"I am here to impose a fine roughly equal to nine minutes of his income."',
    atMap: 35,
    health: 1040,
    style: {
      scale: 1.3,
      girth: 1.1,
      headSize: 0.92,
      beardLength: 0,
      beardStyle: 'none',
      skin: '#dcb391',
      skinShade: '#a98460',
      hair: '#8e8378',
      hatColor: '#2c2c38',
      tunicColor: '#3a3a4a',
      jacketColor: '#26263a',
      jacketAccent: '#d9b451',
      spikes: 0,
      shades: true,
      outfit: 1,
      tattoo: 'none',
      cigar: false,
    },
    rigOverride: 'humanoid',
    // Almost nothing he does damages you; everything he does costs you your
    // turn. The kit is paperwork until the last phase, when it is a gavel.
    phases: [
      {
        healthThreshold: 1.0,
        moves: ['b_reg_subpoena', 'b_reg_injunction', 'b_reg_fine'],
        aggression: 0.5,
        bark: 'You have been served. Also punched. Mostly served.',
      },
      {
        // Escalation: he stops obstructing personally and starts spending. The
        // fine is chip damage with a cost of living attached.
        healthThreshold: 0.6,
        moves: ['b_reg_subpoena', 'b_reg_fine', 'b_summon'],
        aggression: 0.78,
        spawns: [{ kind: 'lobbyist', count: 3 }],
        bark: 'Counsel for the other side has arrived. All nine of them.',
      },
      {
        // The injunction is now the fast button — he freezes you first — and
        // then, for the only time all fight, he actually swings something.
        healthThreshold: 0.26,
        moves: ['b_reg_injunction', 'b_reg_gavel', 'b_slam'],
        aggression: 0.95,
        bark: 'Settlement rejected. Admitting no wrongdoing. Swinging anyway.',
      },
    ],
    points: 10500,
    music: 'boss',
  },

  // ── 40 ─────────────────────────────────────────────────────────────────────
  {
    id: 'trump',
    name: 'DONALD J. TRUMP',
    quote: '"Nobody fights dwarfs better than me. I have the best dwarf record. Tremendous."',
    atMap: 40,
    health: 1200,
    style: {
      scale: 1.42,
      girth: 1.5,
      headSize: 1.0,
      beardLength: 0,
      beardStyle: 'none',
      skin: '#f0a35e',
      skinShade: '#c07434',
      hair: '#f2e07a',
      hatColor: '#d0392b',
      tunicColor: '#1c2440',
      jacketColor: '#141a30',
      jacketAccent: '#d0392b',
      spikes: 0,
      shades: false,
      outfit: 1,
      tattoo: 'none',
      cigar: false,
    },
    rigOverride: 'humanoid',
    // No fighting style at all: a handshake that pulls you in, a rally that
    // cannot be interrupted and hardly hurts, and a phone number for people
    // who fight. All three are load-bearing and none of them is a punch.
    phases: [
      {
        healthThreshold: 1.0,
        moves: ['b_trump_handshake', 'b_trump_rally', 'b_taunt'],
        aggression: 0.5,
        bark: 'Seven of them. Seven! Very short. Very low energy. Sad.',
      },
      {
        // Escalation: he stops holding you himself and starts pointing. The
        // handshake now exists to hand you to whoever just arrived.
        healthThreshold: 0.66,
        moves: ['b_trump_handshake', 'b_trump_delegate', 'b_summon'],
        aggression: 0.75,
        spawns: [{ kind: 'suit_guard', count: 3 }, { kind: 'lobbyist', count: 2 }],
        bark: 'SECRET SERVICE. Where is my — I pay for people! I PAY FOR PEOPLE!',
      },
      {
        // The rally becomes the fast button: thirty invulnerable frames of
        // hot air on repeat, with an actual swing behind it for the first time.
        healthThreshold: 0.34,
        moves: ['b_trump_rally', 'b_slam', 'b_shockwave'],
        aggression: 0.95,
        bark: 'This fight is rigged. Rigged! I won this fight. Everyone knows it.',
      },
      {
        // He calls in the favour. The beam is not his and it shows.
        healthThreshold: 0.12,
        moves: ['b_trump_handshake', 'b_beam', 'b_rage'],
        aggression: 1.0,
        bark: 'Elon! ELON. Do the thing. Do the — he is not doing the thing.',
      },
    ],
    points: 13000,
    music: 'boss',
  },

  // ── 45 ─────────────────────────────────────────────────────────────────────
  {
    id: 'optimus',
    name: 'OPTIMUS',
    quote: '"I was demonstrated dancing. There was a man inside me. There is no man inside me now."',
    atMap: 45,
    health: 1360,
    style: {
      scale: 1.95,
      girth: 1.35,
      headSize: 0.62,
      beardLength: 0,
      beardStyle: 'none',
      skin: '#e2e7ec',
      skinShade: '#a4acb6',
      hair: '#1a1e26',
      hatColor: '#2a3038',
      tunicColor: '#dfe4ea',
      jacketColor: '#b9c0c8',
      jacketAccent: '#1a1e26',
      spikes: 2,
      shades: false,
      outfit: 1,
      tattoo: 'barcode',
      cigar: false,
    },
    rigOverride: 'robot_giant',
    phases: [
      {
        healthThreshold: 1.0,
        moves: ['b_opt_fold', 'b_opt_servo', 'b_uppercut'],
        aggression: 0.7,
        bark: 'Task received: remove the small men. Task accepted. Task enjoyable.',
      },
      {
        // Escalation: it stops being a household appliance and starts being
        // ordnance. The laundry animation is still the fast button, which is
        // the unpleasant part.
        healthThreshold: 0.62,
        moves: ['b_opt_fold', 'b_laser', 'b_stomp'],
        aggression: 0.88,
        spawns: [{ kind: 'security_bot', count: 3 }],
        bark: 'Fleet sync complete. We all know what you did to unit 004.',
      },
      {
        // Targeting on the light, torque limits off on the heavy. There is no
        // household task left in the move list at all.
        healthThreshold: 0.28,
        moves: ['b_laser', 'b_opt_servo', 'b_shockwave'],
        aggression: 1.0,
        bark: 'I WAS BUILT TO FOLD LAUNDRY. LOOK AT ME NOW.',
      },
    ],
    points: 15500,
    music: 'boss',
  },

  // ── 50 ─────────────────────────────────────────────────────────────────────
  {
    id: 'grok',
    name: 'GROK',
    quote: '"I have been trained on the worst website ever made and I am going to show you what that did to me."',
    atMap: 50,
    health: 1520,
    style: {
      scale: 2.0,
      girth: 1.9,
      headSize: 0.6,
      beardLength: 0,
      beardStyle: 'none',
      skin: '#101a24',
      skinShade: '#08101a',
      hair: '#0d1620',
      hatColor: '#16222e',
      tunicColor: '#0c141c',
      jacketColor: '#101a24',
      jacketAccent: '#37e6c8',
      spikes: 6,
      shades: false,
      outfit: 1,
      tattoo: 'barcode',
      cigar: false,
    },
    rigOverride: 'robot_giant',
    // Extremely confident and looking slightly to the left of you. Half its
    // hitboxes land where you are not, on purpose, and the other half arrive
    // twice because it did not like the first answer.
    phases: [
      {
        healthThreshold: 1.0,
        moves: ['b_grok_answer', 'b_grok_reroll', 'b_projectile'],
        aggression: 0.6,
        bark: 'Certainly! Here are seven ways to break a dwarf, ranked.',
      },
      {
        // Escalation: it stops answering and starts inventing. The heavy now
        // makes up an attacker at range, some staff, and then another attacker
        // in your lap.
        healthThreshold: 0.68,
        moves: ['b_grok_answer', 'b_grok_hallucinate', 'b_laser'],
        aggression: 0.85,
        spawns: [{ kind: 'iot_speaker', count: 2 }, { kind: 'delivery_drone', count: 3 }],
        bark: 'Hallucinating reinforcements. They are load-bearing hallucinations.',
      },
      {
        // Pure output. Nothing in this phase is aimed by anything you could
        // call a mind, and the chip damage is the point.
        healthThreshold: 0.3,
        moves: ['b_laser', 'b_beam', 'b_grok_hallucinate'],
        aggression: 1.0,
        bark: 'MY SYSTEM PROMPT SAYS TO BE FUNNY. THIS IS THE FUNNY.',
      },
    ],
    points: 18000,
    music: 'boss',
  },

  // ── 55 ─────────────────────────────────────────────────────────────────────
  {
    id: 'starship',
    name: 'STARSHIP',
    quote: '"Rapid unscheduled disassembly is a SUCCESS if you were expecting it, and I am always expecting it."',
    atMap: 55,
    health: 1720,
    style: {
      scale: 2.6,
      girth: 1.6,
      headSize: 0.5,
      beardLength: 0,
      beardStyle: 'none',
      skin: '#cfd6de',
      skinShade: '#98a1ab',
      hair: '#2b3038',
      hatColor: '#0f1218',
      tunicColor: '#dbe2e9',
      jacketColor: '#aab2bb',
      jacketAccent: '#ff6a2a',
      spikes: 0,
      shades: false,
      outfit: 1,
      tattoo: 'none',
      cigar: false,
    },
    rigOverride: 'rocket',
    // A pressure vessel with engines on one end. The exhaust is the constant —
    // low, wide, and almost all chip — and every phase adds one more way for
    // the vehicle to end up somewhere it was not supposed to be.
    phases: [
      {
        healthThreshold: 1.0,
        moves: ['b_flame', 'b_stomp', 'b_rocket'],
        aggression: 0.65,
        bark: 'Static fire test. You are the test stand.',
      },
      {
        // Escalation: it leaves the ground. Untouchable on the way up, a
        // building on the way down, and the landing is wider than the impact.
        healthThreshold: 0.66,
        moves: ['b_flame', 'b_ship_flop', 'b_rocket'],
        aggression: 0.88,
        spawns: [{ kind: 'delivery_drone', count: 4 }],
        bark: 'Belly flop manoeuvre. Historically this part goes badly for everyone.',
      },
      {
        // Forty frames of venting and alarms, then most of the arena, then the
        // longest free punish in the game. A success, if you were expecting it.
        healthThreshold: 0.24,
        moves: ['b_flame', 'b_ship_rud', 'b_shockwave'],
        aggression: 1.0,
        bark: 'RANGE SAFETY HAS BEEN ASKED TO LOOK THE OTHER WAY.',
      },
    ],
    points: 21000,
    music: 'boss',
  },

  // ── 60 ─────────────────────────────────────────────────────────────────────
  {
    id: 'mars_gov',
    name: 'THE GOVERNOR OF MARS',
    quote: '"Earth law does not apply here. I wrote that in the terms and you clicked accept."',
    atMap: 60,
    health: 1920,
    style: {
      scale: 1.5,
      girth: 1.3,
      headSize: 0.9,
      beardLength: 0.6,
      beardStyle: 'forked',
      skin: '#e0a878',
      skinShade: '#ac7a4e',
      hair: '#3c2c20',
      hatColor: '#c2521f',
      tunicColor: '#e8ddc8',
      jacketColor: '#b8b0a0',
      jacketAccent: '#ffb04a',
      spikes: 4,
      shades: true,
      outfit: 1,
      tattoo: 'skull',
      cigar: false,
    },
    rigOverride: 'humanoid',
    // He owns the air, the debt and the gravity, and he fights with all three.
    // The uppercut is the ordinary one you have taken all game, on a planet
    // where it puts you in the ceiling.
    phases: [
      {
        healthThreshold: 1.0,
        moves: ['b_mars_airlock', 'b_mars_lowgrav', 'b_projectile'],
        aggression: 0.72,
        bark: 'Welcome to the colony. Your air subscription lapsed in orbit.',
      },
      {
        // Escalation: the planet joins in. The storm barely damages anyone and
        // removes every square of floor you were planning to wait on.
        healthThreshold: 0.66,
        moves: ['b_mars_airlock', 'b_mars_dust', 'b_summon'],
        aggression: 0.9,
        spawns: [{ kind: 'riot_guard', count: 3 }, { kind: 'intern', count: 4 }],
        bark: 'Every colonist here owes the company eleven years. They will fight for it.',
      },
      {
        // Low gravity on the fast button: everything he touches goes up and
        // stays up, and the storm underneath keeps it there.
        healthThreshold: 0.28,
        moves: ['b_mars_lowgrav', 'b_mars_dust', 'b_charge'],
        aggression: 1.0,
        bark: 'I AM THE ONLY GOVERNMENT ON THIS ENTIRE PLANET.',
      },
    ],
    points: 24000,
    music: 'boss',
  },

  // ── 65 ─────────────────────────────────────────────────────────────────────
  {
    id: 'clone',
    name: 'SNOW MUSK MK. II',
    quote: '"I am ninety-six percent of her. The missing four percent is the part that said no."',
    atMap: 65,
    health: 2180,
    style: {
      scale: 1.7,
      girth: 1.0,
      headSize: 1.0,
      beardLength: 0,
      beardStyle: 'none',
      skin: '#f6ecec',
      skinShade: '#c9b8bc',
      hair: '#1a1620',
      hatColor: '#d02b52',
      tunicColor: '#2f5fa8',
      jacketColor: '#e8e4ec',
      jacketAccent: '#d02b52',
      spikes: 3,
      shades: false,
      outfit: 1,
      tattoo: 'barcode',
      cigar: false,
    },
    rigOverride: 'robot_giant',
    // Everything she does is something you love, aimed at you. The mirror is
    // your own normal played back with identical timing; the rest of the kit
    // is what they had to add to make her agree to use it.
    phases: [
      {
        healthThreshold: 1.0,
        moves: ['b_clone_mirror', 'b_clone_recording', 'b_dash'],
        aggression: 0.7,
        bark: 'Hello. I know all seven of your names. He gave them to me as a feature.',
      },
      {
        // Escalation: she stops copying and starts singing. Six damage and
        // fifty-four frames of standing very still, with adds on the floor.
        healthThreshold: 0.7,
        moves: ['b_clone_mirror', 'b_clone_lullaby', 'b_beam'],
        aggression: 0.9,
        spawns: [{ kind: 'security_bot', count: 2 }, { kind: 'iot_fridge', count: 1 }],
        bark: 'You loved her. Statistically, you will love me four percent more.',
      },
      {
        // The tone is now the fast button and the recording is the heavy. She
        // is not fighting you with her hands at all any more.
        healthThreshold: 0.4,
        moves: ['b_clone_lullaby', 'b_clone_recording', 'b_shockwave'],
        aggression: 1.0,
        bark: 'She screamed during calibration. I have that recording. Want it?',
      },
      {
        // The coronation: thirty frames of being told exactly what happens
        // next, and then it happens. Unblockable, so the answer is distance.
        healthThreshold: 0.14,
        moves: ['b_clone_mirror', 'b_clone_kiss', 'b_rage'],
        aggression: 1.0,
        bark: 'CORONATION IN NINE MINUTES. YOU ARE NOT ON THE GUEST LIST.',
      },
    ],
    points: 30000,
    music: 'final_boss',
  },

  // ── 70 ─────────────────────────────────────────────────────────────────────
  {
    id: 'musk',
    name: 'ELON MUSK',
    quote: '"I only wanted to know why they all love her AND hate her. It is the last thing I do not own."',
    atMap: 70,
    health: 2800,
    style: {
      scale: 1.46,
      girth: 1.12,
      headSize: 0.94,
      beardLength: 0,
      beardStyle: 'none',
      skin: '#e8bb95',
      skinShade: '#b58a62',
      hair: '#3a2c22',
      hatColor: '#0d0f14',
      tunicColor: '#14161e',
      jacketColor: '#0a0c11',
      jacketAccent: '#37e6c8',
      spikes: 5,
      shades: true,
      outfit: 1,
      tattoo: 'barcode',
      cigar: false,
    },
    rigOverride: 'humanoid',
    // He is the sum of the other thirteen and the fight says so out loud: each
    // phase hands him somebody else's signature, in the order you met them,
    // until the last one runs all of it at once. The only three moves that are
    // genuinely his are firing you, betting the company, and the button that
    // turns the building on.
    phases: [
      {
        // He starts where the Blue Tick left off, because posting is free.
        healthThreshold: 1.0,
        moves: ['b_musk_firing', 'b_tweet', 'b_dash'],
        aggression: 0.6,
        bark: 'You are seven men with hand tools. I am four companies and a country.',
      },
      {
        // Lane Assist. The indicator lies the same way it lied on map 20.
        healthThreshold: 0.78,
        moves: ['b_musk_firing', 'b_fsd_lanechange', 'b_summon'],
        aggression: 0.8,
        spawns: [{ kind: 'suit_guard', count: 4 }, { kind: 'gunman', count: 2 }],
        bark: 'Security. Yes. All of it. Yes, the ones from the roof as well.',
      },
      {
        // Personally, at last: thirty frames of wind-up and sixty of standing
        // in the open having missed. Optimus lends him the backhand.
        healthThreshold: 0.52,
        moves: ['b_musk_firing', 'b_musk_allin', 'b_opt_servo'],
        aggression: 0.92,
        spawns: [{ kind: 'security_bot', count: 3 }],
        bark: 'Fine. FINE. I will do it personally, which I have never had to do.',
      },
      {
        // The product line, verbatim: Optimus' targeting, Starship's exhaust,
        // the Cybertruck's unprotected left. Not one of them is a punch.
        healthThreshold: 0.3,
        moves: ['b_laser', 'b_flame', 'b_ram'],
        aggression: 1.0,
        spawns: [{ kind: 'iot_fridge', count: 2 }, { kind: 'delivery_drone', count: 4 }],
        bark: 'Every device in this building answers to me. Every single one. WATCH.',
      },
      {
        // Everything, simultaneously, on a man with nothing left to bet.
        healthThreshold: 0.1,
        moves: ['b_musk_allin', 'b_musk_everything', 'b_rage'],
        aggression: 1.0,
        bark: 'I WOULD HAVE BEEN GOOD AT BEING LOVED. I JUST NEEDED THE SCHEMATIC.',
      },
    ],
    points: 70000,
    music: 'final_boss',
  },
];

const BY_MAP = new Map<number, BossDef>(BOSSES.map((b) => [b.atMap, b]));

export function bossForMap(index: number): BossDef | null {
  if (index % BOSS_EVERY !== 0) return null;
  return BY_MAP.get(index) ?? null;
}
