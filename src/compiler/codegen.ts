import { StepLog } from "./steps";
import type {
  AsmLine,
  CodegenResult,
  IRInstr,
  IRValue,
  SemanticsResult,
  Span,
} from "./types";
import { sizeOf } from "./ctypes";
import { functionsOf, layoutFrame } from "./frames";
import { allocationFor, type RegallocResult } from "./regalloc";
import {
  ARG_REGISTERS,
  type Reg,
  SCRATCH_A,
  SCRATCH_B,
  regName,
} from "./registers";

/**
 * Code generation: the list becomes instructions a machine could run.
 *
 * Everything about where a value lives was decided by the stage before this one.
 * A temporary that got a colour is a register here and costs nothing to read; one
 * that did not is `[rbp-N]` and costs a load. That is the whole difference, and
 * it is why the same program can come out as three instructions or as seven.
 *
 * Named locals are never in registers. `&x` has to have an answer, and only
 * memory has an address — so a local sits in its frame slot for its whole life
 * and the traffic you see around it is the price of being able to point at it.
 *
 * `regalloc.ts` already decided which copies could be dissolved — a `dest` and
 * an operand it coalesced share a colour, so `into`/`fetch` below see the same
 * register on both sides and silently emit nothing for that `mov`. This file
 * never asks whether two values were coalesced; it only ever asks where a value
 * lives, which is exactly why the coalescing pays for itself here without a
 * special case.
 *
 * One honest simplification remains, stated on the page. There is no
 * rematerialisation, so a spilled constant is reloaded rather than recomputed.
 * And the output is assembly text, not machine code: turning this into bytes is
 * the assembler's job, and joining several objects together is the linker's,
 * neither of which runs on this page.
 *
 * Width is the thing pointers add here. A char is one byte, an int is four and an
 * address is eight, so the same IR instruction picks `al`, `eax` or `rax`
 * depending on what it is moving — and a char read into an int has to be
 * sign-extended rather than simply copied.
 */

/** `setcc` suffix per comparison operator. */
const SET_SUFFIX: Record<string, string> = {
  "==": "e",
  "!=": "ne",
  "<": "l",
  ">": "g",
  "<=": "le",
  ">=": "ge",
};

const ARITHMETIC: Record<string, string> = {
  "+": "add",
  "-": "sub",
  "*": "imul",
};

/** The size prefix an immediate-to-memory move needs to be unambiguous. */
function ptrSize(width: number): string {
  if (width >= 8) return "qword ptr";
  if (width >= 4) return "dword ptr";
  return "byte ptr";
}

function widthOf(value: IRValue): number {
  return value.kind === "const" ? 4 : value.width;
}

/**
 * Where a value actually is. Everything in here branches on this and nothing
 * else: the allocator's answer arrives as a `reg` instead of a `mem`, and the
 * instruction that comes out is shorter.
 */
export type Place =
  | { kind: "reg"; reg: Reg; width: number }
  | { kind: "mem"; text: string; width: number }
  | { kind: "const"; value: number };

type Emit = (text: string, comment?: string) => void;

class Emitter {
  readonly log = new StepLog("codegen");
  readonly lines: AsmLine[] = [];
  private nextId = 0;
  /** temp name -> frame offset, for the ones with no register. Reset per function. */
  private temps = new Map<string, number>();
  /** temp name -> register, from the allocator. Reset per function. */
  private colours = new Map<string, Reg>();
  private slots = new Map<string, number>();
  /** Callee-saved registers this function borrowed, and where they are parked. */
  private saved: { reg: Reg; at: number }[] = [];

  constructor(semantics: SemanticsResult) {
    for (const symbol of semantics.symbols) {
      if (symbol.slot !== undefined) this.slots.set(symbol.id, symbol.slot);
    }
  }

