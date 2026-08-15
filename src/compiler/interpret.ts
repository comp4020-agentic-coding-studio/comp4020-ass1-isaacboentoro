import { functionsOf, layoutFrame } from "./frames";
import { formatInstr } from "./ir";
import { StepLog } from "./steps";
import type {
  Diagnostic,
  IRInstr,
  IRValue,
  SemanticsResult,
  Span,
  Step,
} from "./types";

/**
 * Runs the three-address listing from stage five.
 *
 * Not a seventh rewrite — nothing is translated here. This executes the exact
 * instructions the page just showed being built, which is the point: the thing
 * that produces the answer is the thing you watched come into existence, on the
 * frame layout the assembly pane is addressing.
 *
 * Memory is one flat byte array, so a pointer is an index into it. That is close
 * enough to the truth to be worth showing, and it is what makes an out-of-bounds
 * write visible rather than theoretical: `a[5]` on a three-element array quietly
 * lands on whatever sits next to it, exactly as C would.
 */

/** 64 KB of stack. More than this subset can sensibly use. */
const MEMORY_BYTES = 64 * 1024;

/** Where the first frame's base sits; frames grow downwards from here. */
const STACK_TOP = MEMORY_BYTES - 16;

/** Runaway guards. A visitor can write `while (1) {}` and will. */
const MAX_STEPS = 200_000;
const MAX_DEPTH = 200;

/** The trace the page can scrub; execution continues past it, untraced. */
const MAX_TRACE = 4_000;

export type Effect = {
  id: string;
  /** What changed, as the listing would write it. */
  text: string;
  /** The instruction that caused it. */
  instr: string;
  span: Span;
};

export type InterpretResult = {
  /** What `main` returned, if it got there. */
  value?: number;
  effects: Effect[];
  steps: Step[];
  /** Instructions executed, including any past the end of the trace. */
  executed: number;
  truncated: boolean;
  error?: Diagnostic;
};

class Trap extends Error {
  constructor(
    override readonly message: string,
    readonly span: Span,
    readonly hint?: string,
  ) {
    super(message);
  }
}

type FunctionBody = {
  name: string;
  instrs: IRInstr[];
  frame: number;
  temps: Map<string, number>;
  labels: Map<string, number>;
};

class Machine {
  readonly log = new StepLog("run");
  readonly effects: Effect[] = [];
  readonly memory = new DataView(new ArrayBuffer(MEMORY_BYTES));
  private readonly functions = new Map<string, FunctionBody>();
  private readonly slots = new Map<string, number>();
  executed = 0;
  truncated = false;

  constructor(instrs: IRInstr[], semantics: SemanticsResult) {
    for (const symbol of semantics.symbols) {
      if (symbol.slot !== undefined) this.slots.set(symbol.id, symbol.slot);
    }

    for (const body of functionsOf(instrs)) {
      const head = body[0];
      if (head.op !== "enter") continue;
      const { temps, size } = layoutFrame(body, head.frame);
      const labels = new Map<string, number>();
      body.forEach((instr, index) => {
        if (instr.op === "label") labels.set(instr.name, index);
      });
      this.functions.set(head.func, {
        name: head.func,
        instrs: body,
        frame: size,
        temps,
        labels,
      });
    }
  }

  // ------------------------------------------------------------------ memory

  private read(address: number, width: number, span: Span): number {
    this.checkAddress(address, width, span);
    if (width >= 8) return Number(this.memory.getBigInt64(address, true));
    if (width >= 4) return this.memory.getInt32(address, true);
    return this.memory.getInt8(address);
  }

  private write(address: number, width: number, value: number, span: Span): void {
    this.checkAddress(address, width, span);
    if (width >= 8) this.memory.setBigInt64(address, BigInt(value), true);
    else if (width >= 4) this.memory.setInt32(address, value | 0, true);
    else this.memory.setInt8(address, value & 0xff);
  }

  /**
   * Only accesses outside the whole array are trapped. Landing on a neighbouring
   * variable is not an error — it is what C does, and refusing it here would
   * teach the opposite of the truth.
   */
  private checkAddress(address: number, width: number, span: Span): void {
    if (!Number.isFinite(address) || address < 0 || address + width > MEMORY_BYTES) {
      throw new Trap(
        `tried to touch address ${address}, which is outside memory`,
        span,
        "A pointer that was never given a real address, or arithmetic that ran a long way off the end.",
      );
    }
  }

  /** The address a var or temp lives at, given the current frame pointer. */
  private addressOf(value: IRValue, fp: number, span: Span): number {
    if (value.kind === "temp") return fp + (this.currentTemps?.get(value.name) ?? 0);
    if (value.kind === "var") return fp + (this.slots.get(value.symbol) ?? 0);
    throw new Trap("a constant has no address", span);
  }

  private currentTemps: Map<string, number> | undefined;

  private load(value: IRValue, fp: number, span: Span): number {
    if (value.kind === "const") return value.value;
    return this.read(this.addressOf(value, fp, span), value.width, span);
  }

