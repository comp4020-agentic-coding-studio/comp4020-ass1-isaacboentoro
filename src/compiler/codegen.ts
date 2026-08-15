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

/**
 * Code generation: the list becomes instructions a machine could run.
 *
 * Two honest simplifications, both stated on the page. There is no register
 * allocator — every temporary gets a stack slot and `rax`/`rcx` are borrowed for
 * one instruction at a time, which is exactly what a naive compiler does and is
 * why unoptimised output is so full of loads and stores. And the output is
 * assembly text, not machine code: turning this into bytes is the assembler's
 * job, and joining several objects together is the linker's, neither of which
 * runs on this page.
 *
 * Width is the thing pointers add here. A char is one byte, an int is four and
 * an address is eight, so the same IR instruction picks `al`, `eax` or `rax`
 * depending on what it is moving — and a char read into an int has to be
 * sign-extended rather than simply copied.
 */

/** System V AMD64 argument registers, at each width we can pass. */
const ARG_REGISTERS: Record<number, string[]> = {
  8: ["rdi", "rsi", "rdx", "rcx", "r8", "r9"],
  4: ["edi", "esi", "edx", "ecx", "r8d", "r9d"],
  1: ["dil", "sil", "dl", "cl", "r8b", "r9b"],
};

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

/** `rax` / `eax` / `al`, depending on how many bytes are in play. */
function reg(base: "a" | "c" | "d", width: number): string {
  if (width >= 8) return `r${base}x`;
  if (width >= 4) return `e${base}x`;
  return `${base}l`;
}

/** The size prefix an immediate-to-memory move needs to be unambiguous. */
function ptrSize(width: number): string {
  if (width >= 8) return "qword ptr";
  if (width >= 4) return "dword ptr";
  return "byte ptr";
}

function widthOf(value: IRValue): number {
  return value.kind === "const" ? 4 : value.width;
}

class Emitter {
  readonly log = new StepLog("codegen");
  readonly lines: AsmLine[] = [];
  private nextId = 0;
  /** temp name -> frame offset, reset per function. */
  private temps = new Map<string, number>();
  private slots = new Map<string, number>();

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

  setFrame(temps: Map<string, number>): void {
    this.temps = temps;
  }

  /** An assembly operand for an IR value. */
  operand(value: IRValue): string {
    if (value.kind === "const") return String(value.value);
    if (value.kind === "temp") return `[rbp${offset(this.temps.get(value.name) ?? 0)}]`;
    return `[rbp${offset(this.slots.get(value.symbol) ?? 0)}]`;
  }
}

function offset(value: number): string {
  return value < 0 ? String(value) : `+${value}`;
}

/**
 * Get a value into a register at the width the instruction wants.
 *
 * The interesting case is a char being used as an int: reading four bytes from a
 * one-byte slot would take three bytes of whatever sits next to it, so the load
 * has to sign-extend instead. `movsx` is that instruction, and it is the whole
 * of C's integer promotion at machine level.
 */
function into(
  out: Emitter,
  base: "a" | "c" | "d",
  want: number,
  value: IRValue,
  emit: (text: string, comment?: string) => void,
): string {
  const target = reg(base, want);
  if (value.kind === "const") {
    emit(`mov ${target}, ${value.value}`);
    return target;
  }

  const have = widthOf(value);
  if (have === want) {
    emit(`mov ${target}, ${out.operand(value)}`);
  } else if (have < want) {
    emit(
      `movsx ${target}, ${ptrSize(have)} ${out.operand(value)}`,
      `${have}-byte value widened to ${want}, sign and all`,
    );
  } else {
    emit(`mov ${target}, ${ptrSize(want)} ${out.operand(value)}`, "narrowed");
  }
  return target;
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
  emit: (text: string, comment?: string) => void,
): string {
  if (value.kind === "const") return String(value.value);
  if (widthOf(value) === want) return out.operand(value);
  return into(out, "c", want, value, emit);
}

