import {
  INT,
  alignOf,
  decay,
  isArray,
  isInteger,
  isPointer,
  isVoid,
  pointee,
  pointerTo,
  sameType,
  sizeOf,
  typeName,
} from "./ctypes";
import { StepLog } from "./steps";
import type {
  CType,
  Diagnostic,
  Expr,
  FunctionDecl,
  Program,
  SemanticsResult,
  Span,
  Stmt,
  SymbolInfo,
} from "./types";
import { isLvalue } from "./types";

/**
 * The analyser. The parser proved the text has a shape; this stage decides
 * whether the shape means anything — every name resolves, every type lines up,
 * every jump has somewhere to go — and lays out the stack frame that codegen
 * will spend the rest of the pipeline addressing.
 *
 * Pointers are what make this stage load-bearing rather than decorative. Once a
 * type can be `int*`, the analyser is the only thing that knows `p + 1` moves
 * four bytes and `q + 1` moves one, that `a` means `&a[0]` in almost every
 * position, and that an array of ten ints needs forty bytes of frame rather than
 * a slot like everything else.
 */

/**
 * C's null pointer constant: the literal 0 may be assigned to any pointer, even
 * though no other integer may. It is a special case in the standard, not a
 * general conversion, so it is a special case here too.
 */
function isNullConstant(expr: Expr): boolean {
  return expr.kind === "NumberLit" && expr.value === 0;
}

class SemanticError extends Error {
  constructor(
    override readonly message: string,
    readonly span: Span,
    readonly hint?: string,
  ) {
    super(message);
  }
}

type Scope = Map<string, SymbolInfo>;

class Analyser {
  readonly log = new StepLog("semantics");
  private readonly scopes: Scope[] = [new Map()];
  private readonly symbols: SymbolInfo[] = [];
  private readonly resolved: Record<string, string> = {};
  private readonly types: Record<string, CType> = {};
  private readonly frames: Record<string, number> = {};
  private nextId = 0;
  private loopDepth = 0;
  private frameUsed = 0;
  private currentFunction: FunctionDecl | null = null;

  // ------------------------------------------------------------------- scopes

  private push(): void {
    this.scopes.push(new Map());
  }

  private pop(): void {
    this.scopes.pop();
  }

  private declare(
    name: string,
    type: CType,
    role: SymbolInfo["role"],
    span: Span,
    signature?: SymbolInfo["signature"],
  ): SymbolInfo {
    const scope = this.scopes[this.scopes.length - 1];
    if (scope.get(name)) {
      throw new SemanticError(
        `\`${name}\` is already declared in this scope`,
        span,
        `The earlier declaration is still in scope here.`,
      );
    }

    if (role !== "function" && isVoid(type)) {
      throw new SemanticError(
        `\`${name}\` cannot be void`,
        span,
        "void is a return type, not something a variable can hold.",
      );
    }

    const symbol: SymbolInfo = {
      id: `sym:${this.nextId}`,
      name,
      type,
      role,
      depth: this.scopes.length - 1,
      ...(this.currentFunction ? { owner: this.currentFunction.name } : {}),
      span,
      ...(signature ? { signature } : {}),
    };
    this.nextId += 1;

    if (role !== "function") {
      // Grow the frame by the object's own size, then round the offset out to
      // its alignment. An array of ten ints takes forty bytes here, not a slot.
      const size = sizeOf(type);
      const align = alignOf(type);
      this.frameUsed = Math.ceil((this.frameUsed + size) / align) * align;
      symbol.slot = -this.frameUsed;
    }

    scope.set(name, symbol);
    this.symbols.push(symbol);

    this.log.add(
      `bind ${name}`,
      role === "function"
        ? "Functions go in the global scope before any body is checked, which is what makes recursion and forward calls work."
        : isArray(type)
          ? `${typeName(type)} needs ${sizeOf(type)} contiguous bytes, so the frame grows by that much and the name points at the start of the block.`
          : `The name gets a home: ${sizeOf(type)} bytes at frame slot ${symbol.slot}. Nothing in the source says where it lives — the compiler decides.`,
      span,
      [symbol.id],
    );
    return symbol;
  }

