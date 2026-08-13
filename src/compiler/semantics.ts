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

/**
 * The analyser. The parser proved the text has a shape; this stage decides
 * whether the shape means anything — every name resolves, every type lines up,
 * every jump has somewhere to go — and lays out the stack frame that codegen
 * will spend the rest of the pipeline addressing.
 *
 * This is the stage students are usually surprised by, because nothing here is
 * visible in the source text. The symbol table is the compiler's own bookkeeping.
 */

/** Every name in this subset is 4 bytes, which keeps the frame arithmetic readable. */
const SLOT_SIZE = 4;

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
    const existing = scope.get(name);
    if (existing) {
      throw new SemanticError(
        `\`${name}\` is already declared in this scope`,
        span,
        `The earlier declaration is still in scope here.`,
      );
    }

    const symbol: SymbolInfo = {
      id: `sym:${this.nextId}`,
      name,
      type,
      role,
      depth: this.scopes.length - 1,
      span,
      ...(signature ? { signature } : {}),
    };
    this.nextId += 1;

    if (role !== "function") {
      this.frameUsed += SLOT_SIZE;
      symbol.slot = -this.frameUsed;
    }

    scope.set(name, symbol);
    this.symbols.push(symbol);

    const where =
      role === "function"
        ? "the global scope"
        : `frame slot ${symbol.slot} at depth ${symbol.depth}`;
    this.log.add(
      `bind ${name}`,
      role === "function"
        ? "Functions go in the global scope before any body is checked, which is what makes recursion and forward calls work."
        : `The name gets a home: ${where}. Nothing in the source says where it lives — the compiler decides.`,
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
      this.declare(func.name, func.returnType, "function", func.span, {
        params: func.params.map((param) => param.type),
        returns: func.returnType,
      });
    }

    const main = this.lookup("main");
    if (!main) {
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
      func.span,
      [],
    );

    for (const param of func.params) {
      const symbol = this.declare(param.name, param.type, "param", param.span);
      this.resolved[param.id] = symbol.id;
    }

    // The body's statements go in the SAME scope as the parameters, not a
    // nested one — in C, redeclaring a parameter in the body is an error.
    for (const stmt of func.body.stmts) this.analyseStmt(stmt);

    // Round up so the frame stays 16-byte aligned, as the ABI requires.
    const frame = Math.ceil(this.frameUsed / 16) * 16;
    this.frames[func.name] = frame;
    this.log.add(
      `lay out ${func.name}'s frame`,
      `${this.frameUsed} bytes of locals, rounded up to ${frame} to keep the stack 16-byte aligned. Codegen will subtract exactly this much.`,
      func.span,
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
          this.coerce(type, stmt.type, stmt.init.span, `initialising \`${stmt.name}\``);
        }
        const symbol = this.declare(stmt.name, stmt.type, "local", stmt.span);
        this.resolved[stmt.id] = symbol.id;
        return;
      }

      case "ExprStmt":
        this.analyseExpr(stmt.expr);
        return;

      case "Return": {
        const expected = this.currentFunction?.returnType ?? "int";
        if (stmt.value) {
          const actual = this.analyseExpr(stmt.value);
          if (expected === "void") {
            throw new SemanticError(
              `\`${this.currentFunction?.name}\` returns void but this returns a value`,
              stmt.span,
            );
          }
          this.coerce(actual, expected, stmt.span, "returning");
        } else if (expected !== "void") {
          throw new SemanticError(
            `\`${this.currentFunction?.name}\` must return ${expected}`,
            stmt.span,
            "A bare `return;` only works in a void function.",
          );
        }
        return;
      }

      case "If": {
        this.requireValue(this.analyseExpr(stmt.cond), stmt.cond.span, "a condition");
        this.analyseStmt(stmt.then);
        if (stmt.otherwise) this.analyseStmt(stmt.otherwise);
        return;
      }

      case "While": {
        this.requireValue(this.analyseExpr(stmt.cond), stmt.cond.span, "a condition");
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
          this.requireValue(this.analyseExpr(stmt.cond), stmt.cond.span, "a condition");
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

  private analyseExpr(expr: Expr): CType {
    const type = this.inferExpr(expr);
    this.types[expr.id] = type;
    return type;
  }

  private inferExpr(expr: Expr): CType {
    switch (expr.kind) {
      case "NumberLit":
        return "int";

      case "CharLit":
        return "char";

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
          `This use points at the declaration in slot ${symbol.slot}. The name is now an address; the text stops mattering.`,
          expr.span,
          [],
        );
        return symbol.type;
      }

      case "Unary": {
        const operand = this.analyseExpr(expr.operand);
        this.requireValue(operand, expr.operand.span, `\`${expr.op}\``);
        return "int";
      }

      case "Binary": {
        const left = this.analyseExpr(expr.left);
        const right = this.analyseExpr(expr.right);
        this.requireValue(left, expr.left.span, `\`${expr.op}\``);
        this.requireValue(right, expr.right.span, `\`${expr.op}\``);
        if (left !== right) {
          this.log.add(
            `promote char to int for \`${expr.op}\``,
            "C widens a char to an int before arithmetic. The conversion is real work the source never mentions.",
            expr.span,
            [],
          );
        }
        return "int";
      }

      case "Assign": {
        const symbol = this.lookup(expr.name);
        if (!symbol) {
          throw new SemanticError(
            `\`${expr.name}\` is not declared`,
            expr.nameSpan,
            "You can only assign to a name that exists.",
          );
        }
        if (symbol.role === "function") {
          throw new SemanticError(
            `cannot assign to the function \`${expr.name}\``,
            expr.nameSpan,
          );
        }
        this.resolved[expr.id] = symbol.id;
        const value = this.analyseExpr(expr.value);
        this.coerce(value, symbol.type, expr.value.span, `assigning to \`${expr.name}\``);
        return symbol.type;
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
            `It is declared as a ${symbol.type} variable.`,
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
          this.coerce(actual, expected[index], arg.span, `argument ${index + 1}`);
        });

        this.resolved[expr.id] = symbol.id;
        this.log.add(
          `check the call to ${expr.callee}`,
          `${expected.length} argument${expected.length === 1 ? "" : "s"}, types agree, returns ${symbol.signature.returns}.`,
          expr.span,
          [],
        );
        return symbol.signature.returns;
      }
    }
  }

  /** Reject void where a value is needed. */
  private requireValue(type: CType, span: Span, context: string): void {
    if (type === "void") {
      throw new SemanticError(`${context} needs a value, but this is void`, span);
    }
  }

  /** int and char convert freely; void never does. */
  private coerce(from: CType, to: CType, span: Span, context: string): void {
    if (from === to) return;
    if (from === "void" || to === "void") {
      throw new SemanticError(
        `${context}: cannot use a void value`,
        span,
        "A void function returns nothing, so there is nothing to store.",
      );
    }
    this.log.add(
      `convert ${from} to ${to}`,
      `${context} needs a ${to}. The conversion is inserted here, silently, as C does.`,
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
