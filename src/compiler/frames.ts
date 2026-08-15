import type { IRInstr, IRValue } from "./types";

/**
 * Where everything lives in a function's stack frame.
 *
 * Both backends need this and they must agree. Codegen turns these offsets into
 * `[rbp-N]`; the interpreter turns them into indices into a byte array. If the
 * two disagreed by so much as a byte, `&x` would mean one thing in the assembly
 * pane and another in the run pane, and the page would be quietly lying about
 * the connection between them.
 */

export type Frame = {
  /** temp name -> offset from the frame pointer, always negative. */
  temps: Map<string, number>;
  /** Total bytes to claim, 16-byte aligned as the ABI requires. */
  size: number;
};

/** Every value an instruction touches, so temps can be counted. */
export function valuesOf(instr: IRInstr): IRValue[] {
  switch (instr.op) {
    case "move":
      return [instr.dest, instr.src];
    case "binary":
      return [instr.dest, instr.left, instr.right];
    case "unary":
      return [instr.dest, instr.operand];
    case "branchFalse":
    case "branchTrue":
      return [instr.cond];
    case "call":
      return instr.dest ? [instr.dest, ...instr.args] : instr.args;
    case "return":
      return instr.value ? [instr.value] : [];
    case "addr":
      return [instr.dest];
    case "load":
      return [instr.dest, instr.from];
    case "store":
      return [instr.to, instr.src];
    default:
      return [];
  }
}

/**
 * Lay out one function's frame: the analyser's locals first, then a slot for
 * every temporary lowering invented, each aligned to its own width because an
 * 8-byte address cannot start halfway through a word.
 */
export function layoutFrame(body: IRInstr[], locals: number): Frame {
  const temps = new Map<string, number>();
  let used = locals;

  for (const instr of body) {
    for (const value of valuesOf(instr)) {
      if (value.kind === "temp" && !temps.has(value.name)) {
        const width = value.width;
        used = Math.ceil((used + width) / width) * width;
        temps.set(value.name, -used);
      }
    }
  }

  return { temps, size: Math.ceil(used / 16) * 16 };
}

/** Split a flat listing into one chunk per function. */
export function functionsOf(instrs: IRInstr[]): IRInstr[][] {
  const chunks: IRInstr[][] = [];
  for (const instr of instrs) {
    if (instr.op === "enter") chunks.push([]);
    chunks.at(-1)?.push(instr);
  }
  return chunks;
}
