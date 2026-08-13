import { decay, isArray, isInteger, pointee, sizeOf, typeName } from "./ctypes";
import { StepLog } from "./steps";
import type {
  CType,
  Expr,
  FunctionDecl,
  IRInstr,
  IROp,
  IRResult,
  IRValue,
  Program,
  SemanticsResult,
  Span,
  Stmt,
} from "./types";

/**
 * Lowering: the tree becomes a list.
 *
 * This is the stage where the shape of the source stops being the shape of the
 * program. Nesting turns into temporaries, `if` and `while` turn into labels and
 * jumps, and `&&` turns into a branch that skips work — the short-circuit that C
 * promises is not an operator at all by the time we get here, it is control flow.
 */

const CONST = (value: number): IRValue => ({ kind: "const", value });

/** How many bytes a value of this type occupies once it is in hand. */
function widthOf(type: CType): number {
  return Math.max(1, sizeOf(decay(type)));
}

class Lowerer {
  readonly log = new StepLog("ir");
  private readonly instrs: IRInstr[] = [];
  private nextTemp = 0;
  private nextLabel = 0;
  private nextId = 0;
  private funcName = "";
  private readonly loops: { breakTo: string; continueTo: string }[] = [];

  constructor(private readonly semantics: SemanticsResult) {}

  private temp(width = 4): { kind: "temp"; name: string; width: number } {
    const value = { kind: "temp" as const, name: `t${this.nextTemp}`, width };
    this.nextTemp += 1;
    return value;
  }

  /** The type the analyser worked out for a node. */
  private typeOf(expr: Expr): CType {
    return this.semantics.types[expr.id] ?? { kind: "int" };
  }

  private label(hint: string): string {
    // The function name is part of the label so two functions cannot both emit
    // `.L0_endif` and produce an assembly file with duplicate labels.
    const label = `.L${this.funcName}${this.nextLabel}_${hint}`;
    this.nextLabel += 1;
    return label;
  }

  private emit(
    instr: IROp & { span: Span },
    title: string,
    explain: string,
  ): IRInstr {
    const full: IRInstr = { id: `ir:${this.nextId}`, ...instr };
    this.nextId += 1;
    this.instrs.push(full);
    this.log.add(title, explain, instr.span, [full.id]);
    return full;
  }

  /** The IRValue standing for a declared name, keyed by symbol identity. */
  private slotOf(nodeId: string, name: string, width: number): IRValue {
    const symbol = this.semantics.resolved[nodeId];
    return { kind: "var", symbol: symbol ?? name, name, width };
  }

  // ------------------------------------------------------------------ program

  lower(program: Program): void {
    for (const func of program.functions) this.lowerFunction(func);
  }

  private lowerFunction(func: FunctionDecl): void {
    this.nextTemp = 0;
    this.nextLabel = 0;
    this.funcName = func.name;
    const frame = this.semantics.frames[func.name] ?? 0;

    this.emit(
      { op: "enter", func: func.name, frame, span: func.nameSpan },
      `enter ${func.name}`,
      `The function gets a prologue: claim ${frame} bytes of stack, then start work. Nothing in the source asked for this.`,
    );

    for (const stmt of func.body.stmts) this.lowerStmt(stmt);

    // Falling off the end of a non-void function is undefined in C; return 0 so
    // the listing is always well-formed.
    const last = this.instrs.at(-1);
    if (!last || last.op !== "return") {
      this.emit(
        {
          op: "return",
          ...(func.returnType.kind === "void" ? {} : { value: CONST(0) }),
          span: func.span,
        },
        "close the function",
        "Control has to leave somehow. A missing `return` gets one anyway, which is why forgetting one is undefined rather than impossible.",
      );
    }
  }

  // --------------------------------------------------------------- statements

