// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { compile } from "../src/compiler/pipeline";
import { PLAYERS, STAGES } from "../src/compiler/types";
import { DEFAULT_PALETTE, PALETTES } from "../src/ui/palettes";
import {
  DEFAULT_SPEED,
  PALETTE_KEY,
  SPEEDS,
  SPEED_KEY,
  THEME_KEY,
} from "../src/ui/prefs";
import { PRESETS } from "../src/ui/presets";
import { clamp, traceOf, tracesOf, visibleIn } from "../src/ui/reveal";

/**
 * The assignment spec asks for the core interaction to be stated plainly enough
 * to write a test for. Here it is:
 *
 *   Each stage is its own player. Playing or scrubbing a stage changes what that
 *   stage shows and nothing else: at its first step almost none of its artefacts
 *   exist, at its last step all of them do, and moving forward only ever adds.
 *
 * The model half is tested directly. The wiring half only exists once the real
 * markup and the real app module meet, so the second half of this file loads the
 * BUILT page into jsdom and drives it.
 */

const HOME = resolve("dist/index.html");

describe("the reveal rule, per stage", () => {
  const compilation = compile(PRESETS[2].source);
  const traces = tracesOf(compilation);

  it("gives every stage its own steps, numbered from zero", () => {
    for (const stage of STAGES) {
      const trace = traces[stage];
      expect(trace.steps.length, stage).toBeGreaterThan(0);
      for (const step of trace.steps) expect(step.stage).toBe(stage);
    }
  });

  it("numbers steps locally, so a stage never counts another stage's work", () => {
    // The scanner's first step is its own step 0, even though it is not the
    // compilation's step 0.
    const scan = traces.scan;
    expect(scan.steps[0].index).toBeGreaterThan(0);
    expect(Math.min(...scan.producedAt.values())).toBe(0);
    for (const local of scan.producedAt.values()) {
      expect(local).toBeLessThan(scan.steps.length);
    }
  });

  it("shows strictly less at a stage's start than at its end", () => {
    for (const stage of STAGES) {
      const trace = traces[stage];
      if (trace.producedAt.size === 0) continue;
      expect(visibleIn(trace, 0).length, stage).toBeLessThan(
        visibleIn(trace, trace.steps.length - 1).length,
      );
    }
  });

  it("never hides something a stage has already revealed", () => {
    for (const stage of STAGES) {
      const trace = traces[stage];
      let previous = -1;
      for (let cursor = 0; cursor < trace.steps.length; cursor += 1) {
        const count = visibleIn(trace, cursor).length;
        expect(count, stage).toBeGreaterThanOrEqual(previous);
        previous = count;
      }
    }
  });

  it("reveals every one of a stage's artefacts by its last step", () => {
    const last = (stage: (typeof STAGES)[number]) =>
      new Set(visibleIn(traces[stage], traces[stage].steps.length - 1));

    for (const token of compilation.scan.tokens) {
      expect(last("scan").has(token.id)).toBe(true);
    }
    for (const instr of compilation.ir.instrs) {
      expect(last("ir").has(instr.id)).toBe(true);
    }
    for (const line of compilation.codegen.lines) {
      expect(last("codegen").has(line.id)).toBe(true);
    }
    for (const symbol of compilation.semantics.symbols) {
      expect(last("semantics").has(symbol.id)).toBe(true);
    }
  });

  it("keeps each stage's artefacts out of every other stage's trace", () => {
    const seen = new Map<string, string>();
    for (const stage of STAGES) {
      for (const id of traces[stage].producedAt.keys()) {
        expect(seen.has(id), `${id} produced by two stages`).toBe(false);
        seen.set(id, stage);
      }
    }
  });

  it("clamps a cursor that runs off either end", () => {
    const length = traces.scan.steps.length;
    expect(clamp(-50, length)).toBe(0);
    expect(clamp(length + 500, length)).toBe(length - 1);
    expect(clamp(Number.NaN, length)).toBe(0);
    expect(clamp(3, 0)).toBe(0);
  });

  it("every step explains itself in a sentence", () => {
    for (const step of compilation.steps) {
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.explain.length).toBeGreaterThan(20);
    }
  });
});