  private store(value: IRValue, fp: number, result: number, span: Span): void {
    if (value.kind === "const") throw new Trap("cannot assign to a constant", span);
    const address = this.addressOf(value, fp, span);
    this.write(address, value.width, result, span);
    this.note(value, address, result, span);
  }

  private note(target: IRValue, address: number, result: number, span: Span): void {
    if (this.effects.length >= MAX_TRACE) return;
    const name = target.kind === "const" ? "?" : target.name;
    this.effects.push({
      id: `run:${this.effects.length}`,
      text: `${name} = ${result}`,
      instr: `at ${address}`,
      span,
    });
  }

  // --------------------------------------------------------------- execution

  run(): number | undefined {
    const main = this.functions.get("main");
    if (!main) {
      throw new Trap("there is no main to run", { start: 0, end: 0 });
    }
    return this.call(main, [], STACK_TOP, 0);
  }

  /**
   * One activation. The frame pointer moves down by this function's size, which
   * is why a deep recursion eventually walks off the bottom of memory — and why
   * the depth guard exists.
   */
  private call(
    func: FunctionBody,
    args: number[],
    callerFp: number,
    depth: number,
  ): number | undefined {
    if (depth > MAX_DEPTH) {
      throw new Trap(
        "the stack ran out",
        func.instrs[0].span,
        `More than ${MAX_DEPTH} calls deep. Real C would crash here too — recursion is not free.`,
      );
    }

    const fp = callerFp - func.frame;
    const restoreTemps = this.currentTemps;
    this.currentTemps = func.temps;

    // Parameters arrive already in their slots, which is exactly what the
    // prologue's register spill does in the assembly pane.
    for (const [index, slot] of (this.paramSlots.get(func.name) ?? []).entries()) {
      this.write(fp + slot.offset, slot.width, args[index] ?? 0, func.instrs[0].span);
    }

    let pc = 1;
    let result: number | undefined;

    while (pc < func.instrs.length) {
      const instr = func.instrs[pc];
      this.executed += 1;
      if (this.executed > MAX_STEPS) {
        throw new Trap(
          "this program does not stop",
          instr.span,
          `Still running after ${MAX_STEPS.toLocaleString()} instructions, so it was cut off. A loop with no way out looks exactly like this.`,
        );
      }

      const before = this.effects.length;
      const next = this.step(instr, func, fp, depth);
      this.trace(instr, before);

      if (next === "return") {
        result = this.returned;
        break;
      }
      pc = typeof next === "number" ? next : pc + 1;
    }

    this.currentTemps = restoreTemps;
    return result;
  }

  private returned: number | undefined;

  private readonly paramSlots = new Map<
    string,
    { offset: number; width: number }[]
  >();

  setParams(name: string, slots: { offset: number; width: number }[]): void {
    this.paramSlots.set(name, slots);
  }

  /** Run one instruction. Returns a new pc for a jump, or "return". */
  private step(
    instr: IRInstr,
    func: FunctionBody,
    fp: number,
    depth: number,
  ): number | "return" | void {
    const span = instr.span;

    switch (instr.op) {
      case "enter":
      case "label":
        return;

      case "move":
        this.store(instr.dest, fp, this.load(instr.src, fp, span), span);
        return;

      case "addr":
        this.store(instr.dest, fp, fp + (this.slots.get(instr.symbol) ?? 0), span);
        return;

      case "load": {
        const address = this.load(instr.from, fp, span);
        this.store(instr.dest, fp, this.read(address, instr.width, span), span);
        return;
      }

      case "store": {
        const address = this.load(instr.to, fp, span);
        const value = this.load(instr.src, fp, span);
        this.write(address, instr.width, value, span);
        if (this.effects.length < MAX_TRACE) {
          this.effects.push({
            id: `run:${this.effects.length}`,
            text: `*${instr.to.kind === "const" ? instr.to.value : instr.to.name} = ${value}`,
            instr: `wrote ${instr.width} byte${instr.width === 1 ? "" : "s"} at ${address}`,
            span,
          });
        }
        return;
      }

      case "unary": {
        const operand = this.load(instr.operand, fp, span);
        this.store(
          instr.dest,
          fp,
          instr.operator === "-" ? -operand | 0 : operand === 0 ? 1 : 0,
          span,
        );
        return;
      }

      case "binary": {
        const left = this.load(instr.left, fp, span);
        const right = this.load(instr.right, fp, span);
        this.store(
          instr.dest,
          fp,
          this.arithmetic(instr.operator, left, right, span),
          span,
        );
        return;
      }

      case "jump":
      case "branchFalse":
      case "branchTrue": {
        if (instr.op !== "jump") {
          const condition = this.load(instr.cond, fp, span);
          const take = instr.op === "branchFalse" ? condition === 0 : condition !== 0;
          if (!take) return;
        }
        const target = func.labels.get(instr.target);
        if (target === undefined) throw new Trap(`no label ${instr.target}`, span);
        return target;
      }

      case "call": {
        const callee = this.functions.get(instr.callee);
        if (!callee) throw new Trap(`no function ${instr.callee}`, span);
        const args = instr.args.map((arg) => this.load(arg, fp, span));
        const value = this.call(callee, args, fp, depth + 1);
        // The callee left its own temp map behind; this frame's is current again.
        this.currentTemps = func.temps;
        if (instr.dest) this.store(instr.dest, fp, value ?? 0, span);
        return;
      }

      case "return": {
        this.returned = instr.value ? this.load(instr.value, fp, span) : undefined;
        return "return";
      }
    }
  }

