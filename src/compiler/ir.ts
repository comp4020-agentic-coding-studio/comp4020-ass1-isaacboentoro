import { StepLog } from "./steps";
import type {
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

class Lowerer {
  readonly log = new StepLog("ir");
  private readonly instrs: IRInstr[] = [];
  private nextTemp = 0;
  private nextLabel = 0;
  private nextId = 0;
  private funcName = "";
  private readonly loops: { breakTo: string; continueTo: string }[] = [];

  constructor(private readonly semantics: SemanticsResult) {}

  private temp(): { kind: "temp"; name: string } {
    const value = { kind: "temp" as const, name: `t${this.nextTemp}` };
    this.nextTemp += 1;
    return value;
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
  private slotOf(nodeId: string, name: string): IRValue {
    const symbol = this.semantics.resolved[nodeId];
    return { kind: "var", symbol: symbol ?? name, name };
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
      { op: "enter", func: func.name, frame, span: func.span },
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
          ...(func.returnType === "void" ? {} : { value: CONST(0) }),
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
            dest: this.slotOf(stmt.id, stmt.name),
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

      case "Ident":
        return this.slotOf(expr.id, expr.name);

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
        const left = this.lowerExpr(expr.left);
        const right = this.lowerExpr(expr.right);
        const dest = this.temp();
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
        const dest = this.slotOf(expr.id, expr.name);
        this.emit(
          { op: "move", dest, src: value, span: expr.span },
          `store into ${expr.name}`,
          "Assignment is an expression in C, so its value is what was stored — which is why `a = b = 1` works.",
        );
        return dest;
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

/** One line of the IR listing, for the pane and for tests. */
export function formatInstr(instr: IRInstr): string {
  const show = (value: IRValue): string => {
    if (value.kind === "const") return String(value.value);
    return value.name;
  };

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
  }
}
