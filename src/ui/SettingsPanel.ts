/**
 * The one Settings page.
 *
 * There used to be two: the title screen's and the pause menu's, written
 * separately and drifted apart — gore only existed mid-fight, difficulty only on
 * the title, and the three volume sliders came in a different order on each.
 * A player who changed something on one could not find it on the other. Both
 * now mount this, so there is exactly one place every setting lives.
 *
 * Grouped the way a player looks for things: what you hear, how it moves, what
 * it shows, how hard it is. Every control is a native input, so keyboard, pad
 * (through MenuInput) and screen reader all work without any of it knowing.
 */

import type { AudioBus, Settings } from '@/core/types';
import { clamp } from '@/core/math';
import { setGoreLevel } from '@/game/Fighter';
import { button, slider, toggle } from '@/ui/Widgets';

export interface SettingsPanelOpts {
  /** The live settings object; mutated in place. */
  settings: Settings;
  /** Save, and push anything DOM-side (reduced motion) out. Called after every change. */
  commit(): void;
  audio: Pick<AudioBus, 'play'>;
  /**
   * Opened over a fight in progress. Difficulty still changes, but enemy health
   * is rolled when a map starts, so the page says when it will bite.
   */
  midRun?: boolean;
}

const GORE_LEVELS: readonly Settings['gore'][] = ['off', 'on', 'max'];
const GORE_LABELS: readonly string[] = ['Off', 'On', 'Maximum'];

const DIFFICULTIES: readonly { id: Settings['difficulty']; label: string; help: string }[] = [
  { id: 'easy', label: 'Easy', help: 'The guards are having an off day.' },
  { id: 'normal', label: 'Normal', help: 'A fair fight, which is more than he deserves.' },
  { id: 'hard', label: 'Hard', help: 'They have read your file.' },
  { id: 'musk', label: 'Musk', help: 'Unpaid overtime, they all block, and nothing you find carries over.' },
];

function goreIndex(level: Settings['gore']): number {
  const i = GORE_LEVELS.indexOf(level);
  return i < 0 ? 1 : i;
}

function sectionLabel(text: string): HTMLElement {
  const el = document.createElement('h3');
  el.className = 'section-label';
  el.textContent = text;
  return el;
}

/** The fields, grouped. The caller wraps them in a panel and adds its own Back. */
export function settingsBody(opts: SettingsPanelOpts): HTMLElement {
  const s = opts.settings;
  const body = document.createElement('div');
  body.className = 'stack';

  const commit = (): void => opts.commit();

  // ── Sound ────────────────────────────────────────────────────────────────
  body.appendChild(sectionLabel('Sound'));
  body.appendChild(
    slider('Master volume', 0, 1, s.masterVolume, (v) => {
      s.masterVolume = v;
      commit();
    }),
  );
  body.appendChild(
    slider('Music', 0, 1, s.musicVolume, (v) => {
      s.musicVolume = v;
      commit();
    }),
  );
  body.appendChild(
    slider('Effects', 0, 1, s.sfxVolume, (v) => {
      s.sfxVolume = v;
      // Effects are the one volume you cannot judge without hearing one.
      opts.audio.play('punch_light', { gain: 0.7 });
      commit();
    }),
  );

  // ── Feel ─────────────────────────────────────────────────────────────────
  body.appendChild(sectionLabel('Feel'));
  body.appendChild(
    slider(
      'Screen shake',
      0,
      2,
      s.screenShake,
      (v) => {
        s.screenShake = v;
        commit();
      },
      {
        step: 0.1,
        format: (v) => (v <= 0.001 ? 'Off' : `${Math.round(v * 100)}%`),
        help: '100% is how it was tuned. There is a great deal of it; turn it down if you like.',
      },
    ),
  );
  body.appendChild(
    toggle(
      'Reduced motion',
      s.reducedMotion,
      (v) => {
        s.reducedMotion = v;
        commit();
      },
      { help: 'Calms the flashes, the shake, the slow motion and the particles. The fights still hurt.' },
    ),
  );

  // ── Content ──────────────────────────────────────────────────────────────
  body.appendChild(sectionLabel('Content'));
  body.appendChild(
    slider(
      'Gore',
      0,
      GORE_LEVELS.length - 1,
      goreIndex(s.gore),
      (v) => {
        const level = GORE_LEVELS[clamp(Math.round(v), 0, GORE_LEVELS.length - 1)] ?? 'on';
        if (level === s.gore) return;
        s.gore = level;
        // One module-level value drives the fighters, the combat resolver and
        // the fatality director, so this lands on a fight frozen behind the menu
        // rather than on the next one.
        setGoreLevel(level);
        opts.audio.play(level === 'off' ? 'ui_back' : 'hit_flesh', { gain: 0.7 });
        commit();
      },
      {
        step: 1,
        format: (v) => GORE_LABELS[clamp(Math.round(v), 0, GORE_LABELS.length - 1)] ?? 'On',
        help:
          'Off keeps the punches, the torn clothes and the wheezing — no blood, no finishers. ' +
          'Maximum is a decision you are making on purpose.',
      },
    ),
  );

  // ── Game ─────────────────────────────────────────────────────────────────
  body.appendChild(sectionLabel('Game'));
  body.appendChild(difficultyField(opts));
  body.appendChild(
    toggle(
      'Show hitboxes',
      s.showHitboxes,
      (v) => {
        s.showHitboxes = v;
        commit();
      },
      { help: 'Draws every live hitbox and hurtbox. For people who want to argue about frame data.' },
    ),
  );

  return body;
}

/**
 * Four buttons, one pressed. Updated in place: rebuilding the page on every
 * press used to throw focus to the Back button, so a pad player who picked Hard
 * had to walk all the way back up to see what they had done.
 */
function difficultyField(opts: SettingsPanelOpts): HTMLElement {
  const s = opts.settings;
  const field = document.createElement('div');
  field.className = 'field';

  const label = document.createElement('div');
  label.className = 'field__label';
  label.textContent = 'Difficulty';

  const row = document.createElement('div');
  row.className = 'row';
  row.setAttribute('role', 'group');
  row.setAttribute('aria-label', 'Difficulty');

  const help = document.createElement('p');
  help.className = 'field__help';

  const buttons: HTMLButtonElement[] = [];
  const paint = (): void => {
    for (let i = 0; i < DIFFICULTIES.length; i++) {
      buttons[i].setAttribute('aria-pressed', String(s.difficulty === DIFFICULTIES[i].id));
    }
    const cur = DIFFICULTIES.find((d) => d.id === s.difficulty);
    help.textContent =
      (cur ? cur.help : '') + (opts.midRun ? ' Takes effect from the next map.' : '');
  };

  for (const d of DIFFICULTIES) {
    const b = button(
      d.label,
      () => {
        if (s.difficulty === d.id) return;
        s.difficulty = d.id;
        opts.audio.play('ui_select', { gain: 0.6 });
        paint();
        opts.commit();
      },
      { variant: 'outlined', title: d.help, ariaLabel: `Difficulty: ${d.label}. ${d.help}` },
    );
    buttons.push(b);
    row.appendChild(b);
  }
  paint();

  field.append(label, row, help);
  return field;
}