describe("a program that does not compile", () => {
  const broken = compile("int main() { return nope; }");

  it("stops at the stage that found the problem", () => {
    expect(broken.error?.stage).toBe("semantics");
    expect(broken.reached).toEqual(["preprocess", "scan", "parse"]);
  });

  it("leaves the stages after it with no steps to play", () => {
    expect(traceOf(broken, "ir").steps).toHaveLength(0);
    expect(traceOf(broken, "codegen").steps).toHaveLength(0);
  });

  it("still gives the failing stage something to play", () => {
    expect(traceOf(broken, "semantics").steps.length).toBeGreaterThan(0);
  });
});

describe("every preset", () => {
  for (const preset of PRESETS) {
    // "A mistake" exists to fail; every other preset must compile clean.
    const shouldCompile = preset.name !== "A mistake";

    it(`${preset.name}: ${shouldCompile ? "compiles" : "fails on purpose"}`, () => {
      const result = compile(preset.source);
      if (shouldCompile) {
        expect(result.error).toBeUndefined();
        // Six rewrites, then running it.
        expect(result.reached).toHaveLength(PLAYERS.length);
        expect(result.codegen.lines.length).toBeGreaterThan(5);
      } else {
        expect(result.error).toBeDefined();
      }
      expect(result.steps.length).toBeGreaterThan(10);
    });
  }
});

/**
 * jsdom under this Node gives the window no `localStorage` at all, so the two
 * remembered preferences would have nothing to be remembered in. The app copes
 * with that on purpose — storage throws in a sandboxed frame too — but a test
 * that cannot store cannot check that it stored, so here is a plain one.
 */
function fakeStorage(): void {
  if (window.localStorage) return;
  const kept = new Map<string, string>();
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => kept.get(key) ?? null,
      setItem: (key: string, value: string) => void kept.set(key, String(value)),
      removeItem: (key: string) => void kept.delete(key),
      clear: () => kept.clear(),
      key: (index: number) => [...kept.keys()][index] ?? null,
      get length() {
        return kept.size;
      },
    },
  });
}