  private lowerStmt(stmt: Stmt): void {
    switch (stmt.kind) {
      case "Block":
        for (const inner of stmt.stmts) this.lowerStmt(inner);
        return;

      case "VarDecl": {
        if (!stmt.init) {
          this.log.add(
            `${stmt.name} needs no code`,
            "An uninitialised local is pure bookkeeping — the slot exists, so there is nothing to emit. Its contents are whatever was there.",
            stmt.span,
            [],
          );
          return;
        }
        const value = this.lowerExpr(stmt.init);
        this.emit(
          {
            op: "move",
            dest: this.slotOf(stmt.id, stmt.name, widthOf(stmt.type)),
            src: value,
            span: stmt.span,
          },
          `store into ${stmt.name}`,
          "Declaration and assignment were one line in the source; here they are one store into a known slot.",
        );
        return;
      }

      case "ExprStmt":
        this.lowerExpr(stmt.expr);
        return;

      case "Return": {
        const value = stmt.value ? this.lowerExpr(stmt.value) : undefined;
        this.emit(
          {
            op: "return",
            ...(value ? { value } : {}),
            span: stmt.span,
          },
          "return",
          "The value is already in a temporary by now, so returning is just handing that one place over.",
        );
        return;
      }

      case "If": {
        const elseLabel = this.label(stmt.otherwise ? "else" : "endif");
        const cond = this.lowerExpr(stmt.cond);
        this.emit(
          { op: "branchFalse", cond, target: elseLabel, span: stmt.cond.span },
          "branch on the condition",
          "An `if` is one conditional jump. The true path is simply the code that follows — no jump needed to enter it.",
        );
        this.lowerStmt(stmt.thenBranch);

        if (stmt.otherwise) {
          const endLabel = this.label("endif");
          this.emit(
            { op: "jump", target: endLabel, span: stmt.span },
            "jump over the else",
            "The true path has to skip the false path. This jump is the `else` keyword's only trace.",
          );
          this.placeLabel(elseLabel, stmt.otherwise.span, "the else path starts here");
          this.lowerStmt(stmt.otherwise);
          this.placeLabel(endLabel, stmt.span, "both paths rejoin here");
        } else {
          this.placeLabel(elseLabel, stmt.span, "the false path lands here");
        }
        return;
      }

      case "While": {
        const top = this.label("while");
        const end = this.label("endwhile");
        this.placeLabel(top, stmt.cond.span, "the loop's condition is re-tested here");
        const cond = this.lowerExpr(stmt.cond);
        this.emit(
          { op: "branchFalse", cond, target: end, span: stmt.cond.span },
          "leave the loop when false",
          "The test happens before the body, every time around. That is the whole difference between `while` and `do`.",
        );
        this.loops.push({ breakTo: end, continueTo: top });
        this.lowerStmt(stmt.body);
        this.loops.pop();
        this.emit(
          { op: "jump", target: top, span: stmt.span },
          "jump back",
          "A loop is a backward jump. There is no loop construct at this level — only this.",
        );
        this.placeLabel(end, stmt.span, "the loop exits to here");
        return;
      }

      case "For": {
        const top = this.label("for");
        const cont = this.label("forstep");
        const end = this.label("endfor");
        if (stmt.init) this.lowerStmt(stmt.init);
        this.placeLabel(top, stmt.span, "the for loop re-tests here");
        if (stmt.cond) {
          const cond = this.lowerExpr(stmt.cond);
          this.emit(
            { op: "branchFalse", cond, target: end, span: stmt.cond.span },
            "leave the loop when false",
            "A `for` with no condition never emits this, which is why `for (;;)` loops forever.",
          );
        }
        this.loops.push({ breakTo: end, continueTo: cont });
        this.lowerStmt(stmt.body);
        this.loops.pop();
        // `continue` must run the update, so the label sits before it.
        this.placeLabel(cont, stmt.span, "`continue` lands here, before the step");
        if (stmt.update) this.lowerExpr(stmt.update);
        this.emit(
          { op: "jump", target: top, span: stmt.span },
          "jump back",
          "The three parts of the header ended up in three different places. Source order is not execution order.",
        );
        this.placeLabel(end, stmt.span, "the loop exits to here");
        return;
      }

      case "Break":
      case "Continue": {
        const loop = this.loops.at(-1);
        if (!loop) return;
        const target = stmt.kind === "Break" ? loop.breakTo : loop.continueTo;
        this.emit(
          { op: "jump", target, span: stmt.span },
          stmt.kind === "Break" ? "break" : "continue",
          `Both keywords compile to the same instruction — an unconditional jump. Only the label differs.`,
        );
        return;
      }
    }
  }