  line(
    kind: AsmLine["kind"],
    text: string,
    span: Span,
    from?: string,
    comment?: string,
  ): void {
    this.lines.push({
      id: `asm:${this.nextId}`,
      kind,
      text,
      span,
      ...(from ? { from } : {}),
      ...(comment ? { comment } : {}),
    });
    this.nextId += 1;
  }

  /** Ids of every line emitted since `mark`, for the step that caused them. */
  mark(): number {
    return this.lines.length;
  }

  since(mark: number): string[] {
    return this.lines.slice(mark).map((line) => line.id);
  }

  setFrame(
    temps: Map<string, number>,
    colours: Map<string, Reg>,
    saved: { reg: Reg; at: number }[],
  ): void {
    this.temps = temps;
    this.colours = colours;
    this.saved = saved;
  }

  savedRegisters(): { reg: Reg; at: number }[] {
    return this.saved;
  }

  /** The memory a named symbol lives in. Locals are never in registers. */
  slot(symbol: string): string {
    return `[rbp${offset(this.slots.get(symbol) ?? 0)}]`;
  }

  place(value: IRValue): Place {
    if (value.kind === "const") return { kind: "const", value: value.value };
    if (value.kind === "temp") {
      const reg = this.colours.get(value.name);
      if (reg) return { kind: "reg", reg, width: value.width };
      return {
        kind: "mem",
        text: `[rbp${offset(this.temps.get(value.name) ?? 0)}]`,
        width: value.width,
      };
    }
    return { kind: "mem", text: this.slot(value.symbol), width: value.width };
  }
}

function offset(value: number): string {
  return value < 0 ? String(value) : `+${value}`;
}

/**
 * Get a value into a named register at the width the instruction wants.
 *
 * The interesting case is a char being used as an int: reading four bytes from a
 * one-byte slot would take three bytes of whatever sits next to it, so the load
 * has to sign-extend instead. `movsx` is that instruction, and it is the whole of
 * C's integer promotion at machine level. The other interesting case is the one
 * that emits nothing at all, because the value is already in the register asked
 * for — which only ever happens because the allocator put it there.
 */
function fetch(
  target: Reg,
  want: number,
  place: Place,
  emit: Emit,
  note?: string,
): string {
  const name = regName(target, want);
  if (place.kind === "const") {
    emit(`mov ${name}, ${place.value}`, note);
    return name;
  }

  const widen = `${place.width}-byte value widened to ${want}, sign and all`;
  if (place.kind === "reg") {
    if (place.width === want) {
      if (place.reg !== target) emit(`mov ${name}, ${regName(place.reg, want)}`, note);
    } else if (place.width < want) {
      emit(`movsx ${name}, ${regName(place.reg, place.width)}`, note ?? widen);
    } else {
      emit(`mov ${name}, ${regName(place.reg, want)}`, note ?? "narrowed");
    }
    return name;
  }

  if (place.width === want) emit(`mov ${name}, ${place.text}`, note);
  else if (place.width < want) {
    emit(`movsx ${name}, ${ptrSize(place.width)} ${place.text}`, note ?? widen);
  } else emit(`mov ${name}, ${ptrSize(want)} ${place.text}`, note ?? "narrowed");
  return name;
}

function into(
  out: Emitter,
  target: Reg,
  want: number,
  value: IRValue,
  emit: Emit,
  note?: string,
): string {
  return fetch(target, want, out.place(value), emit, note);
}

/** Where a result should be computed: the destination's own register, or scratch. */
function working(out: Emitter, dest: IRValue): Reg {
  const place = out.place(dest);
  return place.kind === "reg" ? place.reg : SCRATCH_A;
}

/** Put what is in `from` where `dest` lives. Nothing to do if it is already there. */
function put(
  out: Emitter,
  dest: IRValue,
  from: Reg,
  emit: Emit,
  note?: string,
): void {
  const place = out.place(dest);
  if (place.kind === "reg") {
    if (place.reg !== from) {
      emit(`mov ${regName(place.reg, place.width)}, ${regName(from, place.width)}`, note);
    }
    return;
  }
  if (place.kind === "mem") {
    emit(`mov ${place.text}, ${regName(from, place.width)}`, note ?? "store");
  }
}

