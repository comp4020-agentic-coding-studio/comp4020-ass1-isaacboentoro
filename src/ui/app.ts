import { compile } from "../compiler/pipeline";
import type { Compilation, Span, StageId } from "../compiler/types";
import { PLAYERS } from "../compiler/types";
import { type Region, pieces, regionsOf } from "./highlight";
import { type BuiltPanes, buildPanes, buildRules } from "./panes";
import { paletteFrom } from "./palettes";
import {
  DEFAULT_SPEED,
  PALETTE_KEY,
  SPEED_KEY,
  SPEEDS,
  THEME_KEY,
  type Theme,
  readStored,
  speedFrom,
  store,
  themeFrom,
} from "./prefs";
import { DEFAULT_PRESET, PRESETS } from "./presets";
import { clamp } from "./reveal";

/**
 * Six players, one per stage.
 *
 * Each stage owns its own cursor, slider, play button and commentary, and knows
 * nothing about the others: a stage's step 3 is the third thing THAT stage did.
 * Every stage also echoes the source with its own highlight, so the answer to
 * "what is this stage looking at" is always on screen next to what it produced.
 *
 * State lives here; layout lives entirely in CSS. That is what makes a resize
 * mid-drag harmless.
 */

const COMPILE_DEBOUNCE_MS = 120;

/**
 * Some steps are honestly about the whole file — laying out a frame, handing the
 * text on. Marking every line for those is noise, not information, so above this
 * share of the source the highlight is dropped and the commentary carries it.
 */
const WHOLE_FILE_SHARE = 0.6;

type StagePlayer = {
  stage: StageId;
  scrubber: HTMLInputElement;
  play: HTMLButtonElement;
  position: HTMLElement;
  title: HTMLElement;
  explain: HTMLElement;
  bar: HTMLElement;
  echo: HTMLElement;
  rules: HTMLElement;
  body: HTMLElement;
  copy: HTMLButtonElement;
  cursor: number;
  timer?: number;
  copyTimer?: number;
};

function required<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