  private placeLabel(name: string, span: Span, why: string): void {
    this.emit(
      { op: "label", name, span },
      `label ${name}`,
      `A label is a name for a position, not an instruction: ${why}.`,
    );
  }

  // -------------------------------------------------------------- expressions

  private lowerExpr(expr: Expr): IRValue {
    switch (expr.kind) {
      case "NumberLit":
        return CONST(expr.value);

      case "CharLit":
        return CONST(expr.value);

      case "Ident": {
        const type = this.typeOf(expr);
        // An array used as a value is its own address. Nothing is copied: this
        // is the decay rule, and it is the only reason `f(a)` is cheap.
        if (isArray(type)) return this.lowerAddress(expr);
        return this.slotOf(expr.id, expr.name, widthOf(type));
      }

      case "AddressOf":
        return this.lowerAddress(expr.operand);

      case "Deref":
      case "Index": {
        const address = this.lowerAddress(expr);
        const width = widthOf(this.typeOf(expr));
        const dest = this.temp(width);
        this.emit(
          { op: "load", dest, from: address, width, span: expr.span },
          `${dest.name} = *${show(address)}`,
          `Reading ${width} byte${width === 1 ? "" : "s"} from that address. The address alone never said how many — the type did.`,
        );
        return dest;
      }

      case "Unary": {
        const operand = this.lowerExpr(expr.operand);
        const dest = this.temp();
        this.emit(
          { op: "unary", dest, operator: expr.op, operand, span: expr.span },
          `${dest.name} = ${expr.op}…`,
          expr.op === "!"
            ? "Logical not is a comparison against zero, so it produces 0 or 1 — never the operand."
            : "Negation needs somewhere to put its result, so lowering invents a temporary.",
        );
        return dest;
      }

      case "Binary": {
        if (expr.op === "&&" || expr.op === "||") return this.lowerShortCircuit(expr);

        const leftType = decay(this.typeOf(expr.left));
        const rightType = decay(this.typeOf(expr.right));
        const pointerSide =
          pointee(leftType) && isInteger(rightType)
            ? "left"
            : pointee(rightType) && isInteger(leftType)
              ? "right"
              : null;

        // `p + 1` is not `p` plus one. Scale the integer side by the element
        // size first, and emit that multiply so it is visible rather than implied.
        if (pointerSide && (expr.op === "+" || expr.op === "-")) {
          return this.lowerPointerArithmetic(expr, pointerSide);
        }

        const left = this.lowerExpr(expr.left);
        const right = this.lowerExpr(expr.right);
        const dest = this.temp(widthOf(this.typeOf(expr)));
        this.emit(
          {
            op: "binary",
            dest,
            operator: expr.op,
            left,
            right,
            span: expr.span,
          },
          `${dest.name} = a ${expr.op} b`,
          "Three addresses: two in, one out. Nested expressions flatten because every intermediate result gets a name.",
        );
        return dest;
      }

      case "Assign": {
        const value = this.lowerExpr(expr.value);
        const width = widthOf(this.typeOf(expr));

        // Assigning to a plain name is a store to a known slot. Assigning
        // through `*p` or `a[i]` means computing an address first, and the
        // difference between those two is the whole point of an lvalue.
        if (expr.target.kind === "Ident") {
          const dest = this.slotOf(expr.target.id, expr.target.name, width);
          this.emit(
            { op: "move", dest, src: value, span: expr.span },
            `store into ${expr.target.name}`,
            "Assignment is an expression in C, so its value is what was stored — which is why `a = b = 1` works.",
          );
          return dest;
        }

        const address = this.lowerAddress(expr.target);
        this.emit(
          { op: "store", to: address, src: value, width, span: expr.span },
          `*${show(address)} = ${show(value)}`,
          `Writing ${width} byte${width === 1 ? "" : "s"} to a computed address. Nothing here checks that the address is one you own.`,
        );
        return value;
      }

      case "Call": {
        // Arguments are evaluated left to right here; real C leaves the order
        // unspecified, which is a genuine portability trap.
        const args = expr.args.map((arg) => this.lowerExpr(arg));
        const dest = this.temp();
        this.emit(
          {
            op: "call",
            dest,
            callee: expr.callee,
            args,
            span: expr.span,
          },
          `call ${expr.callee}`,
          "Every argument is a finished value before the call happens. C does not say what order they were computed in — we chose left to right.",
        );
        return dest;
      }
    }
  }

