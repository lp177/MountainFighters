/**
 * The widget kit.
 *
 * Everything here is real, semantic HTML: a button is a <button>, a slider is
 * an <input type="range">, a toggle is an <input type="checkbox">. That is not
 * purism — it is how the thing ends up keyboard-operable and screen-reader
 * legible without writing a single line of ARIA plumbing.
 *
 * Styling lives in styles.css; this module only builds structure and wires
 * behaviour.
 */

export interface ButtonOpts {
  /** Visual weight. `filled` is the one call to action per view. */
  variant?: 'filled' | 'tonal' | 'outlined' | 'text' | 'danger';
  /** A single glyph rendered before the label. Text only — we ship no images. */
  icon?: string;
  disabled?: boolean;
  loading?: boolean;
  /** Stretch to the container width. */
  wide?: boolean;
  /** Take focus when the view is mounted. */
  autofocus?: boolean;
  /** Overrides the accessible name when the visible label is too terse. */
  ariaLabel?: string;
  /** Native tooltip. */
  title?: string;
  className?: string;
}

export interface SliderOpts {
  step?: number;
  /** Renders the numeric readout. Defaults to a percentage for 0..1 ranges. */
  format?: (value: number) => string;
  disabled?: boolean;
  /** Extra explanatory line, wired up with aria-describedby. */
  help?: string;
}

export interface ToggleOpts {
  disabled?: boolean;
  help?: string;
}

let uid = 0;

function nextId(prefix: string): string {
  uid += 1;
  return `mf-${prefix}-${uid}`;
}

// ── Ripple ───────────────────────────────────────────────────────────────────

let motionQuery: MediaQueryList | null = null;

/** True when the OS asks for reduced motion, or the in-game setting does. */
function reducedMotion(): boolean {
  if (typeof window === 'undefined') return false;
  if (document.documentElement.classList.contains('reduced-motion')) return true;
  if (!motionQuery && typeof window.matchMedia === 'function') {
    motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
  }
  return motionQuery ? motionQuery.matches : false;
}

function isInert(el: HTMLElement): boolean {
  if (el.hasAttribute('disabled')) return true;
  if (el.getAttribute('aria-disabled') === 'true') return true;
  if (el.classList.contains('is-loading')) return true;
  const inner = el.querySelector('input, button, select, textarea');
  return inner instanceof HTMLElement && inner.hasAttribute('disabled');
}

function spawnRipple(host: HTMLElement, x: number, y: number): void {
  if (reducedMotion()) return;
  const rect = host.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  // Reach the furthest corner from the strike point so the wave always covers
  // the whole control.
  const radius = Math.hypot(Math.max(x, rect.width - x), Math.max(y, rect.height - y));

  const ripple = document.createElement('span');
  ripple.className = 'ripple';
  ripple.style.left = `${x - radius}px`;
  ripple.style.top = `${y - radius}px`;
  ripple.style.width = `${radius * 2}px`;
  ripple.style.height = `${radius * 2}px`;

  let removed = false;
  const remove = (): void => {
    if (removed) return;
    removed = true;
    ripple.remove();
  };
  ripple.addEventListener('animationend', remove, { once: true });
  // Belt and braces: if the animation never runs (tab hidden, style stripped)
  // the node still goes away instead of piling up.
  window.setTimeout(remove, 1200);

  host.appendChild(ripple);
}

/**
 * Material ripple, expanding from wherever the pointer actually landed.
 *
 * Keyboard users are not second-class here: Enter/Space fires the identical
 * ripple from the centre of the control, so activation feels the same whichever
 * way you drive it.
 *
 * @param el        the element the ripple is painted inside
 * @param keySource the focusable element to listen to for keyboard activation,
 *                  when it is not `el` itself (a switch's hidden checkbox).
 */
export function attachRipple(el: HTMLElement, keySource?: HTMLElement): void {
  if (el.dataset.ripple === '1') return;
  el.dataset.ripple = '1';
  el.classList.add('ripple-host');

  el.addEventListener('pointerdown', (e: PointerEvent) => {
    if (e.button !== 0) return;
    if (isInert(el)) return;
    const rect = el.getBoundingClientRect();
    spawnRipple(el, e.clientX - rect.left, e.clientY - rect.top);
  });

  const keys = keySource ?? el;
  keys.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.repeat || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key !== 'Enter' && e.key !== ' ' && e.key !== 'Spacebar') return;
    if (isInert(el)) return;
    const rect = el.getBoundingClientRect();
    spawnRipple(el, rect.width / 2, rect.height / 2);
  });
}

// ── Button ───────────────────────────────────────────────────────────────────

export function button(label: string, onClick: () => void, opts: ButtonOpts = {}): HTMLButtonElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = `btn btn--${opts.variant ?? 'tonal'}`;
  if (opts.wide) el.classList.add('btn--wide');
  if (opts.className) el.classList.add(...opts.className.split(/\s+/).filter(Boolean));

  if (opts.icon) {
    const icon = document.createElement('span');
    icon.className = 'btn__icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = opts.icon;
    el.appendChild(icon);
  }

  const text = document.createElement('span');
  text.className = 'btn__label';
  text.textContent = label;
  el.appendChild(text);

  const spinner = document.createElement('span');
  spinner.className = 'btn__spinner';
  spinner.setAttribute('aria-hidden', 'true');
  el.appendChild(spinner);

  if (opts.ariaLabel) el.setAttribute('aria-label', opts.ariaLabel);
  if (opts.title) el.title = opts.title;
  if (opts.disabled) el.disabled = true;
  if (opts.loading) setButtonLoading(el, true);
  if (opts.autofocus) el.setAttribute('autofocus', '');

  // A real <button> already fires click for Enter and Space, so this single
  // listener covers pointer and keyboard alike.
  el.addEventListener('click', () => {
    if (el.disabled || el.classList.contains('is-loading')) return;
    onClick();
  });

  attachRipple(el);
  return el;
}