/**
 * The right-hand operand of an instruction that can take one from memory.
 *
 * `add eax, [rbp-8]` and `cmp eax, 3` are both legal, so forcing every operand
 * through a register would add an instruction per line for no reason. The one
 * case that cannot be direct is a width mismatch, where the value has to be
 * sign-extended before it can be used at all.
 */
function rhs(
  out: Emitter,
  want: number,
  value: IRValue,
  scratch: Reg,
  emit: Emit,
): string {
  const place = out.place(value);
  if (place.kind === "const") return String(place.value);
  if (place.width === want) {
    return place.kind === "reg" ? regName(place.reg, want) : place.text;
  }
  return fetch(scratch, want, place, emit);
}

export function generate(
  instrs: IRInstr[],
  semantics: SemanticsResult,
  allocation: RegallocResult,
): CodegenResult {
  const out = new Emitter(semantics);
  const log = out.log;
  const wholeProgram: Span =
    instrs.length > 0
      ? { start: instrs[0].span.start, end: instrs[instrs.length - 1].span.end }
      : { start: 0, end: 0 };

  let mark = out.mark();
  out.line("directive", ".intel_syntax noprefix", wholeProgram);
  out.line("directive", ".text", wholeProgram);
  out.line("directive", ".globl main", wholeProgram);
  log.add(
    "open the file",
    "Directives are instructions to the assembler, not to the processor. `.globl main` is what lets a linker find the entry point.",
    wholeProgram,
    out.since(mark),
  );

  // One chunk per function, each with its own frame. The layout is shared with
  // the interpreter so both agree on where a name lives.
  for (const body of functionsOf(instrs)) {
    const head = body[0];
    if (head.op !== "enter") continue;

    const { temps, size: frame } = layoutFrame(body, head.frame);
    const alloc = allocationFor(allocation, head.func);
    const colours = alloc?.colours ?? new Map<string, Reg>();
    const inRegisters = colours.size;

    // The saved registers sit below everything the frame layout knows about, so
    // adding them cannot move a local — the interpreter is reading the same
    // offsets and would disagree if they did. Rounded to 16 to keep the stack
    // aligned, which the ABI requires at every call.
    const saved = (alloc?.saved ?? []).map((reg, index) => ({
      reg,
      at: -(frame + 8 * (index + 1)),
    }));
    const total = frame + Math.ceil((saved.length * 8) / 16) * 16;
    out.setFrame(temps, colours, saved);

    const params = semantics.symbols.filter(
      (symbol) => symbol.role === "param" && symbol.owner === head.func,
    );

    mark = out.mark();
    out.line("label", `${head.func}:`, head.span, head.id);
    out.line("instr", "push rbp", head.span, head.id, "save the caller's frame pointer");
    out.line("instr", "mov rbp, rsp", head.span, head.id, "this frame starts here");
    if (total > 0) {
      out.line(
        "instr",
        `sub rsp, ${total}`,
        head.span,
        head.id,
        `${head.frame} for your locals, the rest for spilled temporaries, saved registers and alignment padding`,
      );
    }
    for (const { reg, at } of saved) {
      out.line(
        "instr",
        `mov [rbp${offset(at)}], ${regName(reg, 8)}`,
        head.span,
        head.id,
        `${reg} belongs to whoever called us`,
      );
    }
    params.forEach((param, index) => {
      const width = Math.max(1, sizeOf(param.type));
      const register = ARG_REGISTERS[index] ?? "rax";
      out.line(
        "instr",
        `mov ${out.slot(param.id)}, ${regName(register, width >= 8 ? 8 : width >= 4 ? 4 : 1)}`,
        param.span,
        head.id,
        `${param.name} arrives in a register and is spilled to its ${width}-byte slot`,
      );
    });
    log.add(
      `prologue for ${head.func}`,
      `The analyser sized your locals at ${head.frame} bytes. ${describeAllocation(inRegisters, temps.size, saved.length)} Arguments arrive in registers and are written straight to memory, because a parameter is a named local and a named local has an address.`,
      head.span,
      out.since(mark),
    );

    for (const instr of body.slice(1)) emit(out, instr);
  }

  return { lines: out.lines, steps: log.all() };
}