  private lookup(name: string): SymbolInfo | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i -= 1) {
      const found = this.scopes[i].get(name);
      if (found) return found;
    }
    return undefined;
  }

  // ------------------------------------------------------------------ program

  analyse(program: Program): void {
    this.log.add(
      "collect the functions",
      "Two passes, not one: every function name is recorded first so a call can refer to a function defined further down.",
      program.span,
      [],
    );

    for (const func of program.functions) {
      this.declare(func.name, func.returnType, "function", func.nameSpan, {
        params: func.params.map((param) => param.type),
        returns: func.returnType,
      });
    }

    if (!this.lookup("main")) {
      throw new SemanticError(
        "no `main` function",
        program.span,
        "Execution has to start somewhere. Add `int main() { … }`.",
      );
    }

    for (const func of program.functions) this.analyseFunction(func);
  }

  private analyseFunction(func: FunctionDecl): void {
    this.currentFunction = func;
    this.frameUsed = 0;
    this.push();
    this.log.add(
      `enter ${func.name}`,
      "A function body is a fresh frame. Slot numbering restarts, so two functions can both use the same offsets.",
      func.nameSpan,
      [],
    );

    for (const param of func.params) {
      const symbol = this.declare(param.name, param.type, "param", param.span);
      this.resolved[param.id] = symbol.id;
    }

    // The body's statements go in the SAME scope as the parameters, not a
    // nested one — in C, redeclaring a parameter in the body is an error.
    for (const stmt of func.body.stmts) this.analyseStmt(stmt);

    // Only the named locals are sized here. The temporaries that lowering is
    // about to invent are not known yet, so alignment waits for codegen.
    this.frames[func.name] = this.frameUsed;
    this.log.add(
      `lay out ${func.name}'s frame`,
      `${this.frameUsed} bytes for the names you wrote. The compiler is not finished spending stack — the next stage invents temporaries that need slots too.`,
      func.nameSpan,
      [],
    );

    this.pop();
    this.currentFunction = null;
  }

  // --------------------------------------------------------------- statements

  private analyseStmt(stmt: Stmt): void {
    switch (stmt.kind) {
      case "Block": {
        this.push();
        for (const inner of stmt.stmts) this.analyseStmt(inner);
        this.pop();
        return;
      }

      case "VarDecl": {
        // The initialiser is checked BEFORE the name exists, so `int x = x;`
        // is an error rather than reading itself.
        if (stmt.init) {
          const type = this.analyseExpr(stmt.init);
          this.coerce(
            type,
            stmt.type,
            stmt.init.span,
            `initialising \`${stmt.name}\``,
            stmt.init,
          );
        }
        const symbol = this.declare(stmt.name, stmt.type, "local", stmt.span);
        this.resolved[stmt.id] = symbol.id;
        return;
      }

      case "ExprStmt":
        this.analyseExpr(stmt.expr);
        return;

      case "Return": {
        const expected = this.currentFunction?.returnType ?? INT;
        if (stmt.value) {
          const actual = this.analyseExpr(stmt.value);
          if (isVoid(expected)) {
            throw new SemanticError(
              `\`${this.currentFunction?.name}\` returns void but this returns a value`,
              stmt.span,
            );
          }
          this.coerce(actual, expected, stmt.span, "returning");
        } else if (!isVoid(expected)) {
          throw new SemanticError(
            `\`${this.currentFunction?.name}\` must return ${typeName(expected)}`,
            stmt.span,
            "A bare `return;` only works in a void function.",
          );
        }
        return;
      }

      case "If": {
        this.requireScalar(this.analyseExpr(stmt.cond), stmt.cond.span, "a condition");
        this.analyseStmt(stmt.thenBranch);
        if (stmt.otherwise) this.analyseStmt(stmt.otherwise);
        return;
      }

      case "While": {
        this.requireScalar(this.analyseExpr(stmt.cond), stmt.cond.span, "a condition");
        this.loopDepth += 1;
        this.analyseStmt(stmt.body);
        this.loopDepth -= 1;
        return;
      }

      case "For": {
        // The header declares into its own scope: `for (int i …)` ends with the loop.
        this.push();
        if (stmt.init) this.analyseStmt(stmt.init);
        if (stmt.cond) {
          this.requireScalar(this.analyseExpr(stmt.cond), stmt.cond.span, "a condition");
        }
        if (stmt.update) this.analyseExpr(stmt.update);
        this.loopDepth += 1;
        this.analyseStmt(stmt.body);
        this.loopDepth -= 1;
        this.pop();
        return;
      }

      case "Break":
      case "Continue": {
        if (this.loopDepth === 0) {
          throw new SemanticError(
            `\`${stmt.kind.toLowerCase()}\` outside a loop`,
            stmt.span,
            "There is no enclosing loop for it to jump out of.",
          );
        }
        this.log.add(
          `check ${stmt.kind.toLowerCase()}`,
          "Legal, because it sits inside a loop. Which label it targets is decided when the loop is lowered.",
          stmt.span,
          [],
        );
        return;
      }
    }
  }

  // -------------------------------------------------------------- expressions

  /** The declared type, before decay. Lowering needs to know it was an array. */
  private analyseExpr(expr: Expr): CType {
    const type = this.inferExpr(expr);
    this.types[expr.id] = type;
    return type;
  }

  private inferExpr(expr: Expr): CType {
    switch (expr.kind) {
      case "NumberLit":
        return INT;

      case "CharLit":
        return { kind: "char" };

      case "Ident": {
        const symbol = this.lookup(expr.name);
        if (!symbol) {
          throw new SemanticError(
            `\`${expr.name}\` is not declared`,
            expr.span,
            "Declare it before using it, or check the spelling.",
          );
        }
        if (symbol.role === "function") {
          throw new SemanticError(
            `\`${expr.name}\` is a function`,
            expr.span,
            "This subset has no function pointers — did you mean to call it?",
          );
        }
        this.resolved[expr.id] = symbol.id;
        this.log.add(
          `resolve ${expr.name}`,
          isArray(symbol.type)
            ? `${expr.name} is ${typeName(symbol.type)}. Used as a value it decays to a pointer to its first element — the elements are never copied.`
            : `This use points at the declaration in slot ${symbol.slot}. The name is now an address; the text stops mattering.`,
          expr.span,
          [],
        );
        return symbol.type;
      }

      case "AddressOf": {
        const inner = this.analyseExpr(expr.operand);
        if (!isLvalue(expr.operand)) {
          throw new SemanticError(
            "there is no address to take here",
            expr.operand.span,
            "`&` needs a place — a variable, `*p` or `a[i]` — not a computed value.",
          );
        }
        if (isArray(inner)) {
          throw new SemanticError(
            "taking the address of a whole array is out of subset",
            expr.span,
            "`&a` has type `int(*)[n]`, which this explainer does not model. The array name alone already gives you `&a[0]`.",
          );
        }
        this.log.add(
          "take an address",
          `The result is ${typeName(pointerTo(inner))}. This is the reason locals live in the frame at all — a value in a register has no address to give.`,
          expr.span,
          [],
        );
        return pointerTo(inner);
      }

      case "Deref": {
        const inner = decay(this.analyseExpr(expr.operand));
        const target = pointee(inner);
        if (!target) {
          throw new SemanticError(
            `cannot dereference a ${typeName(inner)}`,
            expr.span,
            "Only a pointer can be followed. An int is a number, not an address.",
          );
        }
        if (isVoid(target)) {
          throw new SemanticError("cannot dereference a void pointer", expr.span);
        }
        this.log.add(
          "follow a pointer",
          `Reading ${sizeOf(target)} byte${sizeOf(target) === 1 ? "" : "s"} from wherever it points. The type is what says how many — the address itself carries no size.`,
          expr.span,
          [],
        );
        return target;
      }

      case "Index": {
        const base = this.analyseExpr(expr.array);
        const index = this.analyseExpr(expr.index);
        const target = pointee(base);
        if (!target) {
          throw new SemanticError(
            `${typeName(base)} cannot be indexed`,
            expr.span,
            "Indexing needs an array or a pointer.",
          );
        }
        if (!isInteger(index)) {
          throw new SemanticError(
            `an index has to be an integer, not ${typeName(index)}`,
            expr.index.span,
          );
        }
        this.log.add(
          "index",
          `Each element is ${sizeOf(target)} byte${sizeOf(target) === 1 ? "" : "s"}, so the index gets multiplied by ${sizeOf(target)} before it is added. Nothing checks the bounds — that is why C lets you walk off the end.`,
          expr.span,
          [],
        );
        return target;
      }

      case "Unary": {
        const operand = decay(this.analyseExpr(expr.operand));
        if (expr.op === "!") {
          this.requireScalar(operand, expr.operand.span, "`!`");
        } else if (!isInteger(operand)) {
          throw new SemanticError(
            `cannot negate a ${typeName(operand)}`,
            expr.operand.span,
          );
        }
        return INT;
      }

      case "Binary":
        return this.inferBinary(expr);

      case "Assign": {
        const target = this.analyseExpr(expr.target);
        if (!isLvalue(expr.target)) {
          throw new SemanticError(
            "this cannot be assigned to",
            expr.target.span,
            "The left of `=` has to name a place.",
          );
        }
        if (isArray(target)) {
          throw new SemanticError(
            "an array cannot be assigned to",
            expr.target.span,
            "The name is the whole block, not a pointer you can repoint. Assign to its elements instead.",
          );
        }
        const value = this.analyseExpr(expr.value);
        this.coerce(value, target, expr.value.span, "assigning", expr.value);
        return target;
      }

      case "Call": {
        const symbol = this.lookup(expr.callee);
        if (!symbol) {
          throw new SemanticError(
            `\`${expr.callee}\` is not declared`,
            expr.span,
            "There is no standard library here — every function has to be defined on this page.",
          );
        }
        if (symbol.role !== "function" || !symbol.signature) {
          throw new SemanticError(
            `\`${expr.callee}\` is not a function`,
            expr.span,
            `It is declared as a ${typeName(symbol.type)} variable.`,
          );
        }

        const expected = symbol.signature.params;
        if (expr.args.length !== expected.length) {
          throw new SemanticError(
            `\`${expr.callee}\` takes ${expected.length} argument${expected.length === 1 ? "" : "s"}, not ${expr.args.length}`,
            expr.span,
          );
        }

        expr.args.forEach((arg, index) => {
          const actual = this.analyseExpr(arg);
          this.coerce(actual, expected[index], arg.span, `argument ${index + 1}`, arg);
        });

        this.resolved[expr.id] = symbol.id;
        this.log.add(
          `check the call to ${expr.callee}`,
          `${expected.length} argument${expected.length === 1 ? "" : "s"}, types agree, returns ${typeName(symbol.signature.returns)}.`,
          expr.span,
          [],
        );
        return symbol.signature.returns;
      }
    }
  }

  /**
   * Arithmetic, once a pointer can turn up on either side.
   *
   * `p + 1` does not add one. It adds one element, which is the single most
   * surprising thing about C for most people, and the reason the type has to
   * survive this far into the compiler.
   */
  private inferBinary(expr: Expr & { kind: "Binary" }): CType {
    const left = decay(this.analyseExpr(expr.left));
    const right = decay(this.analyseExpr(expr.right));
    const op = expr.op;

    if (op === "&&" || op === "||") {
      this.requireScalar(left, expr.left.span, `\`${op}\``);
      this.requireScalar(right, expr.right.span, `\`${op}\``);
      return INT;
    }

    const comparison = ["==", "!=", "<", ">", "<=", ">="].includes(op);
    if (comparison) {
      if (isPointer(left) && isPointer(right)) {
        const a = pointee(left);
        const b = pointee(right);
        if (a && b && !sameType(a, b)) {
          throw new SemanticError(
            `comparing ${typeName(left)} with ${typeName(right)}`,
            expr.span,
            "Two pointers can only be compared when they point at the same type.",
          );
        }
        this.log.add(
          "compare two addresses",
          "Pointers compare as plain numbers here — which is exactly what they are once the type has done its job.",
          expr.span,
          [],
        );
        return INT;
      }
      if (isPointer(left) || isPointer(right)) {
        throw new SemanticError(
          `cannot compare ${typeName(left)} with ${typeName(right)}`,
          expr.span,
          "An address and a number are not the same kind of thing.",
        );
      }
      this.requireScalar(left, expr.left.span, `\`${op}\``);
      this.requireScalar(right, expr.right.span, `\`${op}\``);
      return INT;
    }

    if (isPointer(left) || isPointer(right)) {
      if (op !== "+" && op !== "-") {
        throw new SemanticError(
          `\`${op}\` does not work on ${typeName(isPointer(left) ? left : right)}`,
          expr.span,
          "Only + and - move a pointer.",
        );
      }
      if (isPointer(left) && isPointer(right)) {
        throw new SemanticError(
          "subtracting one pointer from another is out of subset",
          expr.span,
          "The result would be a count of elements, which means dividing by the element size. This explainer stops short of that.",
        );
      }
      if (op === "-" && isPointer(right)) {
        throw new SemanticError(
          "cannot subtract a pointer from an integer",
          expr.span,
        );
      }
      const target = pointee(isPointer(left) ? left : right);
      if (!target || isVoid(target)) {
        throw new SemanticError("cannot do arithmetic on this pointer", expr.span);
      }
      this.log.add(
        `scale by ${sizeOf(target)}`,
        `\`${op}\` on a ${typeName(isPointer(left) ? left : right)} moves by whole elements, so the integer side is multiplied by ${sizeOf(target)} first. This is why \`p + 1\` and \`q + 1\` move different distances.`,
        expr.span,
        [],
      );
      return isPointer(left) ? left : right;
    }

    this.requireScalar(left, expr.left.span, `\`${op}\``);
    this.requireScalar(right, expr.right.span, `\`${op}\``);
    if (!sameType(left, right)) {
      this.log.add(
        `promote char to int for \`${op}\``,
        "C widens a char to an int before arithmetic. The conversion is real work the source never mentions.",
        expr.span,
        [],
      );
    }
    return INT;
  }

  /** Something with a value: an integer or an address, but not void. */
  private requireScalar(type: CType, span: Span, context: string): void {
    const decayed = decay(type);
    if (isVoid(decayed)) {
      throw new SemanticError(`${context} needs a value, but this is void`, span);
    }
    if (!isInteger(decayed) && !isPointer(decayed)) {
      throw new SemanticError(
        `${context} cannot take a ${typeName(type)}`,
        span,
      );
    }
  }

  /** What may be stored where. Integers convert; pointers must agree. */
  private coerce(
    from: CType,
    to: CType,
    span: Span,
    context: string,
    origin?: Expr,
  ): void {
    if (sameType(from, to)) return;

    if (isPointer(to) && origin && isNullConstant(origin)) {
      this.log.add(
        "the null pointer",
        "A literal 0 is the one integer that may become a pointer. It is a rule about the token you wrote, not a conversion — any other zero-valued expression is rejected.",
        span,
        [],
      );
      return;
    }

    if (isVoid(from) || isVoid(to)) {
      throw new SemanticError(
        `${context}: cannot use a void value`,
        span,
        "A void function returns nothing, so there is nothing to store.",
      );
    }

    const source = decay(from);
    if (isPointer(to) || isPointer(source)) {
      const a = pointee(source);
      const b = pointee(to);
      if (!a || !b || !sameType(a, b)) {
        throw new SemanticError(
          `${context}: cannot put ${typeName(from)} into ${typeName(to)}`,
          span,
          isPointer(source) === isPointer(to)
            ? "The pointers point at different types."
            : "An address and a number are not interchangeable, however similar they look.",
        );
      }
      if (isArray(from)) {
        this.log.add(
          "decay an array to a pointer",
          `${typeName(from)} becomes ${typeName(to)}: the address of the first element. The length is not carried along, which is why C functions need it passed separately.`,
          span,
          [],
        );
      }
      return;
    }

    this.log.add(
      `convert ${typeName(from)} to ${typeName(to)}`,
      `${context} needs a ${typeName(to)}. The conversion is inserted here, silently, as C does.`,
      span,
      [],
    );
  }

  result(error?: Diagnostic): SemanticsResult {
    return {
      symbols: this.symbols,
      resolved: this.resolved,
      types: this.types,
      frames: this.frames,
      steps: this.log.all(),
      ...(error ? { error } : {}),
    };
  }
}

export function analyse(program: Program): SemanticsResult {
  const analyser = new Analyser();
  try {
    analyser.analyse(program);
    return analyser.result();
  } catch (thrown) {
    if (thrown instanceof SemanticError) {
      return analyser.result({
        stage: "semantics",
        message: thrown.message,
        span: thrown.span,
        ...(thrown.hint ? { hint: thrown.hint } : {}),
      });
    }
    throw thrown;
  }
}
