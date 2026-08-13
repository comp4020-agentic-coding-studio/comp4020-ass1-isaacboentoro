import { compile } from "../compiler/pipeline";
import type { Compilation, StageId } from "../compiler/types";
import { STAGES, STAGE_TITLES } from "../compiler/types";
import { type BuiltPanes, buildPanes } from "./panes";
import { DEFAULT_PRESET, PRESETS } from "./presets";

/**
 * One control drives everything on this page.
 *
 * The whole visible state is a single integer: which step of the compilation we
 * are standing on. Panes are built once per compile and then only have classes
 * toggled, so dragging the scrubber stays smooth on a phone, and nothing about
 * the layout can reset the cursor — resizing mid-drag is safe because the cursor
 * lives here, in JavaScript, and the layout lives entirely in CSS.
 */

const PLAY_INTERVAL_MS = 90;
const COMPILE_DEBOUNCE_MS = 120;

type Elements = {
  source: HTMLTextAreaElement;
  mirror: HTMLElement;
  presets: HTMLElement;
  scrubber: HTMLInputElement;
  play: HTMLButtonElement;
  position: HTMLElement;
  title: HTMLElement;
  explain: HTMLElement;
  ticks: HTMLElement;
  pipeline: HTMLElement;
  panes: Record<StageId, HTMLElement>;
};

function required<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`missing element #${id}`);
  return found as T;
}

