import { compile } from "../compiler/pipeline";
import type { Compilation, Span, StageId } from "../compiler/types";
import { STAGES } from "../compiler/types";
import { type BuiltPanes, buildPanes } from "./panes";
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

/** One step per this long. The commentary is a sentence, so it has to be read. */
const PLAY_INTERVAL_MS = 900;
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
  echo: HTMLElement;
  body: HTMLElement;
  cursor: number;
  timer?: number;
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

  let compilation: Compilation = compile(DEFAULT_PRESET.source);
  let built: BuiltPanes | undefined;
  let debounce: number | undefined;

  const players: StagePlayer[] = STAGES.map((stage) => ({
    stage,
    scrubber: required<HTMLInputElement>(`scrub-${stage}`),
    play: required<HTMLButtonElement>(`play-${stage}`),
    position: required(`pos-${stage}`),
    title: required(`title-${stage}`),
    explain: required(`explain-${stage}`),
    echo: required(`echo-${stage}`),
    body: required(`pane-${stage}`),
    cursor: 0,
  }));

  // ------------------------------------------------------------------ presets

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

    for (const player of players) {
      const steps = built.traces[player.stage].steps.length;
      player.scrubber.max = String(Math.max(0, steps - 1));
      player.scrubber.disabled = steps <= 1;
      player.play.disabled = steps <= 1;
      // Land on the end so the section reads as finished, then rewind to watch.
      setCursor(player, Math.max(0, steps - 1));
    }
  }

  function bodies(): Record<StageId, HTMLElement> {
    const map = {} as Record<StageId, HTMLElement>;
    for (const player of players) map[player.stage] = player.body;
    return map;
  }

  function setCursor(player: StagePlayer, next: number): void {
    const trace = built?.traces[player.stage];
    const steps = trace?.steps.length ?? 0;
    player.cursor = clamp(next, steps);
    player.scrubber.value = String(player.cursor);
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

    highlightEcho(player, step?.consumed ?? null);
    scrollCurrentIntoView(player);
  }

  // -------------------------------------------------------------- highlighting

  /** Rebuild a source echo with one span marked. Text nodes only, never HTML. */
  function paint(target: HTMLElement, span: Span | null): void {
    const text = compilation.source;
    target.replaceChildren();
    const covers = span ? (span.end - span.start) / Math.max(1, text.length) : 0;
    if (!span || span.end <= span.start || covers > WHOLE_FILE_SHARE) {
      target.append(document.createTextNode(text));
      return;
    }
    const start = Math.min(span.start, text.length);
    const end = Math.min(span.end, text.length);
    target.append(document.createTextNode(text.slice(0, start)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(start, end);
    target.append(mark);
    target.append(document.createTextNode(text.slice(end)));
  }

  function highlightEcho(player: StagePlayer, span: Span | null): void {
    paint(player.echo, span);
  }

  function highlightEditor(span: Span | null): void {
    paint(mirror, span);
  }

  /** Keep the current artefact in view without moving the page. */
  function scrollCurrentIntoView(player: StagePlayer): void {
    const current = player.body.querySelector<HTMLElement>(".is-current");
    if (!current) return;
    const top = current.offsetTop - player.body.offsetTop;
    const bottom = top + current.offsetHeight;
    if (top < player.body.scrollTop) {
      player.body.scrollTop = Math.max(0, top - 16);
    } else if (bottom > player.body.scrollTop + player.body.clientHeight) {
      player.body.scrollTop = bottom - player.body.clientHeight + 16;
    }
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
    }, PLAY_INTERVAL_MS);
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
  }

  source.addEventListener("input", () => {
    if (debounce !== undefined) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => recompile(), COMPILE_DEBOUNCE_MS);
  });

  source.addEventListener("scroll", () => {
    mirror.scrollTop = source.scrollTop;
    mirror.scrollLeft = source.scrollLeft;
  });

  source.value = DEFAULT_PRESET.source;
  recompile();
}

function text(tag: string, className: string, content: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = content;
  return node;
}