  /**
   * The address of a place, rather than the value in it.
   *
   * This is the lvalue path, and having it separate from `lowerExpr` is what
   * makes pointers work at all: `x = 1` needs the slot, `*p = 1` needs the value
   * in p, and `a[i] = 1` needs arithmetic. The source spells all three the same
   * way, with an `=`.
   */
  private lowerAddress(expr: Expr): IRValue {
    switch (expr.kind) {
      case "Ident": {
        const symbol = this.semantics.resolved[expr.id] ?? expr.name;
        const dest = this.temp(8);
        this.emit(
          { op: "addr", dest, symbol, name: expr.name, span: expr.span },
          `${dest.name} = &${expr.name}`,
          "The address of a frame slot. A name is a place, and this is the instruction that says where.",
        );
        return dest;
      }

      // `*p` as a place is just p as a value — the pointer already IS the address.
      case "Deref":
        return this.lowerExpr(expr.operand);

      case "Index": {
        const elementType = this.typeOf(expr);
        const size = Math.max(1, sizeOf(elementType));
        const base = isArray(this.typeOf(expr.array))
          ? this.lowerAddress(expr.array)
          : this.lowerExpr(expr.array);
        const index = this.lowerExpr(expr.index);

        let offset = index;
        if (size !== 1) {
          const scaled = this.temp(8);
          this.emit(
            {
              op: "binary",
              dest: scaled,
              operator: "*",
              left: index,
              right: CONST(size),
              span: expr.span,
            },
            `${scaled.name} = i * ${size}`,
            `\`a[i]\` is \`*(a + i)\`, and adding one to a ${typeName(elementType)}* moves ${size} bytes. The multiply is the bracket's real cost.`,
          );
          offset = scaled;
        }

        const address = this.temp(8);
        this.emit(
          {
            op: "binary",
            dest: address,
            operator: "+",
            left: base,
            right: offset,
            span: expr.span,
          },
          `${address.name} = base + offset`,
          "The element's address. Nothing has been read yet — this is only where to look.",
        );
        return address;
      }

      default:
        // The analyser rejects everything else before we get here.
        return this.lowerExpr(expr);
    }
  }

  /**
   * `p + n` where p is a pointer. The integer side is multiplied by the element
   * size, which is the step everyone forgets is happening.
   */
  private lowerPointerArithmetic(
    expr: Expr & { kind: "Binary" },
    pointerSide: "left" | "right",
  ): IRValue {
    const pointerExpr = pointerSide === "left" ? expr.left : expr.right;
    const integerExpr = pointerSide === "left" ? expr.right : expr.left;
    const target = pointee(decay(this.typeOf(pointerExpr)));
    const size = target ? Math.max(1, sizeOf(target)) : 1;

    const pointer = this.lowerExpr(pointerExpr);
    const count = this.lowerExpr(integerExpr);

    let offset = count;
    if (size !== 1) {
      const scaled = this.temp(8);
      this.emit(
        {
          op: "binary",
          dest: scaled,
          operator: "*",
          left: count,
          right: CONST(size),
          span: expr.span,
        },
        `${scaled.name} = n * ${size}`,
        `Each ${target ? typeName(target) : "element"} is ${size} bytes, so \`${expr.op} ${1}\` means \`${expr.op} ${size}\` in addresses. This multiply is what \`p + 1\` actually costs.`,
      );
      offset = scaled;
    }

    const dest = this.temp(8);
    this.emit(
      {
        op: "binary",
        dest,
        operator: expr.op,
        left: pointer,
        right: offset,
        span: expr.span,
      },
      `${dest.name} = p ${expr.op} offset`,
      "Now it is plain integer arithmetic on an address. The type has done its work and drops out here.",
    );
    return dest;
  }

