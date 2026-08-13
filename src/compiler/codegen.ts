import { StepLog } from "./steps";
import type {
  AsmLine,
  CodegenResult,
  IRInstr,
  IRValue,
  SemanticsResult,
  Span,
} from "./types";

/**
 * Code generation: the list becomes instructions a machine could run.
 *
 * Two honest simplifications, both stated on the page. There is no register
 * allocator — every temporary gets a stack slot and `eax`/`ecx` are borrowed for
 * one instruction at a time, which is exactly what a naive compiler does and is
 * why unoptimised output is so full of loads and stores. And the output is
 * assembly text, not machine code: turning this into bytes is the assembler's
 * job, and joining several objects together is the linker's, neither of which
 * runs on this page.
 */

/** The System V AMD64 argument registers, 32-bit halves. */
const ARG_REGISTERS = ["edi", "esi", "edx", "ecx", "r8d", "r9d"];

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

  // Split the listing into functions so each prologue knows its own temporaries.
  const chunks: { start: number; end: number }[] = [];
  instrs.forEach((instr, index) => {
    if (instr.op === "enter") {
      if (chunks.length > 0) chunks[chunks.length - 1].end = index;
      chunks.push({ start: index, end: instrs.length });
    }
  });

  for (const chunk of chunks) {
    const body = instrs.slice(chunk.start, chunk.end);
    const head = body[0];
    if (head.op !== "enter") continue;

    // Every temporary the lowering invented needs a slot of its own, below the
    // locals the analyser already placed.
    const temps = new Map<string, number>();
    let used = head.frame;
    for (const instr of body) {
      for (const value of valuesOf(instr)) {
        if (value.kind === "temp" && !temps.has(value.name)) {
          used += 4;
          temps.set(value.name, -used);
        }
      }
    }
    const frame = Math.ceil(used / 16) * 16;
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
      const register = ARG_REGISTERS[index] ?? "eax";
      out.line(
        "instr",
        `mov [rbp${offset(param.slot ?? 0)}], ${register}`,
        param.span,
        head.id,
        `${param.name} arrives in a register and is spilled to its slot`,
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

function valuesOf(instr: IRInstr): IRValue[] {
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
    default:
      return [];
  }
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
      if (instr.src.kind === "const") {
        at(`mov dword ptr ${out.operand(instr.dest)}, ${instr.src.value}`);
      } else {
        at(`mov eax, ${out.operand(instr.src)}`, "load");
        at(`mov ${out.operand(instr.dest)}, eax`, "store");
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

    case "binary": {
      const arithmetic = ARITHMETIC[instr.operator];
      if (arithmetic) {
        at(`mov eax, ${out.operand(instr.left)}`);
        at(`${arithmetic} eax, ${out.operand(instr.right)}`);
        at(`mov ${out.operand(instr.dest)}, eax`);
        out.log.add(
          `${instr.operator} becomes \`${arithmetic}\``,
          "Load, operate, store. One IR instruction, three machine instructions, two of them only moving data around.",
          instr.span,
          out.since(mark),
        );
        return;
      }

      if (instr.operator === "/" || instr.operator === "%") {
        at(`mov eax, ${out.operand(instr.left)}`);
        at("cdq", "sign-extend eax into edx:eax");
        at(`mov ecx, ${out.operand(instr.right)}`);
        at("idiv ecx", "quotient in eax, remainder in edx");
        at(
          `mov ${out.operand(instr.dest)}, ${instr.operator === "/" ? "eax" : "edx"}`,
        );
        out.log.add(
          `${instr.operator} becomes \`idiv\``,
          "Division is the awkward one: it insists on specific registers and computes the quotient and remainder together, so `/` and `%` are the same instruction reading different halves.",
          instr.span,
          out.since(mark),
        );
        return;
      }

      const suffix = SET_SUFFIX[instr.operator];
      at(`mov eax, ${out.operand(instr.left)}`);
      at(`cmp eax, ${out.operand(instr.right)}`, "sets the flags");
      at(`set${suffix} al`, "read one flag into a byte");
      at("movzx eax, al", "widen it to 0 or 1");
      at(`mov ${out.operand(instr.dest)}, eax`);
      out.log.add(
        `${instr.operator} becomes \`cmp\` and \`set${suffix}\``,
        "The processor has no `<`. It has a subtraction that sets flags, and a family of instructions that read those flags. A comparison is two steps, not one.",
        instr.span,
        out.since(mark),
      );
      return;
    }

    case "unary": {
      at(`mov eax, ${out.operand(instr.operand)}`);
      if (instr.operator === "-") {
        at("neg eax");
      } else {
        at("cmp eax, 0");
        at("sete al");
        at("movzx eax, al");
      }
      at(`mov ${out.operand(instr.dest)}, eax`);
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
      if (instr.cond.kind === "const") {
        at(`mov eax, ${instr.cond.value}`);
      } else {
        at(`mov eax, ${out.operand(instr.cond)}`);
      }
      at("cmp eax, 0");
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
        const register = ARG_REGISTERS[index] ?? "eax";
        at(`mov ${register}, ${out.operand(arg)}`, `argument ${index + 1}`);
      });
      at(`call ${instr.callee}`);
      if (instr.dest) at(`mov ${out.operand(instr.dest)}, eax`, "the result comes back in eax");
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
        at(
          instr.value.kind === "const"
            ? `mov eax, ${instr.value.value}`
            : `mov eax, ${out.operand(instr.value)}`,
          "the return value goes in eax",
        );
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