export function generate(
  instrs: IRInstr[],
  semantics: SemanticsResult,
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
    out.setFrame(temps);

    const params = semantics.symbols.filter(
      (symbol) => symbol.role === "param" && symbol.owner === head.func,
    );

    mark = out.mark();
    out.line("label", `${head.func}:`, head.span, head.id);
    out.line("instr", "push rbp", head.span, head.id, "save the caller's frame pointer");
    out.line("instr", "mov rbp, rsp", head.span, head.id, "this frame starts here");
    if (frame > 0) {
      out.line(
        "instr",
        `sub rsp, ${frame}`,
        head.span,
        head.id,
        `${head.frame} for your locals, ${frame - head.frame} for ${temps.size} temporar${temps.size === 1 ? "y" : "ies"} and alignment padding`,
      );
    }
    params.forEach((param, index) => {
      const width = Math.max(1, sizeOf(param.type));
      const register = ARG_REGISTERS[width >= 8 ? 8 : width >= 4 ? 4 : 1]?.[index] ?? "eax";
      out.line(
        "instr",
        `mov [rbp${offset(param.slot ?? 0)}], ${register}`,
        param.span,
        head.id,
        `${param.name} arrives in a register and is spilled to its ${width}-byte slot`,
      );
    });
    log.add(
      `prologue for ${head.func}`,
      `The analyser sized your locals at ${head.frame} bytes. The ${temps.size} temporar${temps.size === 1 ? "y" : "ies"} lowering invented need slots too, and the total is rounded up to ${frame} because the ABI insists the stack stays 16-byte aligned. Arguments arrive in registers and are written straight to memory, which is why unoptimised code does so much pointless traffic.`,
      head.span,
      out.since(mark),
    );

    for (const instr of body.slice(1)) emit(out, instr);
  }

  return { lines: out.lines, steps: log.all() };
}