  /**
   * `&&` and `||` cannot be lowered as operators, because they must not evaluate
   * their right operand unless they have to. They become branches instead.
   */
  private lowerShortCircuit(
    expr: Expr & { kind: "Binary" },
  ): IRValue {
    const isAnd = expr.op === "&&";
    const dest = this.temp();
    const end = this.label(isAnd ? "and" : "or");

    this.emit(
      { op: "move", dest, src: CONST(isAnd ? 0 : 1), span: expr.span },
      `assume ${isAnd ? "false" : "true"}`,
      `Start from the answer that needs no second operand: \`${expr.op}\` only has to look right if the left side did not decide it.`,
    );

    const left = this.lowerExpr(expr.left);
    this.emit(
      {
        op: isAnd ? "branchFalse" : "branchTrue",
        cond: left,
        target: end,
        span: expr.left.span,
      },
      "short-circuit",
      isAnd
        ? "If the left side is false, the right side is never evaluated — side effects in it simply do not happen."
        : "If the left side is true, the right side is skipped entirely.",
    );

    const right = this.lowerExpr(expr.right);
    this.emit(
      {
        op: isAnd ? "branchFalse" : "branchTrue",
        cond: right,
        target: end,
        span: expr.right.span,
      },
      "test the right side",
      "Only reached because the left side did not settle the answer.",
    );

    this.emit(
      { op: "move", dest, src: CONST(isAnd ? 1 : 0), span: expr.span },
      `it is ${isAnd ? "true" : "false"}`,
      "Both sides agreed, so overwrite the assumption.",
    );
    this.placeLabel(end, expr.span, `every path through \`${expr.op}\` meets here`);
    return dest;
  }

  result(): IRResult {
    return { instrs: this.instrs, steps: this.log.all() };
  }
}

export function lower(program: Program, semantics: SemanticsResult): IRResult {
  const lowerer = new Lowerer(semantics);
  lowerer.lower(program);
  return lowerer.result();
}

/** How a value is written in the listing and in step titles. */
function show(value: IRValue): string {
  return value.kind === "const" ? String(value.value) : value.name;
}

/** One line of the IR listing, for the pane and for tests. */
export function formatInstr(instr: IRInstr): string {
  switch (instr.op) {
    case "enter":
      return `${instr.func}: enter frame=${instr.frame}`;
    case "label":
      return `${instr.name}:`;
    case "move":
      return `${show(instr.dest)} = ${show(instr.src)}`;
    case "binary":
      return `${show(instr.dest)} = ${show(instr.left)} ${instr.operator} ${show(instr.right)}`;
    case "unary":
      return `${show(instr.dest)} = ${instr.operator}${show(instr.operand)}`;
    case "jump":
      return `jump ${instr.target}`;
    case "branchFalse":
      return `if !${show(instr.cond)} jump ${instr.target}`;
    case "branchTrue":
      return `if ${show(instr.cond)} jump ${instr.target}`;
    case "call":
      return `${instr.dest ? `${show(instr.dest)} = ` : ""}call ${instr.callee}(${instr.args.map(show).join(", ")})`;
    case "return":
      return instr.value ? `return ${show(instr.value)}` : "return";
    case "addr":
      return `${show(instr.dest)} = &${instr.name}`;
    case "load":
      return `${show(instr.dest)} = *${show(instr.from)}`;
    case "store":
      return `*${show(instr.to)} = ${show(instr.src)}`;
  }
}
