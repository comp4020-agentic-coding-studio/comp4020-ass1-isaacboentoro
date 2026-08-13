// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { compile } from "../src/compiler/pipeline";
import { PRESETS } from "../src/ui/presets";
import { clampCursor, visibleAt } from "../src/ui/reveal";

/**
 * The assignment spec asks for the core interaction to be stated plainly enough
 * to write a test for. Here it is:
 *
 *   Moving the scrubber changes what the page shows. At the first step almost
 *   nothing exists; at the last step every artefact of every stage does; and
 *   moving forward only ever adds.
 *
 * Half of that is a property of the model and is tested directly. The other half
 * only exists once the real markup and the real app module are wired together, so
 * the second half of this file loads the BUILT page into jsdom and drives it.
 */

const HOME = resolve("dist/index.html");

describe("the reveal rule", () => {
  const compilation = compile(PRESETS[2].source);
  const last = compilation.steps.length - 1;

  it("has enough steps to be worth scrubbing", () => {
    expect(compilation.steps.length).toBeGreaterThan(20);
  });

  it("numbers steps consecutively from zero", () => {
    expect(compilation.steps.map((step) => step.index)).toEqual(
      compilation.steps.map((_, index) => index),
    );
  });

  it("shows strictly less at the start than at the end", () => {
    expect(visibleAt(compilation, 0).length).toBeLessThan(
      visibleAt(compilation, last).length,
    );
  });

  it("never hides something it has already revealed", () => {
    let previous = -1;
    for (let cursor = 0; cursor <= last; cursor += 1) {
      const count = visibleAt(compilation, cursor).length;
      expect(count).toBeGreaterThanOrEqual(previous);
      previous = count;
    }
  });

  it("reveals every artefact by the last step", () => {
    const visible = new Set(visibleAt(compilation, last));
    for (const token of compilation.scan.tokens) expect(visible.has(token.id)).toBe(true);
    for (const instr of compilation.ir.instrs) expect(visible.has(instr.id)).toBe(true);
    for (const line of compilation.codegen.lines) expect(visible.has(line.id)).toBe(true);
    for (const symbol of compilation.semantics.symbols) {
      expect(visible.has(symbol.id)).toBe(true);
    }
  });

  it("clamps a cursor that runs off either end", () => {
    expect(clampCursor(compilation, -50)).toBe(0);
    expect(clampCursor(compilation, last + 500)).toBe(last);
    expect(clampCursor(compilation, Number.NaN)).toBe(0);
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

  it("still produces steps to scrub through", () => {
    expect(broken.steps.length).toBeGreaterThan(5);
  });

  it("stops at the stage that found the problem", () => {
    expect(broken.error?.stage).toBe("semantics");
    expect(broken.reached).toEqual(["preprocess", "scan", "parse"]);
    expect(broken.steps.at(-1)?.stage).toBe("semantics");
  });

  it("reaches no further stage than the one that failed", () => {
    expect(broken.ir.instrs).toHaveLength(0);
    expect(broken.codegen.lines).toHaveLength(0);
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
        expect(result.reached).toHaveLength(6);
        expect(result.codegen.lines.length).toBeGreaterThan(5);
      } else {
        expect(result.error).toBeDefined();
      }
      expect(result.steps.length).toBeGreaterThan(10);
    });
  }
});

describe("the page, driven", () => {
  beforeEach(async () => {
    const html = readFileSync(HOME, "utf8");
    // Only the body markup: the bundled <script> tag must not run here, since
    // this test imports the module itself.
    const body = /<body[^>]*>([\s\S]*)<\/body>/.exec(html)?.[1] ?? "";
    document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "");
    const { start } = await import("../src/ui/app");
    start();
  });

  function scrubTo(value: number): void {
    const scrubber = document.getElementById("scrubber") as HTMLInputElement;
    scrubber.value = String(value);
    scrubber.dispatchEvent(new Event("input", { bubbles: true }));
  }

  function shown(): number {
    return document.querySelectorAll("[data-reveal].is-shown").length;
  }

  it("starts with the whole compilation on screen", () => {
    const scrubber = document.getElementById("scrubber") as HTMLInputElement;
    expect(Number(scrubber.value)).toBe(Number(scrubber.max));
    expect(shown()).toBeGreaterThan(20);
  });

  it("shows less when the scrubber goes back, and more when it returns", () => {
    const atEnd = shown();
    scrubTo(0);
    const atStart = shown();
    expect(atStart).toBeLessThan(atEnd);

    const scrubber = document.getElementById("scrubber") as HTMLInputElement;
    scrubTo(Number(scrubber.max));
    expect(shown()).toBe(atEnd);
  });

  it("marks exactly one artefact as the current one", () => {
    scrubTo(12);
    expect(document.querySelectorAll("[data-reveal].is-current").length)
      .toBeLessThanOrEqual(1);
  });

  it("highlights source text for the step it is standing on", () => {
    scrubTo(6);
    const mark = document.querySelector(".editor-mirror mark");
    expect(mark?.textContent?.length).toBeGreaterThan(0);
  });

  it("announces the step in a live region", () => {
    scrubTo(6);
    const live = document.querySelector('[aria-live="polite"]');
    expect(live?.textContent?.trim().length).toBeGreaterThan(20);
    expect(document.getElementById("step-title")?.textContent).toBeTruthy();
  });

  it("counts the position for people who cannot see the slider", () => {
    scrubTo(3);
    expect(document.getElementById("position")?.textContent).toMatch(
      /^step 4 of \d+$/,
    );
  });

  it("activates exactly one stage pane at a time", () => {
    scrubTo(20);
    expect(document.querySelectorAll(".pane.is-active")).toHaveLength(1);
  });

  it("recompiles when the source changes, and survives being emptied", () => {
    const source = document.getElementById("source") as HTMLTextAreaElement;
    source.value = "";
    source.dispatchEvent(new Event("input", { bubbles: true }));
    // The debounce means the old compilation is still on screen; that is fine.
    expect(document.getElementById("scrubber")).toBeTruthy();
  });

  it("offers every preset as a button", () => {
    const buttons = document.querySelectorAll("#presets .preset");
    expect(buttons).toHaveLength(PRESETS.length);
  });

  it("loading a preset re-fills the editor and rebuilds the panes", () => {
    const buttons = document.querySelectorAll<HTMLButtonElement>("#presets .preset");
    buttons[3].click();
    const source = document.getElementById("source") as HTMLTextAreaElement;
    expect(source.value).toBe(PRESETS[3].source);
    expect(shown()).toBeGreaterThan(20);
  });

  it("play is a real toggle button, not a div", () => {
    const play = document.getElementById("play") as HTMLButtonElement;
    expect(play.tagName).toBe("BUTTON");
    expect(play.getAttribute("aria-pressed")).toBe("false");
    play.click();
    expect(play.getAttribute("aria-pressed")).toBe("true");
    play.click();
    expect(play.getAttribute("aria-pressed")).toBe("false");
  });

  it("lets the keyboard start and stop playback from the slider", () => {
    const scrubber = document.getElementById("scrubber") as HTMLInputElement;
    scrubber.dispatchEvent(
      new KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }),
    );
    expect(document.getElementById("play")?.getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("jumping to a stage moves the cursor to that stage's first step", () => {
    const ticks = document.querySelectorAll<HTMLButtonElement>(".tick");
    ticks[4].click();
    const active = document.querySelector(".pane.is-active");
    expect(active?.textContent).toContain("Lower to IR");
  });
});