function describeAllocation(
  inRegisters: number,
  total: number,
  saved: number,
): string {
  const spilled = total - inRegisters;
  const head =
    total === 0
      ? "It needed no temporaries at all."
      : `Lowering invented ${total} temporar${total === 1 ? "y" : "ies"}; the allocator found registers for ${inRegisters} of them${spilled > 0 ? ` and left ${spilled} in the frame` : ", so none of them touches memory"}.`;
  if (saved === 0) return head;
  return `${head} ${saved} of those register${saved === 1 ? " is" : "s are"} callee-saved, so the prologue has to park the caller's copy first and the epilogue has to hand it back.`;
}

function emit(out: Emitter, instr: IRInstr): void {
  const mark = out.mark();
  const at: Emit = (text, comment) =>
    out.line("instr", text, instr.span, instr.id, comment);

  switch (instr.op) {
    case "label": {
      out.line("label", `${instr.name}:`, instr.span, instr.id);
      out.log.add(
        `place ${instr.name}`,
        "A label costs nothing at runtime. The assembler turns it into an address and forgets the name.",
        instr.span,
        out.since(mark),
      );
      return;
    }

    case "move": {
      const width = widthOf(instr.dest);
      const dest = out.place(instr.dest);
      const src = out.place(instr.src);

      if (dest.kind === "reg") {
        fetch(dest.reg, width, src, at);
      } else if (dest.kind === "mem" && src.kind === "const") {
        at(`mov ${ptrSize(width)} ${dest.text}, ${src.value}`);
      } else if (dest.kind === "mem" && src.kind === "reg" && src.width === width) {
        at(`mov ${dest.text}, ${regName(src.reg, width)}`, "store");
      } else if (dest.kind === "mem") {
        const from = fetch(SCRATCH_A, width, src, at);
        at(`mov ${dest.text}, ${from}`, "store");
      }

      out.log.add(
        "store a value",
        moveComment(out.since(mark).length, dest, src),
        instr.span,
        out.since(mark),
      );
      return;
    }

    case "addr": {
      const target = working(out, instr.dest);
      at(
        `lea ${regName(target, 8)}, ${out.slot(instr.symbol)}`,
        "the address, not the contents",
      );
      put(out, instr.dest, target, at);
      out.log.add(
        `address of ${instr.name}`,
        "`lea` computes an address and hands it over without touching memory. Every other instruction here would have read what is there; this one only says where it is.",
        instr.span,
        out.since(mark),
      );
      return;
    }

    case "load": {
      const from = out.place(instr.from);
      const address =
        from.kind === "reg" && from.width >= 8
          ? regName(from.reg, 8)
          : into(out, SCRATCH_A, 8, instr.from, at);
      const target = working(out, instr.dest);
      const width = instr.width;
      if (width >= 8) at(`mov ${regName(target, 8)}, [${address}]`);
      else if (width >= 4) at(`mov ${regName(target, 4)}, [${address}]`);
      else at(`movsx ${regName(target, 4)}, byte ptr [${address}]`, "one byte, sign-extended");
      put(out, instr.dest, target, at);
      out.log.add(
        "read through a pointer",
        "Two steps, always: fetch the address, then fetch what is at it. The brackets in `[rax]` are the dereference — everything else on this page is just working out what to put in the register inside them.",
        instr.span,
        out.since(mark),
      );
      return;
    }

    case "store": {
      const to = out.place(instr.to);
      const address =
        to.kind === "reg" && to.width >= 8
          ? regName(to.reg, 8)
          : into(out, SCRATCH_A, 8, instr.to, at);
      const width = instr.width;
      const src = out.place(instr.src);
      if (src.kind === "const") {
        at(`mov ${ptrSize(width)} [${address}], ${src.value}`);
      } else if (src.kind === "reg" && src.width === width) {
        at(`mov [${address}], ${regName(src.reg, width)}`);
      } else {
        const value = fetch(SCRATCH_B, width, src, at);
        at(`mov [${address}], ${value}`);
      }
      out.log.add(
        "write through a pointer",
        "The address goes in one register, the value in another, and the write lands wherever the first one pointed. Nothing verifies that it was somewhere you own.",
        instr.span,
        out.since(mark),
      );
      return;
    }

    case "binary":
      return binary(out, instr, at, mark);

    case "unary": {
      const width = widthOf(instr.dest);
      if (instr.operator === "-") {
        const target = working(out, instr.dest);
        const value = into(out, target, width, instr.operand, at);
        at(`neg ${value}`);
        put(out, instr.dest, target, at);
      } else {
        const operandWidth = widthOf(instr.operand);
        const place = out.place(instr.operand);
        const value =
          place.kind === "reg" && place.width === operandWidth
            ? regName(place.reg, operandWidth)
            : fetch(SCRATCH_A, operandWidth, place, at);
        at(`cmp ${value}, 0`);
        const target = working(out, instr.dest);
        at(`sete ${regName(target, 1)}`);
        at(`movzx ${regName(target, 4)}, ${regName(target, 1)}`);
        put(out, instr.dest, target, at);
      }
      out.log.add(
        instr.operator === "-" ? "negate" : "logical not",
        instr.operator === "-"
          ? "`neg` is a single instruction, which is why unary minus is nearly free."
          : "`!` is a comparison against zero. There is no not-instruction for truthiness, because truthiness is not a machine concept.",
        instr.span,
        out.since(mark),
      );
      return;
    }

    case "jump": {
      at(`jmp ${instr.target}`);
      out.log.add(
        "jump",
        "An unconditional jump: set the instruction pointer, continue. Loops, `else`, `break` and `continue` all end up here.",
        instr.span,
        out.since(mark),
      );
      return;
    }

    case "branchFalse":
    case "branchTrue": {
      const width = widthOf(instr.cond);
      const cond = out.place(instr.cond);
      if (cond.kind === "reg") at(`cmp ${regName(cond.reg, width)}, 0`);
      else if (cond.kind === "mem") at(`cmp ${ptrSize(width)} ${cond.text}, 0`);
      else at(`cmp ${fetch(SCRATCH_A, width, cond, at)}, 0`);
      at(`${instr.op === "branchFalse" ? "je" : "jne"} ${instr.target}`);
      out.log.add(
        "branch",
        "Compare against zero, then jump if the flag says so. Every `if`, every loop test, every short-circuit is this pair.",
        instr.span,
        out.since(mark),
      );
      return;
    }

    case "call": {
      const moves = instr.args.flatMap((arg, index) => {
        // char arguments are promoted, as C promises; addresses stay 64-bit.
        const want = widthOf(arg) >= 8 ? 8 : 4;
        const dest = ARG_REGISTERS[index];
        return dest
          ? [{ dest, want, place: out.place(arg), note: `argument ${index + 1}` }]
          : [];
      });
      shuffle(moves, at);
      at(`call ${instr.callee}`);
      if (instr.dest) {
        put(out, instr.dest, "rax", at, "the result comes back in eax");
      }
      out.log.add(
        `call ${instr.callee}`,
        "The calling convention is a contract, not a language feature: arguments in these registers in this order, result in eax. Both sides have to agree or nothing works — and anything the allocator left in a caller-saved register would be gone by the time this returns, which is why nothing live is in one.",
        instr.span,
        out.since(mark),
      );
      return;
    }

    case "return": {
      if (instr.value) {
        const width = widthOf(instr.value) >= 8 ? 8 : 4;
        into(out, "rax", width, instr.value, at);
      }
      for (const { reg, at: slot } of out.savedRegisters()) {
        at(`mov ${regName(reg, 8)}, [rbp${offset(slot)}]`, `give ${reg} back`);
      }
      at("leave", "restore rsp and rbp in one instruction");
      at("ret", "pop the return address and jump to it");
      out.log.add(
        "return",
        "`leave` undoes the prologue and `ret` jumps to an address the caller pushed. The stack is the only thing that remembers where we came from — and any register borrowed from the caller has to be handed back before we go.",
        instr.span,
        out.since(mark),
      );
      return;
    }

    case "enter":
      return;
  }
}

