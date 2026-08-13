// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { compile } from "../src/compiler/pipeline";
import { STAGES } from "../src/compiler/types";
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

  it("builds six independent players", () => {
    for (const stage of STAGES) {
      expect(scrubber(stage), stage).toBeTruthy();
      expect(playButton(stage), stage).toBeTruthy();
    }
  });

  it("starts every stage on its last step, so each section reads as finished", () => {
    for (const stage of STAGES) {
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
    const before = STAGES.map((stage) => shown(stage));
    scrubTo("parse", 0);
    const after = STAGES.map((stage) => shown(stage));

    STAGES.forEach((stage, index) => {
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
    for (const stage of STAGES) {
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