  private arithmetic(op: string, left: number, right: number, span: Span): number {
    switch (op) {
      case "+":
        return (left + right) | 0;
      case "-":
        return (left - right) | 0;
      case "*":
        return Math.imul(left, right);
      case "/":
      case "%": {
        if (right === 0) {
          throw new Trap(
            "divided by zero",
            span,
            "The processor raises a fault for this; nothing in the compiler could have caught it.",
          );
        }
        const quotient = Math.trunc(left / right);
        return op === "/" ? quotient | 0 : (left - quotient * right) | 0;
      }
      case "==":
        return left === right ? 1 : 0;
      case "!=":
        return left !== right ? 1 : 0;
      case "<":
        return left < right ? 1 : 0;
      case ">":
        return left > right ? 1 : 0;
      case "<=":
        return left <= right ? 1 : 0;
      case ">=":
        return left >= right ? 1 : 0;
      default:
        throw new Trap(`no rule for \`${op}\``, span);
    }
  }

  /** One step per instruction executed, until the trace is full. */
  private trace(instr: IRInstr, effectsBefore: number): void {
    if (this.log.all().length >= MAX_TRACE) {
      this.truncated = true;
      return;
    }
    const produced = this.effects.slice(effectsBefore).map((effect) => effect.id);
    this.log.add(
      formatInstr(instr),
      EXPLAIN[instr.op] ?? "One instruction, executed.",
      instr.span,
      produced,
    );
  }

}

const EXPLAIN: Record<string, string> = {
  move: "A value copied into a slot. Nothing computed — this is the traffic that a register allocator exists to remove.",
  addr: "An address handed over. The variable had to be in memory for this to be possible at all.",
  load: "Reading through a pointer: fetch the address, then fetch what is at it.",
  store: "Writing through a pointer. Nothing checks that the address belongs to you.",
  binary: "Two values in, one out.",
  unary: "One value in, one out.",
  jump: "The instruction pointer moves. That is the whole of control flow.",
  branchFalse: "A test, then a jump — or not.",
  branchTrue: "A test, then a jump — or not.",
  call: "A new frame below this one, and the arguments placed where the callee expects them.",
  return: "The frame is finished with. Its slots are still in memory; nothing wipes them.",
  label: "A name for a position.",
  enter: "A frame claimed.",
};

/**
 * Run a compiled program.
 *
 * Never throws: a program that divides by zero or never stops is content, the
 * same as a program that does not compile.
 */
export function interpret(
  instrs: IRInstr[],
  semantics: SemanticsResult,
): InterpretResult {
  const machine = new Machine(instrs, semantics);

  // Parameters live in the slots the analyser assigned them, and the caller
  // writes them there — which is what the prologue's register spill does.
  for (const [name, frame] of Object.entries(semantics.frames)) {
    void frame;
    const params = semantics.symbols.filter(
      (symbol) => symbol.role === "param" && symbol.owner === name,
    );
    machine.setParams(
      name,
      params.map((param) => ({
        offset: param.slot ?? 0,
        width: Math.max(1, Math.min(8, sizeOfSymbol(param.type))),
      })),
    );
  }

  try {
    const value = machine.run();
    // The answer is the last thing the trace reveals, so it lands with the
    // instruction that produced it rather than sitting there from the start.
    if (value !== undefined) {
      machine.effects.push({
        id: "run:result",
        text: `main returned ${value}`,
        instr: `after ${machine.executed} instructions`,
        span: { start: 0, end: 0 },
      });
      machine.log.produce("run:result");
    }
    return {
      ...(value === undefined ? {} : { value }),
      effects: machine.effects,
      steps: machine.log.all(),
      executed: machine.executed,
      truncated: machine.truncated,
    };
  } catch (thrown) {
    if (thrown instanceof Trap) {
      return {
        effects: machine.effects,
        steps: machine.log.all(),
        executed: machine.executed,
        truncated: machine.truncated,
        error: {
          stage: "run",
          message: thrown.message,
          span: thrown.span,
          ...(thrown.hint ? { hint: thrown.hint } : {}),
        },
      };
    }
    throw thrown;
  }
}

/** Local copy to avoid importing the whole type module into the hot path. */
function sizeOfSymbol(type: { kind: string }): number {
  switch (type.kind) {
    case "char":
      return 1;
    case "pointer":
      return 8;
    default:
      return 4;
  }
}