function moveComment(lines: number, dest: Place, src: Place): string {
  if (lines === 0) {
    return "Nothing at all. Both ends of this copy were given the same register, so the move is already done — this is what an allocator buys you, and it is invisible unless you are told to look for it.";
  }
  if (dest.kind === "reg" && src.kind === "reg") {
    return "Register to register: one instruction, no memory touched. Neither of these values has an address, so neither has to have a home in the frame.";
  }
  if (src.kind === "const") {
    return "A constant can go straight to memory in one instruction — no register needed.";
  }
  if (dest.kind === "mem" && src.kind === "mem") {
    return "Memory to memory is not an option on x86: the value has to pass through a register, and this one had to borrow the scratch register to do it.";
  }
  return "One end is a named local, which always lives in the frame, so this is a real load or store rather than a register move.";
}

function binary(out: Emitter, instr: IRInstr, at: Emit, mark: number): void {
  if (instr.op !== "binary") return;
  const width = widthOf(instr.dest);
  const arithmetic = ARITHMETIC[instr.operator];

  if (arithmetic) {
    const dest = out.place(instr.dest);
    let left = instr.left;
    let right = instr.right;
    const rightPlace = out.place(right);
    // `add rbx, x` writing into rbx destroys rbx first, so a right operand that
    // is already sitting there has to be dealt with: swap it to the left where
    // that is the same sum, and step aside through scratch where it is not.
    const collides =
      dest.kind === "reg" && rightPlace.kind === "reg" && rightPlace.reg === dest.reg;
    let target: Reg;
    if (collides && (instr.operator === "+" || instr.operator === "*")) {
      [left, right] = [right, left];
      target = dest.reg as Reg;
    } else if (collides) {
      target = SCRATCH_A;
    } else {
      target = dest.kind === "reg" ? dest.reg : SCRATCH_A;
    }

    const accumulator = into(out, target, width, left, at);
    const operand = rhs(out, width, right, SCRATCH_B, at);
    at(`${arithmetic} ${accumulator}, ${operand}`);
    put(out, instr.dest, target, at);

    out.log.add(
      `${instr.operator} becomes \`${arithmetic}\``,
      width >= 8
        ? "Sixty-four bits wide, because this one is arithmetic on an address rather than on a number you wrote."
        : dest.kind === "reg"
          ? "The answer is computed in the register it is going to stay in, so there is no store afterwards at all."
          : "Load, operate, store. One IR instruction, three machine instructions, two of them only moving data around — which is what a value with no register costs.",
      instr.span,
      out.since(mark),
    );
    return;
  }

  if (instr.operator === "/" || instr.operator === "%") {
    // The divisor goes somewhere safe first. `cdq` is about to overwrite edx and
    // `idiv` reads eax, so a divisor that happened to be allocated to either
    // would be destroyed before it was used.
    const divisor = into(out, SCRATCH_A, 4, instr.right, at);
    into(out, "rax", 4, instr.left, at);
    at("cdq", "sign-extend eax into edx:eax");
    at(`idiv ${divisor}`, "quotient in eax, remainder in edx");
    put(out, instr.dest, instr.operator === "/" ? "rax" : "rdx", at);
    out.log.add(
      `${instr.operator} becomes \`idiv\``,
      "Division is the awkward one: it insists on specific registers and computes the quotient and remainder together, so `/` and `%` are the same instruction reading different halves. It also destroys both of them, which the allocator had to know about before it handed anything out.",
      instr.span,
      out.since(mark),
    );
    return;
  }

  // A comparison reads its operands at THEIR width — two addresses compare as
  // 64-bit — but always answers with a 0 or 1 that is four bytes wide.
  const compareWidth = Math.max(widthOf(instr.left), widthOf(instr.right));
  const suffix = SET_SUFFIX[instr.operator];
  const leftPlace = out.place(instr.left);
  const left =
    leftPlace.kind === "reg" && leftPlace.width === compareWidth
      ? regName(leftPlace.reg, compareWidth)
      : fetch(SCRATCH_A, compareWidth, leftPlace, at);
  const right = rhs(out, compareWidth, instr.right, SCRATCH_B, at);
  at(`cmp ${left}, ${right}`, "sets the flags");
  const target = working(out, instr.dest);
  at(`set${suffix} ${regName(target, 1)}`, "read one flag into a byte");
  at(`movzx ${regName(target, 4)}, ${regName(target, 1)}`, "widen it to 0 or 1");
  put(out, instr.dest, target, at);
  out.log.add(
    `${instr.operator} becomes \`cmp\` and \`set${suffix}\``,
    "The processor has no `<`. It has a subtraction that sets flags, and a family of instructions that read those flags. A comparison is two steps, not one.",
    instr.span,
    out.since(mark),
  );
}

