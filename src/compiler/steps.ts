import type { Span, StageId, Step } from "./types";

/**
 * Accumulates the steps for one stage. Indexes are assigned globally later, by
 * `pipeline.ts`, so a stage never needs to know where it sits in the run.
 */
export class StepLog {
  private readonly steps: Step[] = [];

  constructor(private readonly stage: StageId) {}

  add(
    title: string,
    explain: string,
    consumed: Span | null,
    produced: string[] = [],
  ): void {
    this.steps.push({
      index: -1,
      stage: this.stage,
      title,
      explain,
      consumed,
      produced,
    });
  }

  /** Attach ids to the most recent step — for when the artefact is built after. */
  produce(...ids: string[]): void {
    const last = this.steps.at(-1);
    if (last) last.produced.push(...ids);
  }

  all(): Step[] {
    return this.steps;
  }
}