describe("the page, driven", () => {
  beforeEach(async () => {
    fakeStorage();
    window.localStorage.clear();
    const html = readFileSync(HOME, "utf8");
    // Only the body markup: the bundled <script> must not run here, since this
    // test imports the module itself.
    const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";
    document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "");
    const { start } = await import("../src/ui/app");
    start();
  });

  function scrubber(stage: string): HTMLInputElement {
    return document.getElementById(`scrub-${stage}`) as HTMLInputElement;
  }

  function playButton(stage: string): HTMLButtonElement {
    return document.getElementById(`play-${stage}`) as HTMLButtonElement;
  }

  function scrubTo(stage: string, value: number): void {
    const input = scrubber(stage);
    input.value = String(value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function shown(stage: string): number {
    const pane = document.getElementById(`pane-${stage}`);
    return pane?.querySelectorAll("[data-reveal].is-shown").length ?? 0;
  }

  afterEach(() => {
    vi.useRealTimers();
    window.localStorage.clear();
  });

  function setSpeed(index: number): void {
    const speed = document.getElementById("speed") as HTMLInputElement;
    speed.value = String(index);
    speed.dispatchEvent(new Event("input", { bubbles: true }));
  }

  it("plays at the rate the speed control asks for", () => {
    vi.useFakeTimers();
    const slowest = 0;
    const fastest = SPEEDS.length - 1;

    setSpeed(slowest);
    scrubTo("scan", 0);
    playButton("scan").click();
    // One tick short of the slow period: a step here would mean the control did
    // nothing, which is how this looked before the rate was wired up.
    vi.advanceTimersByTime(SPEEDS[slowest].ms - 50);
    expect(Number(scrubber("scan").value)).toBe(0);
    vi.advanceTimersByTime(100);
    expect(Number(scrubber("scan").value)).toBe(1);
    playButton("scan").click();

    setSpeed(fastest);
    scrubTo("scan", 0);
    playButton("scan").click();
    vi.advanceTimersByTime(SPEEDS[fastest].ms * 3);
    expect(Number(scrubber("scan").value)).toBe(3);
    playButton("scan").click();
  });

  it("changes speed mid-play without losing the cursor or stopping", () => {
    vi.useFakeTimers();
    setSpeed(0);
    scrubTo("scan", 0);
    playButton("scan").click();
    vi.advanceTimersByTime(SPEEDS[0].ms);
    expect(Number(scrubber("scan").value)).toBe(1);

    setSpeed(SPEEDS.length - 1);
    // The rate changed, not the position — and it is still playing.
    expect(Number(scrubber("scan").value)).toBe(1);
    expect(playButton("scan").getAttribute("aria-pressed")).toBe("true");
    vi.advanceTimersByTime(SPEEDS[SPEEDS.length - 1].ms);
    expect(Number(scrubber("scan").value)).toBe(2);
    playButton("scan").click();
  });

  function progressOf(id: string): number {
    const bar = document.getElementById(id) as HTMLElement;
    return Number(bar.style.getPropertyValue("--progress"));
  }

  it("moves each bar with its own cursor, as a fraction", () => {
    // The bar is drawn from this one number, so if it is wrong the bar lies
    // about where the stage is even though the input is right.
    const max = Number(scrubber("scan").max);
    scrubTo("scan", 0);
    expect(progressOf("bar-scan")).toBe(0);
    scrubTo("scan", max);
    expect(progressOf("bar-scan")).toBe(1);
    scrubTo("scan", Math.round(max / 2));
    expect(progressOf("bar-scan")).toBeCloseTo(Math.round(max / 2) / max, 5);
  });

  it("leaves every other bar where it was", () => {
    scrubTo("parse", 0);
    const before = progressOf("bar-parse");
    scrubTo("scan", Number(scrubber("scan").max));
    expect(progressOf("bar-parse")).toBe(before);
  });

  it("keeps a bar with nothing to play at zero rather than at NaN", () => {
    // A stage that never ran has max 0, and 0/0 would paint the whole bar full.
    vi.useFakeTimers();
    const broken = document.getElementById("source") as HTMLTextAreaElement;
    broken.value = "int main() { return nope; }";
    broken.dispatchEvent(new Event("input", { bubbles: true }));
    // Editing is debounced, so the compile only happens once the clock moves.
    vi.advanceTimersByTime(200);
    vi.useRealTimers();
    expect(Number(scrubber("codegen").max)).toBe(0);
    expect(progressOf("bar-codegen")).toBe(0);
  });

  it("moves the speed bar with the speed", () => {
    setSpeed(0);
    expect(progressOf("bar-speed")).toBe(0);
    setSpeed(SPEEDS.length - 1);
    expect(progressOf("bar-speed")).toBe(1);
  });

  it("opens at 1×, the rate the commentary was written for", () => {
    // `Number(null)` is 0, which is a real index, so a first visit used to open
    // at half speed. The screenshot said so before any test did.
    const speed = document.getElementById("speed") as HTMLInputElement;
    expect(Number(speed.value)).toBe(DEFAULT_SPEED);
    expect(SPEEDS[DEFAULT_SPEED].label).toBe("1");
    expect(document.getElementById("speed-value")?.textContent).toBe("×1");
  });

  it("drives all six players from the one speed, and remembers it", () => {
    expect(document.querySelectorAll('[id^="speed"]')).toHaveLength(2); // range + reading
    setSpeed(4);
    expect(window.localStorage.getItem(SPEED_KEY)).toBe("4");
    expect(document.getElementById("speed-value")?.textContent).toBe(
      `×${SPEEDS[4].label}`,
    );
    // The reading is for eyes; a screen reader needs the value spoken too.
    expect(
      document.getElementById("speed")?.getAttribute("aria-valuetext"),
    ).toContain(SPEEDS[4].label);
  });

  it("dresses the whole document in the chosen palette, and remembers", async () => {
    const select = document.getElementById("palette") as HTMLSelectElement;
    const chosen = PALETTES.find((palette) => palette.id !== DEFAULT_PALETTE);
    select.value = chosen?.id ?? "";
    select.dispatchEvent(new Event("change", { bubbles: true }));

    // One attribute on <html> is the whole change: every colour is a custom
    // property, so no pane is touched and no cursor moves.
    expect(document.documentElement.dataset.palette).toBe(chosen?.id);
    expect(window.localStorage.getItem(PALETTE_KEY)).toBe(chosen?.id);

    // A palette that no longer exists must not leave the page colourless.
    window.localStorage.setItem(PALETTE_KEY, "solarised-neon");
    const { start } = await import("../src/ui/app");
    start();
    expect(document.documentElement.dataset.palette).toBe(DEFAULT_PALETTE);
    expect(select.value).toBe(DEFAULT_PALETTE);
  });

  it("keeps the palette and the theme independent", () => {
    const select = document.getElementById("palette") as HTMLSelectElement;
    const toggle = document.getElementById("theme") as HTMLButtonElement;
    const other = PALETTES.find((palette) => palette.id !== DEFAULT_PALETTE);
    select.value = other?.id ?? "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    const before = document.documentElement.dataset.theme;

    toggle.click();
    expect(document.documentElement.dataset.theme).not.toBe(before);
    // Switching light and dark must not throw the palette away, and vice versa.
    expect(document.documentElement.dataset.palette).toBe(other?.id);
  });

  it("toggles the theme, says what it will do next, and remembers", async () => {
    const toggle = document.getElementById("theme") as HTMLButtonElement;
    const before = document.documentElement.dataset.theme;
    toggle.click();
    const after = document.documentElement.dataset.theme;
    expect(after).not.toBe(before);
    expect(after === "light" || after === "dark").toBe(true);
    expect(toggle.textContent).toBe(after === "light" ? "DARK MODE" : "LIGHT MODE");
    expect(window.localStorage.getItem(THEME_KEY)).toBe(after);

    // A stored choice survives a reload, and beats the system preference.
    window.localStorage.setItem(THEME_KEY, "light");
    const { start } = await import("../src/ui/app");
    start();
    expect(document.documentElement.dataset.theme).toBe("light");
    expect(toggle.textContent).toBe("DARK MODE");
  });

  it("builds a player for every section", () => {
    for (const stage of PLAYERS) {
      expect(scrubber(stage), stage).toBeTruthy();
      expect(playButton(stage), stage).toBeTruthy();
    }
  });

  it("starts every stage on its last step, so each section reads as finished", () => {
    for (const stage of PLAYERS) {
      const input = scrubber(stage);
      expect(Number(input.value), stage).toBe(Number(input.max));
    }
    expect(shown("scan")).toBeGreaterThan(5);
  });

  it("shows less when a stage rewinds, and more when it returns", () => {
    const atEnd = shown("scan");
    scrubTo("scan", 0);
    expect(shown("scan")).toBeLessThan(atEnd);
    scrubTo("scan", Number(scrubber("scan").max));
    expect(shown("scan")).toBe(atEnd);
  });

  it("scrubbing one stage leaves every other stage alone", () => {
    const before = PLAYERS.map((stage) => shown(stage));
    scrubTo("parse", 0);
    const after = PLAYERS.map((stage) => shown(stage));

    PLAYERS.forEach((stage, index) => {
      if (stage === "parse") {
        expect(after[index], stage).toBeLessThan(before[index]);
      } else {
        expect(after[index], stage).toBe(before[index]);
      }
    });
  });

  it("marks one step's worth of artefacts as current, not one element", () => {
    // A single codegen step emits several assembly lines, so "current" is a set,
    // not a singleton — but every element in it must belong to the same step.
    scrubTo("codegen", 4);
    for (const stage of PLAYERS) {
      const pane = document.getElementById(`pane-${stage}`);
      const current = [
        ...(pane?.querySelectorAll<HTMLElement>("[data-reveal].is-current") ?? []),
      ];
      const steps = new Set(current.map((el) => el.dataset.reveal));
      expect(steps.size, stage).toBeLessThanOrEqual(1);
    }
    const codegenCurrent = document
      .getElementById("pane-codegen")
      ?.querySelectorAll("[data-reveal].is-current").length;
    expect(codegenCurrent).toBeGreaterThan(1);
  });

  it("each stage highlights the source it is reading, in its own echo", () => {
    scrubTo("scan", 3);
    const marked = document
      .getElementById("echo-scan")
      ?.querySelector("mark")?.textContent;
    expect(marked?.length).toBeGreaterThan(0);
  });

  it("grows the parse tree instead of filling in a fixed skeleton", () => {
    const parse = document.getElementById("scrub-parse") as HTMLInputElement;
    const nodesShown = () =>
      document.querySelectorAll("#pane-parse .tree-node.is-shown").length;
    const branchesShown = () =>
      document.querySelectorAll("#pane-parse .tree-children.is-shown").length;

    scrubTo("parse", 0);
    const first = { nodes: nodesShown(), branches: branchesShown() };
    scrubTo("parse", Number(parse.max));
    const last = { nodes: nodesShown(), branches: branchesShown() };

    expect(first.nodes).toBeGreaterThan(0);
    expect(first.nodes).toBeLessThan(last.nodes);
    // Indentation arrives with the nodes: a branch only exists once something in
    // it has been built.
    expect(first.branches).toBeLessThan(last.branches);
  });

  it("never leaves a tree node on screen without its branch above it", () => {
    scrubTo("parse", 3);
    for (const node of document.querySelectorAll("#pane-parse .tree-node.is-shown")) {
      const branch = node.parentElement;
      if (branch?.classList.contains("tree-children")) {
        expect(branch.classList.contains("is-shown")).toBe(true);
      }
    }
  });

  it("draws the interference graph, and colours it as the stage plays", () => {
    // The opening preset computes one intermediate value, which is not a graph.
    // The loop one computes several, so it has something to say.
    const loop = PRESETS.findIndex((preset) => preset.name === "Loop");
    document.querySelectorAll<HTMLButtonElement>("#presets .preset")[loop].click();

    const scrub = document.getElementById("scrub-regalloc") as HTMLInputElement;
    const nodes = () =>
      document.querySelectorAll("#pane-regalloc .graph-node.is-shown").length;
    const coloured = () =>
      document.querySelectorAll("#pane-regalloc .alloc-reg.is-shown").length;

    expect(document.querySelectorAll("#pane-regalloc .graph")).toHaveLength(1);
    scrubTo("regalloc", 0);
    // The first step introduces one value and has coloured nothing: the graph
    // has to exist before anything can be said about colouring it.
    expect(nodes()).toBe(1);
    expect(coloured()).toBe(0);

    scrubTo("regalloc", Number(scrub.max));
    expect(nodes()).toBeGreaterThan(1);
    expect(coloured()).toBe(nodes());
  });

  it("keeps the graph out of the accessibility tree, and the table in it", () => {
    // Eleven-pixel text on a circle is not how anyone reads a table. The drawing
    // is the argument; the table is the content, and axe only ever sees the one
    // that is actually readable.
    const graph = document.querySelector("#pane-regalloc .graph");
    expect(graph?.getAttribute("aria-hidden")).toBe("true");
    const headings = [
      ...document.querySelectorAll("#pane-regalloc .allocation th"),
    ].map((node) => node.textContent);
    expect(headings).toContain("lives in");
  });

  it("shows the grammar and marks the rule the current step applied", () => {
    const rules = document.querySelectorAll("#rules-parse .rule");
    expect(rules.length).toBeGreaterThan(10);

    const markedAt = (cursor: number) => {
      scrubTo("parse", cursor);
      const marked = document.querySelectorAll<HTMLElement>("#rules-parse .rule.is-rule");
      // One rule at a time: the accent means "here", and here is one place.
      expect(marked.length).toBeLessThanOrEqual(1);
      return marked[0]?.dataset.rule;
    };

    const seen = new Set<string | undefined>();
    const max = Number((document.getElementById("scrub-parse") as HTMLInputElement).max);
    for (let cursor = 0; cursor <= max; cursor += 1) seen.add(markedAt(cursor));
    seen.delete(undefined);
    expect(seen.size).toBeGreaterThan(3);
  });

  it("leaves the grammar visible at every step, unlike the artefacts", () => {
    // Rules are not produced by the stage, so they never hide.
    scrubTo("parse", 0);
    for (const rule of document.querySelectorAll("#rules-parse .rule")) {
      expect(rule.hasAttribute("data-reveal")).toBe(false);
    }
  });

  it("gives the stages with no grammar no listing at all", () => {
    expect(document.querySelectorAll("#rules-ir .rule")).toHaveLength(0);
    expect(document.querySelectorAll("#rules-codegen .rule")).toHaveLength(0);
    expect(document.querySelectorAll("#rules-scan .rule").length).toBeGreaterThan(3);
  });

  it("does not highlight the whole file for a step that is about the whole file", () => {
    // "lay out main's frame" spans the function; marking every line of a short
    // program is noise, so above 60% coverage the commentary carries it alone.
    const semantics = document.getElementById("scrub-semantics") as HTMLInputElement;
    scrubTo("semantics", Number(semantics.max));
    const echo = document.getElementById("echo-semantics");
    const marked = echo?.querySelector("mark")?.textContent ?? "";
    const source = (document.getElementById("source") as HTMLTextAreaElement).value;
    expect(marked.length / source.length).toBeLessThan(0.6);
  });

  it("shows the same source it was given, highlighted", () => {
    // Colouring the C must not add, drop or reorder a character: the echo and
    // the editor mirror are what the reader compares against what they typed.
    const source = (document.getElementById("source") as HTMLTextAreaElement).value;
    scrubTo("scan", 4);
    for (const id of ["mirror", "echo-scan", "echo-parse", "echo-codegen"]) {
      expect(document.getElementById(id)?.textContent, id).toBe(source);
    }
    const keywords = document.querySelectorAll("#echo-scan .tok-keyword");
    expect(keywords.length).toBeGreaterThan(0);
    for (const token of keywords) expect(source).toContain(token.textContent ?? "");
  });

  it("keeps the accent alone inside a highlight", () => {
    // Syntax colour is the one other place hue is used, so it must not compete
    // with the marker: tokens inside a mark set no colour of their own.
    scrubTo("scan", 1);
    const mark = document.getElementById("echo-scan")?.querySelector("mark");
    expect(mark?.textContent?.length).toBeGreaterThan(0);
    // One mark per step: "here" is one place.
    expect(document.querySelectorAll("#echo-scan mark")).toHaveLength(1);
    for (const token of mark?.querySelectorAll("[class*='tok-']") ?? []) {
      expect((token as HTMLElement).style.color).toBe("");
    }
  });

  it("moving one stage does not move another stage's highlight", () => {
    scrubTo("scan", 2);
    const first = document.getElementById("echo-scan")?.querySelector("mark")
      ?.textContent;
    scrubTo("parse", 2);
    const stillFirst = document.getElementById("echo-scan")?.querySelector("mark")
      ?.textContent;
    expect(stillFirst).toBe(first);
  });

  it("announces each stage's step in its own live region", () => {
    scrubTo("ir", 2);
    const region = document
      .getElementById("stage-ir")
      ?.querySelector('[aria-live="polite"]');
    expect(region?.textContent?.trim().length).toBeGreaterThan(20);
  });

  it("counts the position for people who cannot see the slider", () => {
    scrubTo("scan", 3);
    expect(document.getElementById("pos-scan")?.textContent).toMatch(
      /^STEP 4 \/ \d+$/,
    );
  });

  it("each play button is a real independent toggle", () => {
    const scan = playButton("scan");
    const parse = playButton("parse");
    expect(scan.tagName).toBe("BUTTON");

    scan.click();
    expect(scan.getAttribute("aria-pressed")).toBe("true");
    expect(parse.getAttribute("aria-pressed")).toBe("false");

    parse.click();
    expect(scan.getAttribute("aria-pressed")).toBe("true");
    expect(parse.getAttribute("aria-pressed")).toBe("true");

    scan.click();
    parse.click();
    expect(scan.getAttribute("aria-pressed")).toBe("false");
    expect(parse.getAttribute("aria-pressed")).toBe("false");
  });

  it("lets the keyboard start playback from a stage's slider", () => {
    scrubber("semantics").dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
    );
    expect(playButton("semantics").getAttribute("aria-pressed")).toBe("true");
  });

  it("disables the player for a stage that never ran", () => {
    const editor = document.getElementById("source") as HTMLTextAreaElement;
    editor.value = "int main() { return nope; }";
    editor.dispatchEvent(new Event("input", { bubbles: true }));

    return new Promise<void>((done) => {
      setTimeout(() => {
        expect(playButton("codegen").disabled).toBe(true);
        expect(scrubber("codegen").disabled).toBe(true);
        expect(playButton("semantics").disabled).toBe(false);
        expect(document.querySelectorAll(".diagnostic").length).toBeGreaterThan(0);
        done();
      }, 250);
    });
  });

  it("offers every preset as a button that reloads the editor", () => {
    const buttons = document.querySelectorAll<HTMLButtonElement>("#presets .preset");
    expect(buttons).toHaveLength(PRESETS.length);
    buttons[3].click();
    expect((document.getElementById("source") as HTMLTextAreaElement).value).toBe(
      PRESETS[3].source,
    );
    expect(shown("scan")).toBeGreaterThan(5);
  });

  it("survives being emptied", () => {
    const editor = document.getElementById("source") as HTMLTextAreaElement;
    editor.value = "";
    editor.dispatchEvent(new Event("input", { bubbles: true }));
    return new Promise<void>((done) => {
      setTimeout(() => {
        expect(document.getElementById("scrub-scan")).toBeTruthy();
        done();
      }, 250);
    });
  });
});
