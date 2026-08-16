import { generate } from "./codegen";
import { interpret } from "./interpret";
import { lower } from "./ir";
import { EMPTY_ALLOCATION, allocate } from "./regalloc";
import { scan } from "./lexer";
import { parse } from "./parser";
import { preprocess } from "./preprocess";
import { analyse } from "./semantics";
import type { Compilation, StageId, Step } from "./types";

/**
 * Runs the stages and glues their step traces into one flat list.
 *
 * The flat list is the product. A stage that fails contributes the steps it
 * managed before failing and then stops the run, which is why a broken program
 * still has something to scrub through: you can watch the compiler get as far as
 * it got and see exactly where it gave up.
 */

const EMPTY_STEPS: Step[] = [];

export function compile(source: string): Compilation {
  const steps: Step[] = [];
  const reached: StageId[] = [];

  const add = (stageSteps: Step[]) => {
    for (const step of stageSteps) {
      steps.push({ ...step, index: steps.length });
    }
  };

  const pre = preprocess(source);
  add(pre.steps);
  if (pre.error) {
    return blank(source, steps, reached, { preprocess: pre }, pre.error);
  }
  reached.push("preprocess");

  const scanned = scan(pre.text, pre.map);
  add(scanned.steps);
  if (scanned.error) {
    return blank(
      source,
      steps,
      reached,
      { preprocess: pre, scan: scanned },
      scanned.error,
    );
  }
  reached.push("scan");

  const parsed = parse(scanned.tokens);
  add(parsed.steps);
  if (parsed.error) {
    return blank(
      source,
      steps,
      reached,
      { preprocess: pre, scan: scanned, parse: parsed },
      parsed.error,
    );
  }
  reached.push("parse");

  const semantics = analyse(parsed.program);
  add(semantics.steps);
  if (semantics.error) {
    return blank(
      source,
      steps,
      reached,
      { preprocess: pre, scan: scanned, parse: parsed, semantics },
      semantics.error,
    );
  }
  reached.push("semantics");

  const ir = lower(parsed.program, semantics);
  add(ir.steps);
  reached.push("ir");

  // Not a rewrite either: the listing is unchanged afterwards. What comes out is
  // a decision about where each of its temporaries lives, which codegen then
  // spends.
  const regalloc = allocate(ir.instrs);
  add(regalloc.steps);
  reached.push("regalloc");

  const codegen = generate(ir.instrs, semantics, regalloc);
  add(codegen.steps);
  reached.push("codegen");

  // Running is not a rewrite, so it comes after the pipeline rather than in it.
  // It executes the IR, not the assembly: the assembly would need a processor,
  // and the IR is what the page just showed being built.
  const run = interpret(ir.instrs, semantics);
  add(run.steps);
  reached.push("run");

  return {
    run,
    source,
    steps,
    preprocess: pre,
    scan: scanned,
    parse: parsed,
    semantics,
    ir,
    regalloc,
    codegen,
    reached,
  };
}

/** A compilation that stopped early: later stages exist but are empty. */
function blank(
  source: string,
  steps: Step[],
  reached: StageId[],
  parts: Partial<Compilation>,
  error: Compilation["error"],
): Compilation {
  return {
    source,
    steps,
    preprocess:
      parts.preprocess ??
      { text: "", map: [], expansions: [], steps: EMPTY_STEPS },
    scan: parts.scan ?? { tokens: [], steps: EMPTY_STEPS },
    parse:
      parts.parse ??
      {
        program: {
          id: "ast:0",
          kind: "Program",
          span: { start: 0, end: 0 },
          functions: [],
        },
        steps: EMPTY_STEPS,
      },
    semantics:
      parts.semantics ??
      {
        symbols: [],
        resolved: {},
        types: {},
        frames: {},
        steps: EMPTY_STEPS,
      },
    ir: parts.ir ?? { instrs: [], steps: EMPTY_STEPS },
    regalloc: parts.regalloc ?? EMPTY_ALLOCATION,
    codegen: parts.codegen ?? { lines: [], steps: EMPTY_STEPS },
    reached,
    ...(error ? { error } : {}),
  };
}