/** Flips a button into its busy state without rebuilding it. */
export function setButtonLoading(el: HTMLButtonElement, loading: boolean): void {
  el.classList.toggle('is-loading', loading);
  if (loading) el.setAttribute('aria-busy', 'true');
  else el.removeAttribute('aria-busy');
}

// ── Panel ────────────────────────────────────────────────────────────────────

export function panel(title: string, ...children: HTMLElement[]): HTMLElement {
  const el = document.createElement('section');
  el.className = 'panel';

  if (title) {
    const id = nextId('panel');
    const head = document.createElement('header');
    head.className = 'panel__head';
    const h = document.createElement('h2');
    h.className = 'panel__title';
    h.id = id;
    h.textContent = title;
    head.appendChild(h);
    el.appendChild(head);
    el.setAttribute('role', 'group');
    el.setAttribute('aria-labelledby', id);
  }

  const body = document.createElement('div');
  body.className = 'panel__body';
  for (const child of children) body.appendChild(child);
  el.appendChild(body);

  return el;
}

// ── Slider ───────────────────────────────────────────────────────────────────

function decimalsOf(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = String(step);
  const dot = s.indexOf('.');
  return dot < 0 ? 0 : Math.min(3, s.length - dot - 1);
}

export function slider(
  label: string,
  min: number,
  max: number,
  value: number,
  onChange: (value: number) => void,
  opts: SliderOpts = {},
): HTMLElement {
  const span = max - min;
  const step = opts.step ?? (span <= 1.0001 ? 0.05 : 1);
  const decimals = decimalsOf(step);
  const format =
    opts.format ??
    ((v: number): string =>
      span <= 1.0001 ? `${Math.round(((v - min) / (span || 1)) * 100)}%` : v.toFixed(decimals));

  const id = nextId('slider');
  const field = document.createElement('div');
  field.className = 'field field--slider';

  const row = document.createElement('div');
  row.className = 'field__row';

  const labelEl = document.createElement('label');
  labelEl.className = 'field__label';
  labelEl.htmlFor = id;
  labelEl.textContent = label;

  const output = document.createElement('output');
  output.className = 'field__value';
  output.setAttribute('for', id);

  row.append(labelEl, output);
  field.appendChild(row);

  const input = document.createElement('input');
  input.type = 'range';
  input.className = 'range';
  input.id = id;
  input.min = String(min);
  input.max = String(max);
  input.step = String(step);
  input.value = String(value);
  if (opts.disabled) input.disabled = true;
  field.appendChild(input);

  let help: HTMLElement | null = null;
  if (opts.help) {
    help = document.createElement('p');
    help.className = 'field__help';
    help.id = `${id}-help`;
    help.textContent = opts.help;
    input.setAttribute('aria-describedby', help.id);
    field.appendChild(help);
  }

  const paint = (): void => {
    const v = Number(input.value);
    output.value = format(v);
    // Fills the webkit track; Firefox uses ::-moz-range-progress instead.
    input.style.setProperty('--range-fill', `${span === 0 ? 0 : ((v - min) / span) * 100}%`);
    // The formatted readout is far more useful to a screen reader than "0.65".
    input.setAttribute('aria-valuetext', output.value);
  };

  input.addEventListener('input', () => {
    paint();
    onChange(Number(input.value));
  });
  paint();

  return field;
}

// ── Toggle ───────────────────────────────────────────────────────────────────

export function toggle(
  label: string,
  value: boolean,
  onChange: (value: boolean) => void,
  opts: ToggleOpts = {},
): HTMLElement {
  const id = nextId('toggle');
  const field = document.createElement('div');
  field.className = 'field field--toggle';

  const wrap = document.createElement('label');
  wrap.className = 'switch';
  wrap.htmlFor = id;

  const input = document.createElement('input');
  input.type = 'checkbox';
  input.className = 'switch__input';
  input.id = id;
  input.checked = value;
  if (opts.disabled) input.disabled = true;

  const track = document.createElement('span');
  track.className = 'switch__track';
  track.setAttribute('aria-hidden', 'true');
  const thumb = document.createElement('span');
  thumb.className = 'switch__thumb';
  track.appendChild(thumb);

  const text = document.createElement('span');
  text.className = 'switch__text';
  text.textContent = label;

  wrap.append(input, track, text);
  field.appendChild(wrap);

  if (opts.help) {
    const help = document.createElement('p');
    help.className = 'field__help';
    help.id = `${id}-help`;
    help.textContent = opts.help;
    input.setAttribute('aria-describedby', help.id);
    field.appendChild(help);
  }

  input.addEventListener('change', () => onChange(input.checked));

  // The ripple paints across the whole row; the hidden checkbox is what the
  // keyboard actually talks to, so that is where the key listener goes.
  attachRipple(wrap, input);

  return field;
}
