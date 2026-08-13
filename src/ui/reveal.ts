import type { Compilation } from "../compiler/types";

/**
 * The visibility rule, in one place and with no DOM in sight.
 *
 * "An artefact is visible once the step that produced it has happened" is the
 * whole contract of the page, so it is worth being able to state it as a pure
 * function and test it without a browser.
 */

/** artefact id -> the index of the step that first produced it. */
export function producedAt(compilation: Compilation): Map<string, number> {
  const map = new Map<string, number>();
  for (const step of compilation.steps) {
    for (const id of step.produced) {
      if (!map.has(id)) map.set(id, step.index);
    }
  }
  return map;
}

/** Every artefact visible when standing on `cursor`. */
export function visibleAt(compilation: Compilation, cursor: number): string[] {
  const at = producedAt(compilation);
  const visible: string[] = [];
  for (const [id, step] of at) {
    if (step <= clampCursor(compilation, cursor)) visible.push(id);
  }
  return visible;
}

/** The cursor can only ever name a step that exists. */
export function clampCursor(compilation: Compilation, cursor: number): number {
  const last = Math.max(0, compilation.steps.length - 1);
  if (Number.isNaN(cursor)) return 0;
  return Math.min(Math.max(Math.trunc(cursor), 0), last);
}