export function start(): void {
  const panes = {} as Record<StageId, HTMLElement>;
  // The scrolling body and the section that wraps it are different elements: the
  // body is what panes.ts fills, the section is what the phone layout shows or
  // hides. Mixing them up made every pane invisible at 390px.
  const wrappers = {} as Record<StageId, HTMLElement>;
  for (const stage of STAGES) {
    const body = required<HTMLElement>(`pane-${stage}`);
    panes[stage] = body;
    wrappers[stage] = body.closest(".pane") ?? body;
  }

  const dom: Elements = {
    source: required<HTMLTextAreaElement>("source"),
    mirror: required("mirror"),
    presets: required("presets"),
    scrubber: required<HTMLInputElement>("scrubber"),
    play: required<HTMLButtonElement>("play"),
    position: required("position"),
    title: required("step-title"),
    explain: required("step-explain"),
    ticks: required("stage-ticks"),
    pipeline: required("pipeline"),
    panes,
  };

  let compilation: Compilation = compile(DEFAULT_PRESET.source);
  let built: BuiltPanes = { reveals: [], bodies: panes };
  let cursor = 0;
  let timer: number | undefined;
  let debounce: number | undefined;

  // ------------------------------------------------------------------ presets

  for (const preset of PRESETS) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "preset";
    button.append(withClass("span", "preset-name", preset.name));
    button.append(withClass("span", "preset-about", preset.about));
    button.addEventListener("click", () => {
      dom.source.value = preset.source;
      recompile({ jumpToEnd: true });
    });
    dom.presets.append(button);
  }

  // ------------------------------------------------------------ stage jumping

  const tickButtons = new Map<StageId, HTMLButtonElement>();
  for (const stage of STAGES) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tick";
    button.dataset.stage = stage;
    button.textContent = STAGE_TITLES[stage];
    button.addEventListener("click", () => {
      const first = compilation.steps.find((step) => step.stage === stage);
      if (first) setCursor(first.index);
    });
    dom.ticks.append(button);
    tickButtons.set(stage, button);
  }

  // -------------------------------------------------------------------- state

  function recompile(options: { jumpToEnd?: boolean } = {}): void {
    stop();
    compilation = compile(dom.source.value);
    built = buildPanes(compilation, dom.panes);

    const last = Math.max(0, compilation.steps.length - 1);
    dom.scrubber.max = String(last);
    dom.scrubber.disabled = compilation.steps.length <= 1;

    for (const [stage, button] of tickButtons) {
      const reachable = compilation.steps.some((step) => step.stage === stage);
      button.disabled = !reachable;
    }

    setCursor(options.jumpToEnd ? last : Math.min(cursor, last));
  }

  function setCursor(next: number): void {
    const last = Math.max(0, compilation.steps.length - 1);
    cursor = Math.min(Math.max(next, 0), last);
    dom.scrubber.value = String(cursor);
    render();
  }

  function render(): void {
    const step = compilation.steps[cursor];

    for (const { el, step: at } of built.reveals) {
      el.classList.toggle("is-shown", at <= cursor);
      el.classList.toggle("is-current", at === cursor);
    }

    dom.position.textContent = `step ${cursor + 1} of ${compilation.steps.length}`;
    dom.title.textContent = step ? step.title : "nothing to do";
    dom.explain.textContent = step ? step.explain : "";

    const stage = step?.stage ?? "preprocess";
    dom.pipeline.dataset.activeStage = stage;
    for (const [id, wrapper] of Object.entries(wrappers)) {
      wrapper.classList.toggle("is-active", id === stage);
    }
    for (const [id, button] of tickButtons) {
      button.setAttribute("aria-current", id === stage ? "step" : "false");
    }

    highlight(step?.consumed ?? null);
    scrollCurrentIntoView(stage);
  }

  // ------------------------------------------------------- editor highlighting

  function highlight(span: { start: number; end: number } | null): void {
    const text = compilation.source;
    dom.mirror.replaceChildren();
    if (!span || span.end <= span.start) {
      dom.mirror.append(document.createTextNode(text));
      return;
    }
    const start = Math.min(span.start, text.length);
    const end = Math.min(span.end, text.length);
    dom.mirror.append(document.createTextNode(text.slice(0, start)));
    const mark = document.createElement("mark");
    mark.textContent = text.slice(start, end);
    dom.mirror.append(mark);
    dom.mirror.append(document.createTextNode(text.slice(end)));
  }

  /** Keep the current artefact visible without scrolling the whole page. */
  function scrollCurrentIntoView(stage: StageId): void {
    const body = built.bodies[stage];
    if (!body) return;
    const current = body.querySelector<HTMLElement>(".is-current");
    if (!current) return;

    const scroller = dom.panes[stage];
    const top = current.offsetTop - scroller.offsetTop;
    const bottom = top + current.offsetHeight;
    if (top < scroller.scrollTop) {
      scroller.scrollTop = Math.max(0, top - 16);
    } else if (bottom > scroller.scrollTop + scroller.clientHeight) {
      scroller.scrollTop = bottom - scroller.clientHeight + 16;
    }
  }

  // ----------------------------------------------------------------- playback

  function playing(): boolean {
    return timer !== undefined;
  }

  function stop(): void {
    if (timer !== undefined) window.clearInterval(timer);
    timer = undefined;
    dom.play.setAttribute("aria-pressed", "false");
    dom.play.textContent = "Play";
  }

  function play(): void {
    if (compilation.steps.length <= 1) return;
    // Pressing play at the end starts over, the way any player does.
    if (cursor >= compilation.steps.length - 1) setCursor(0);
    dom.play.setAttribute("aria-pressed", "true");
    dom.play.textContent = "Pause";
    timer = window.setInterval(() => {
      if (cursor >= compilation.steps.length - 1) {
        stop();
        return;
      }
      setCursor(cursor + 1);
    }, PLAY_INTERVAL_MS);
  }

  dom.play.addEventListener("click", () => {
    if (playing()) stop();
    else play();
  });

  // ------------------------------------------------------------------- events

  dom.scrubber.addEventListener("input", () => {
    stop();
    setCursor(Number(dom.scrubber.value));
  });

  // The range handles arrows and Home/End itself; space is the one a player owes you.
  dom.scrubber.addEventListener("keydown", (event) => {
    if (event.key === " ") {
      event.preventDefault();
      if (playing()) stop();
      else play();
    }
  });

  dom.source.addEventListener("input", () => {
    if (debounce !== undefined) window.clearTimeout(debounce);
    debounce = window.setTimeout(() => recompile(), COMPILE_DEBOUNCE_MS);
  });

  // The mirror sits under a transparent textarea, so their scroll must agree.
  dom.source.addEventListener("scroll", () => {
    dom.mirror.scrollTop = dom.source.scrollTop;
    dom.mirror.scrollLeft = dom.source.scrollLeft;
  });

  dom.source.value = DEFAULT_PRESET.source;
  recompile({ jumpToEnd: true });
}

function withClass(tag: string, className: string, text: string): HTMLElement {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