function emit(out: Emitter, instr: IRInstr): void {
  const mark = out.mark();
  const at = (text: string, comment?: string) =>
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
      if (instr.src.kind === "const") {
        at(`mov ${ptrSize(width)} ${out.operand(instr.dest)}, ${instr.src.value}`);
      } else {
        const source = into(out, "a", width, instr.src, at);
        at(`mov ${out.operand(instr.dest)}, ${source}`, "store");
      }
      out.log.add(
        "store a value",
        instr.src.kind === "const"
          ? "A constant can go straight to memory in one instruction — no register needed."
          : "Memory to memory is not an option on x86: the value has to pass through a register.",
        instr.span,
        out.since(mark),
      );
      return;
    }

    case "addr": {
      at(
        `lea ${reg("a", 8)}, ${out.operand({ kind: "var", symbol: instr.symbol, name: instr.name, width: 8 })}`,
        "the address, not the contents",
      );
      at(`mov ${out.operand(instr.dest)}, ${reg("a", 8)}`);
      out.log.add(
        `address of ${instr.name}`,
        "`lea` computes an address and hands it over without touching memory. Every other instruction here would have read what is there; this one only says where it is.",
        instr.span,
        out.since(mark),
      );
      return;
    }

    case "load": {
      const address = into(out, "a", 8, instr.from, at);
      const width = instr.width;
      if (width >= 8) {
        at(`mov rax, [${address}]`);
      } else if (width >= 4) {
        at(`mov eax, [${address}]`);
      } else {
        at(`movsx eax, byte ptr [${address}]`, "one byte, sign-extended");
      }
      at(`mov ${out.operand(instr.dest)}, ${reg("a", widthOf(instr.dest))}`);
      out.log.add(
        "read through a pointer",
        `Two steps, always: fetch the address, then fetch what is at it. The brackets in \`[rax]\` are the dereference — everything else on this page is just working out what to put in rax.`,
        instr.span,
        out.since(mark),
      );
      return;
    }

    case "store": {
      const address = into(out, "a", 8, instr.to, at);
      const width = instr.width;
      if (instr.src.kind === "const") {
        at(`mov ${ptrSize(width)} [${address}], ${instr.src.value}`);
      } else {
        const source = into(out, "c", width, instr.src, at);
        at(`mov [${address}], ${source}`);
      }
      out.log.add(
        "write through a pointer",
        "The address goes in one register, the value in another, and the write lands wherever the first one pointed. Nothing verifies that it was somewhere you own.",
        instr.span,
        out.since(mark),
      );
      return;
    }

    case "binary": {
      const width = widthOf(instr.dest);
      const arithmetic = ARITHMETIC[instr.operator];

      if (arithmetic) {
        const left = into(out, "a", width, instr.left, at);
        const right = rhs(out, width, instr.right, at);
        at(`${arithmetic} ${left}, ${right}`);
        at(`mov ${out.operand(instr.dest)}, ${left}`);
        out.log.add(
          `${instr.operator} becomes \`${arithmetic}\``,
          width >= 8
            ? "Sixty-four bits wide, because this one is arithmetic on an address rather than on a number you wrote."
            : "Load, operate, store. One IR instruction, three machine instructions, two of them only moving data around.",
          instr.span,
          out.since(mark),
        );
        return;
      }

      if (instr.operator === "/" || instr.operator === "%") {
        into(out, "a", 4, instr.left, at);
        at("cdq", "sign-extend eax into edx:eax");
        into(out, "c", 4, instr.right, at);
        at("idiv ecx", "quotient in eax, remainder in edx");
        at(`mov ${out.operand(instr.dest)}, ${instr.operator === "/" ? "eax" : "edx"}`);
        out.log.add(
          `${instr.operator} becomes \`idiv\``,
          "Division is the awkward one: it insists on specific registers and computes the quotient and remainder together, so `/` and `%` are the same instruction reading different halves.",
          instr.span,
          out.since(mark),
        );
        return;
      }

      // A comparison reads its operands at THEIR width — two addresses compare
      // as 64-bit — but always answers with a 0 or 1 that is four bytes wide.
      const compareWidth = Math.max(widthOf(instr.left), widthOf(instr.right));
      const suffix = SET_SUFFIX[instr.operator];
      const left = into(out, "a", compareWidth, instr.left, at);
      const right = rhs(out, compareWidth, instr.right, at);
      at(`cmp ${left}, ${right}`, "sets the flags");
      at(`set${suffix} al`, "read one flag into a byte");
      at("movzx eax, al", "widen it to 0 or 1");
      at(`mov ${out.operand(instr.dest)}, ${reg("a", width)}`);
      out.log.add(
        `${instr.operator} becomes \`cmp\` and \`set${suffix}\``,
        "The processor has no `<`. It has a subtraction that sets flags, and a family of instructions that read those flags. A comparison is two steps, not one.",
        instr.span,
        out.since(mark),
      );
      return;
    }

    case "unary": {
      const width = widthOf(instr.dest);
      const operandWidth = widthOf(instr.operand);
      if (instr.operator === "-") {
        const value = into(out, "a", width, instr.operand, at);
        at(`neg ${value}`);
        at(`mov ${out.operand(instr.dest)}, ${value}`);
      } else {
        const value = into(out, "a", operandWidth, instr.operand, at);
        at(`cmp ${value}, 0`);
        at("sete al");
        at("movzx eax, al");
        at(`mov ${out.operand(instr.dest)}, ${reg("a", width)}`);
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
      const value = into(out, "a", width, instr.cond, at);
      at(`cmp ${value}, 0`);
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
      instr.args.forEach((arg, index) => {
        // char arguments are promoted, as C promises; addresses stay 64-bit.
        const width = widthOf(arg) >= 8 ? 8 : 4;
        const register = ARG_REGISTERS[width]?.[index] ?? "eax";
        if (arg.kind === "const") {
          at(`mov ${register}, ${arg.value}`, `argument ${index + 1}`);
        } else {
          const source = into(out, "a", width, arg, at);
          at(`mov ${register}, ${source}`, `argument ${index + 1}`);
        }
      });
      at(`call ${instr.callee}`);
      if (instr.dest) {
        at(
          `mov ${out.operand(instr.dest)}, ${reg("a", widthOf(instr.dest))}`,
          "the result comes back in eax",
        );
      }
      out.log.add(
        `call ${instr.callee}`,
        "The calling convention is a contract, not a language feature: arguments in these registers in this order, result in eax. Both sides have to agree or nothing works.",
        instr.span,
        out.since(mark),
      );
      return;
    }

    case "return": {
      if (instr.value) {
        const width = widthOf(instr.value) >= 8 ? 8 : 4;
        into(out, "a", width, instr.value, at);
      }
      at("leave", "restore rsp and rbp in one instruction");
      at("ret", "pop the return address and jump to it");
      out.log.add(
        "return",
        "`leave` undoes the prologue and `ret` jumps to an address the caller pushed. The stack is the only thing that remembers where we came from.",
        instr.span,
        out.since(mark),
      );
      return;
    }

    case "enter":
      return;
  }
}

/** One line of the listing, as it appears in the pane and in tests. */
export function formatAsm(line: AsmLine): string {
  return line.kind === "instr" ? `        ${line.text}` : line.text;
}
