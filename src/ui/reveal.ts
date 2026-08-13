import type { Compilation, StageId, Step } from "../compiler/types";
import { STAGES } from "../compiler/types";

/**
 * The visibility rule, in one place and with no DOM in sight.
 *
 * Each stage is its own player, so step numbers are LOCAL to a stage: the
 * scanner's step 3 is the third thing the scanner did, not the third thing the
 * compiler did. The global order still exists in `Step.index`, but nothing in the
 * page needs it any more.
 */

export type StageTrace = {
  stage: StageId;
  steps: Step[];
  /** artefact id -> the local step index that produced it. */
  producedAt: Map<string, number>;
};

export function traceOf(compilation: Compilation, stage: StageId): StageTrace {
  const steps = compilation.steps.filter((step) => step.stage === stage);
  const producedAt = new Map<string, number>();
  steps.forEach((step, local) => {
    for (const id of step.produced) {
      if (!producedAt.has(id)) producedAt.set(id, local);
    }
  });
  return { stage, steps, producedAt };
}

export function tracesOf(compilation: Compilation): Record<StageId, StageTrace> {
  const traces = {} as Record<StageId, StageTrace>;
  for (const stage of STAGES) traces[stage] = traceOf(compilation, stage);
  return traces;
}

/** Every artefact visible when this stage's player is standing on `cursor`. */
export function visibleIn(trace: StageTrace, cursor: number): string[] {
  const at = clamp(cursor, trace.steps.length);
  const visible: string[] = [];
  for (const [id, step] of trace.producedAt) {
    if (step <= at) visible.push(id);
  }
  return visible;
}

/** A cursor can only ever name a step that exists. */
export function clamp(cursor: number, length: number): number {
  const last = Math.max(0, length - 1);
  if (Number.isNaN(cursor)) return 0;
  return Math.min(Math.max(Math.trunc(cursor), 0), last);
}