export function start(): void {
  const source = required<HTMLTextAreaElement>("source");
  const mirror = required("mirror");
  const presets = required("presets");
  const speed = required<HTMLInputElement>("speed");
  const speedBar = required("bar-speed");
  const speedValue = required("speed-value");
  const theme = required<HTMLButtonElement>("theme");
  const palette = required<HTMLSelectElement>("palette");

  let compilation: Compilation = compile(DEFAULT_PRESET.source);
  let built: BuiltPanes | undefined;
  let debounce: number | undefined;
  let speedIndex = DEFAULT_SPEED;

  const players: StagePlayer[] = PLAYERS.map((stage) => ({
    stage,
    scrubber: required<HTMLInputElement>(`scrub-${stage}`),
    play: required<HTMLButtonElement>(`play-${stage}`),
    bar: required(`bar-${stage}`),
    position: required(`pos-${stage}`),
    title: required(`title-${stage}`),
    explain: required(`explain-${stage}`),
    echo: required(`echo-${stage}`),
    rules: required(`rules-${stage}`),
    body: required(`pane-${stage}`),
    copy: required<HTMLButtonElement>(`copy-${stage}`),
    cursor: 0,
  }));

  // ------------------------------------------------------------------ presets

  // The grammar is fixed, so it is built once rather than per compile.
  for (const player of players) buildRules(player.stage, player.rules);

  for (const preset of PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preset";
    button.append(text("span", "preset-name", preset.name));
    button.append(text("span", "preset-about", preset.about));
    button.addEventListener("click", () => {
      source.value = preset.source;
      recompile();
    });
    presets.append(button);
  }

  // -------------------------------------------------------------------- state

  function recompile(): void {
    for (const player of players) stop(player);
    compilation = compile(source.value);
    built = buildPanes(compilation, bodies());
    highlightEditor(null);
    reserveHeights();

    for (const player of players) {
      const steps = built.traces[player.stage].steps.length;
      player.scrubber.max = String(Math.max(0, steps - 1));
      player.scrubber.disabled = steps <= 1;
      player.play.disabled = steps <= 1;
      // Land on the end so the section reads as finished, then rewind to watch.
      setCursor(player, Math.max(0, steps - 1));
      // A stale "COPIED" would now be lying about what is on the clipboard.
      if (player.copyTimer !== undefined) window.clearTimeout(player.copyTimer);
      player.copyTimer = undefined;
      player.copy.textContent = "COPY";
      delete player.copy.dataset.copied;
    }
  }

  function bodies(): Record<StageId, HTMLElement> {
    const map = {} as Record<StageId, HTMLElement>;
    for (const player of players) map[player.stage] = player.body;
    return map;
  }

  /**
   * Reserve each stage's finished height once per compile.
   *
   * Without this, a pane grows as it plays and everything below it slides down a
   * step at a time — the tree is the worst offender, but any pane that reveals a
   * taller artefact does it. Measuring the fully-revealed height and pinning it as
   * `min-height` means content still grows inside the box while the box itself
   * never moves. Capped by the CSS `max-height`, so a long program still scrolls
   * rather than reserving a screenful.
   *
   * This is the one place that reads layout back out of the DOM, and it is a
   * measurement, not a layout decision — the sizes still come from CSS.
   */
  function reserveHeights(): void {
    if (!built) return;
    for (const player of players) {
      // Reveal everything to measure the end state. render() puts the real
      // cursor state back immediately afterwards, and because nothing is removed
      // here, the appear animations do not all fire at once on load.
      for (const { el } of built.reveals[player.stage]) el.classList.add("is-shown");

      player.body.style.minHeight = "";
      const style = window.getComputedStyle(player.body);
      const cap = Number.parseFloat(style.maxHeight);
      // scrollHeight excludes borders, which min-height on a border-box element
      // has to cover.
      const chrome = player.body.offsetHeight - player.body.clientHeight;
      const needed = player.body.scrollHeight + chrome;
      player.body.style.minHeight = `${Number.isFinite(cap) ? Math.min(needed, cap) : needed}px`;
    }
  }

  function setCursor(player: StagePlayer, next: number): void {
    const trace = built?.traces[player.stage];
    const steps = trace?.steps.length ?? 0;
    player.cursor = clamp(next, steps);
    player.scrubber.value = String(player.cursor);
    setProgress(player.bar, player.cursor, steps - 1);
    render(player);
  }

  function render(player: StagePlayer): void {
    if (!built) return;
    const trace = built.traces[player.stage];
    const step = trace.steps[player.cursor];

    for (const { el, step: at } of built.reveals[player.stage]) {
      el.classList.toggle("is-shown", at <= player.cursor);
      // Only artefacts carry the current-step marker; containers stamped with
      // `data-grow` are structure, and outlining them would be noise.
      el.classList.toggle(
        "is-current",
        at === player.cursor && el.dataset.reveal !== undefined,
      );
    }

    player.position.textContent =
      trace.steps.length === 0
        ? "NO STEPS"
        : `STEP ${player.cursor + 1} / ${trace.steps.length}`;
    player.title.textContent = step?.title ?? "did not run";
    player.explain.textContent =
      step?.explain ?? "The compiler stopped before this stage.";

    const section = player.body.closest(".stage");
    section?.classList.toggle("is-empty", trace.steps.length === 0);

    // Grammar rules do not appear and accumulate; only the marker moves — and
    // the list is taller than the box, so the marked rule is scrolled to.
    for (const rule of player.rules.querySelectorAll<HTMLElement>("[data-rule]")) {
      const marked = rule.dataset.rule === step?.rule;
      rule.classList.toggle("is-rule", marked);
      if (marked) keepInView(rule, rule.parentElement);
    }

    highlightEcho(player, step?.consumed ?? null);
    scrollCurrentIntoView(player);
  }

  // -------------------------------------------------------------- highlighting

  /**
   * The syntax regions for the current source, worked out once per compile
   * rather than once per paint: every stage repaints its echo on every step, so
   * this runs far more often than the compiler does.
   */
  let litSource: string | undefined;
  let litRegions: Region[] = [];

  function syntax(): Region[] {
    if (litSource !== compilation.source) {
      litSource = compilation.source;
      litRegions = regionsOf(litSource);
    }
    return litRegions;
  }

  /**
   * Rebuild a source echo: the C highlighted, with the step's span marked.
   * Text nodes only, never HTML — the source is the visitor's own input.
   *
   * The marked span is one `<mark>` with the highlighted pieces inside it, and
   * inside it they inherit the accent's colour: "here" is one colour, so syntax
   * never competes with it.
   */
  function paint(target: HTMLElement, span: Span | null): void {
    const text = compilation.source;
    target.replaceChildren();

    const covers = span ? (span.end - span.start) / Math.max(1, text.length) : 0;
    const marking =
      span && span.end > span.start && covers <= WHOLE_FILE_SHARE
        ? {
            start: Math.min(span.start, text.length),
            end: Math.min(span.end, text.length),
          }
        : null;

    let mark: HTMLElement | undefined;
    const parentFor = (at: number): HTMLElement => {
      if (!marking || at < marking.start || at >= marking.end) return target;
      if (!mark) {
        mark = document.createElement("mark");
        target.append(mark);
      }
      return mark;
    };

    for (const piece of pieces(text.length, syntax(), marking)) {
      const parent = parentFor(piece.start);
      const content = text.slice(piece.start, piece.end);
      if (piece.kind === undefined) {
        parent.append(document.createTextNode(content));
        continue;
      }
      const node = document.createElement("span");
      node.className = `tok tok-${piece.kind}`;
      node.textContent = content;
      parent.append(node);
    }
  }

  function highlightEcho(player: StagePlayer, span: Span | null): void {
    paint(player.echo, span);
  }

  function highlightEditor(span: Span | null): void {
    paint(mirror, span);
  }

  /**
   * Scroll a scrolling box just enough to show one of its children. Never
   * `scrollIntoView`, which would move the page itself and drag the reader away
   * from the stage they are watching.
   */
  function keepInView(child: HTMLElement, box: HTMLElement | null): void {
    if (!box) return;
    const inner = box.getBoundingClientRect();
    const outer = child.getBoundingClientRect();
    const margin = 16;
    if (outer.top < inner.top) {
      box.scrollTop -= inner.top - outer.top + margin;
    } else if (outer.bottom > inner.bottom) {
      box.scrollTop += outer.bottom - inner.bottom + margin;
    }
  }

  /** Keep the current artefact in view without moving the page. */
  function scrollCurrentIntoView(player: StagePlayer): void {
    const current = player.body.querySelector<HTMLElement>(".is-current");
    if (current) keepInView(current, player.body);
  }

  // ----------------------------------------------------------------- playback

  function playing(player: StagePlayer): boolean {
    return player.timer !== undefined;
  }

  function stop(player: StagePlayer): void {
    if (player.timer !== undefined) window.clearInterval(player.timer);
    player.timer = undefined;
    player.play.setAttribute("aria-pressed", "false");
    player.play.textContent = "PLAY";
  }

  function play(player: StagePlayer): void {
    const steps = built?.traces[player.stage].steps.length ?? 0;
    if (steps <= 1) return;
    // Pressing play at the end starts this stage over, as any player does.
    if (player.cursor >= steps - 1) setCursor(player, 0);
    player.play.setAttribute("aria-pressed", "true");
    player.play.textContent = "PAUSE";
    player.timer = window.setInterval(() => {
      if (player.cursor >= steps - 1) {
        stop(player);
        return;
      }
      setCursor(player, player.cursor + 1);
    }, SPEEDS[speedIndex].ms);
  }

  // ------------------------------------------------------------------ copying

  const COPY_RESET_MS = 1500;

  /**
   * Copy a pane's whole text, regardless of where its scrubber stands.
   *
   * An unrevealed artefact is `visibility: hidden`, not removed — that is what
   * keeps the tree from jumping as a stage plays — so `textContent` already
   * reads the complete, finished output no matter the cursor. Copying anything
   * narrower would mean scrubbing back to the start before copying the answer,
   * which is not what a copy button is for.
   *
   * Best-effort, the same way `prefs.ts` treats storage: the clipboard API is
   * absent in some sandboxed frames and can refuse for reasons a page never
   * finds out, so a failure is a label, not a thrown error.
   */
  function copyOutput(player: StagePlayer): void {
    const text = player.body.textContent ?? "";
    const said = (label: string) => {
      if (player.copyTimer !== undefined) window.clearTimeout(player.copyTimer);
      player.copy.textContent = label;
      player.copy.dataset.copied = label === "COPIED" ? "true" : "false";
      player.copyTimer = window.setTimeout(() => {
        player.copy.textContent = "COPY";
        delete player.copy.dataset.copied;
        player.copyTimer = undefined;
      }, COPY_RESET_MS);
    };

    if (!navigator.clipboard) {
      said("CAN'T COPY");
      return;
    }
    navigator.clipboard
      .writeText(text)
      .then(() => said("COPIED"))
      .catch(() => said("CAN'T COPY"));
  }

  // ----------------------------------------------------------------- settings

  /**
   * Speed is one setting for all six players: it is a reading rate, not stage
   * state, so a stage never owns it. Changing it while something is playing
   * restarts that player's interval at the new period and leaves its cursor
   * exactly where it was — the rate changed, not the position.
   */
  function applySpeed(index: number, remember: boolean): void {
    speedIndex = index;
    speed.value = String(index);
    setProgress(speedBar, index, SPEEDS.length - 1);
    const label = `×${SPEEDS[index].label}`;
    speedValue.textContent = label;
    // Without this a screen reader reads the raw index, which means nothing.
    speed.setAttribute("aria-valuetext", `${label}, ${SPEEDS[index].ms}ms per step`);
    if (remember) store(SPEED_KEY, String(index));
    for (const player of players) {
      if (!playing(player)) continue;
      stop(player);
      play(player);
    }
  }

  /**
   * Mark the dock chip for whatever section is on screen.
   *
   * An observer, not a scroll handler: the browser already knows what is
   * visible, and asking it on every scroll event would mean measuring layout
   * from script dozens of times a second. The chip nearest the top of the
   * viewport wins, so scrolling down hands "here" over one section at a time.
   *
   * Purely decorative — the links work without it, and without an observer at
   * all — so it is wrapped rather than assumed.
   */
  function watchSections(): void {
    const jumps = [...document.querySelectorAll<HTMLElement>("[data-jump]")];
    if (jumps.length === 0 || typeof IntersectionObserver === "undefined") return;

    const onScreen = new Set<string>();
    const mark = () => {
      // Two sections can be in the band at once, at the seam between them. The
      // one you have most recently arrived in is the one whose top is furthest
      // down — taking the first in document order instead marked the section you
      // were leaving, which is exactly backwards.
      let here: HTMLElement | undefined;
      let best = Number.NEGATIVE_INFINITY;
      for (const jump of jumps) {
        const id = jump.dataset.jump ?? "";
        if (!onScreen.has(id)) continue;
        const top = document.getElementById(id)?.getBoundingClientRect().top ?? 0;
        if (top >= best) {
          best = top;
          here = jump;
        }
      }
      for (const jump of jumps) jump.classList.toggle("is-here", jump === here);
    };

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) onScreen.add(entry.target.id);
          else onScreen.delete(entry.target.id);
        }
        mark();
      },
      // A band across the top of the viewport: "here" is what you are reading,
      // not everything the screen happens to touch.
      { rootMargin: "0px 0px -70% 0px" },
    );

    for (const jump of jumps) {
      const section = document.getElementById(jump.dataset.jump ?? "");
      if (section) observer.observe(section);
    }
  }

  /**
   * The palette is the whole document's, like the theme — and like the theme it
   * is only an attribute: every colour on the page is a custom property, so
   * changing one word restyles all six stages without touching a pane.
   *
   * The ids come from the select's own options rather than from the palette
   * data, which keeps the colour tables out of the bundle entirely.
   */
  function applyPalette(id: string, remember: boolean): void {
    const known = [...palette.options].map((option) => option.value);
    const next = paletteFrom(id, known);
    document.documentElement.dataset.palette = next;
    palette.value = next;
    if (remember) store(PALETTE_KEY, next);
  }

  function applyTheme(next: Theme, remember: boolean): void {
    document.documentElement.dataset.theme = next;
    // The button says what pressing it will do, which is why it is not a
    // toggle button with a fixed name and a pressed state.
    theme.textContent = next === "light" ? "DARK MODE" : "LIGHT MODE";
    if (remember) store(THEME_KEY, next);
  }

  // ------------------------------------------------------------------- events

  for (const player of players) {
    player.play.addEventListener("click", () => {
      if (playing(player)) stop(player);
      else play(player);
    });

    player.scrubber.addEventListener("input", () => {
      stop(player);
      setCursor(player, Number(player.scrubber.value));
    });

    // The range handles arrows and Home/End itself; space is what a player owes.
    player.scrubber.addEventListener("keydown", (event) => {
      if (event.key !== " ") return;
      event.preventDefault();
      if (playing(player)) stop(player);
      else play(player);
    });

    player.copy.addEventListener("click", () => copyOutput(player));
  }

  speed.addEventListener("input", () => {
    applySpeed(speedFrom(speed.value), true);
  });

  palette.addEventListener("change", () => {
    applyPalette(palette.value, true);
  });

  theme.addEventListener("click", () => {
    applyTheme(
      document.documentElement.dataset.theme === "light" ? "dark" : "light",
      true,
    );
  });

  source.addEventListener("input", () => {
    if (debounce !== undefined) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => recompile(), COMPILE_DEBOUNCE_MS);
  });

  source.addEventListener("scroll", () => {
    mirror.scrollTop = source.scrollTop;
    mirror.scrollLeft = source.scrollLeft;
  });

  // The head already set the theme from the same rule, before first paint; this
  // only puts the button's label in step with it.
  applyTheme(
    themeFrom(
      readStored(THEME_KEY),
      window.matchMedia?.("(prefers-color-scheme: light)").matches ?? false,
    ),
    false,
  );
  applySpeed(speedFrom(readStored(SPEED_KEY)), false);
  applyPalette(readStored(PALETTE_KEY) ?? "", false);
  watchSections();

  source.value = DEFAULT_PRESET.source;
  recompile();
}

/**
 * Where a bar stands, as a number from 0 to 1. The CSS turns it into a scale and
 * a translate, so moving a cursor costs no layout and the bar glides instead of
 * jumping. This is state, not layout: nothing here reads a size back.
 */
function setProgress(bar: HTMLElement, at: number, of: number): void {
  bar.style.setProperty("--progress", String(of > 0 ? at / of : 0));
}

function text(tag: string, className: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}