export type ArgMove = { dest: Reg; want: number; place: Place; note?: string };

/**
 * Load the argument registers, in an order that does not destroy an argument
 * before it has been read.
 *
 * The allocator is free to leave a value in `rsi` that this call wants in `rdi`
 * while the value it wants in `rsi` is in `rdi`. Moving them one at a time in
 * order loses one of them. So: emit any move whose destination nothing else
 * still needs, and when only a cycle is left, park one end of it in the scratch
 * register and let the cycle unwind through there.
 *
 * Whether a cycle can come out of the allocator as it stands is a question about
 * the order it happens to hand out colours, which is not a thing to build
 * correctness on — so `spec/regalloc.test.ts` hands this a cycle directly and
 * simulates the moves it emits.
 */
export function shuffle(moves: ArgMove[], emit: Emit): void {
  const pending = [...moves];
  while (pending.length > 0) {
    // A move is safe when no OTHER pending move still wants what is in its
    // destination. "Other" matters: a value already in the register it is
    // wanted in reads its own destination, and treating that as a conflict
    // turned every such argument into a pointless round trip through scratch.
    const next = pending.findIndex(
      (move, index) =>
        !pending.some(
          (other, at) =>
            at !== index && other.place.kind === "reg" && other.place.reg === move.dest,
        ),
    );
    if (next >= 0) {
      const [move] = pending.splice(next, 1);
      fetch(move.dest, move.want, move.place, emit, move.note);
      continue;
    }

    // Every remaining destination is somebody's source: a cycle. Break exactly
    // one, and the rest of that cycle becomes emittable immediately.
    const stuck = pending[0];
    emit(
      `mov ${regName(SCRATCH_B, 8)}, ${regName(stuck.dest, 8)}`,
      "one end of a swap, out of the way",
    );
    for (const move of pending) {
      if (move.place.kind === "reg" && move.place.reg === stuck.dest) {
        move.place = { kind: "reg", reg: SCRATCH_B, width: move.place.width };
      }
    }
  }
}

/** One line of the listing, as it appears in the pane and in tests. */
export function formatAsm(line: AsmLine): string {
  return line.kind === "instr" ? `        ${line.text}` : line.text;
}
