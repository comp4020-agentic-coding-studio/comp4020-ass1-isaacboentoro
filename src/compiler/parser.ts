import { StepLog } from "./steps";
import type {
  CType,
  Diagnostic,
  Expr,
  FunctionDecl,
  Param,
  ParseResult,
  Program,
  Span,
  Stmt,
  Token,
} from "./types";
import { spanOver } from "./types";

/**
 * Recursive descent for statements, precedence climbing for expressions.
 *
 * The parser is where the flat token list becomes a shape. Every node it builds
 * is announced as a step, so the tree pane can grow one node at a time in the
 * order the parser actually decided things — which is bottom-up for expressions
 * and top-down for statements, and seeing that difference is half the point.
 */

/** Binary operator precedence; higher binds tighter. */
const PRECEDENCE: Record<string, number> = {
  "||": 1,
  "&&": 2,
  "==": 3,
  "!=": 3,
  "<": 4,
  ">": 4,
  "<=": 4,
  ">=": 4,
  "+": 5,
  "-": 5,
  "*": 6,
  "/": 6,
  "%": 6,
};

const TYPE_KEYWORDS = new Set(["int", "char", "void"]);

class ParseError extends Error {
  constructor(
    override readonly message: string,
    readonly span: Span,
    readonly hint?: string,
  ) {
    super(message);
  }
}

class Parser {
  private pos = 0;
  private nextId = 0;
  readonly log = new StepLog("parse");

  constructor(private readonly tokens: Token[]) {}

  // ------------------------------------------------------------- token access

  private peek(offset = 0): Token {
    return this.tokens[Math.min(this.pos + offset, this.tokens.length - 1)];
  }

  private at(text: string): boolean {
    const token = this.peek();
    return token.kind !== "eof" && token.text === text;
  }

  private atType(): boolean {
    return this.peek().kind === "keyword" && TYPE_KEYWORDS.has(this.peek().text);
  }

  private advance(): Token {
    const token = this.peek();
    if (this.pos < this.tokens.length - 1) this.pos += 1;
    return token;
  }

  private accept(text: string): Token | null {
    return this.at(text) ? this.advance() : null;
  }

  private expect(text: string, why: string): Token {
    if (this.at(text)) return this.advance();
    const token = this.peek();
    const found = token.kind === "eof" ? "the end of the file" : `\`${token.text}\``;
    throw new ParseError(`expected \`${text}\` ${why}, found ${found}`, token.span, why);
  }

  private id(): string {
    const id = `ast:${this.nextId}`;
    this.nextId += 1;
    return id;
  }

  private note(title: string, explain: string, span: Span, ids: string[]): void {
    this.log.add(title, explain, span, ids);
  }

  // ------------------------------------------------------------------ program

  parseProgram(): Program {
    const functions: FunctionDecl[] = [];
    const id = this.id();
    this.note(
      "start the program",
      "The parser expects a sequence of function definitions and nothing else at the top level.",
      this.peek().span,
      [id],
    );

    while (this.peek().kind !== "eof") {
      functions.push(this.parseFunction());
    }

    if (functions.length === 0) {
      throw new ParseError(
        "a program needs at least one function",
        this.peek().span,
        "Try `int main() { return 0; }`.",
      );
    }

    const span = spanOver(
      functions[0].span,
      functions[functions.length - 1].span,
    );
    return { id, kind: "Program", span, functions };
  }

  private parseType(): { type: CType; token: Token } {
    if (!this.atType()) {
      const token = this.peek();
      throw new ParseError(
        `expected a type, found \`${token.text || "end of file"}\``,
        token.span,
        "This subset has int, char and void.",
      );
    }
    const token = this.advance();
    return { type: token.text as CType, token };
  }

  private parseFunction(): FunctionDecl {
    const { type: returnType, token: typeToken } = this.parseType();
    const nameToken = this.peek();
    if (nameToken.kind !== "identifier") {
      throw new ParseError(
        "expected a function name",
        nameToken.span,
        "Top level holds function definitions only — no globals in this subset.",
      );
    }
    this.advance();
    const id = this.id();
    this.note(
      `open function ${nameToken.text}`,
      "A type followed by a name and a parenthesis is a function definition. The parser commits to that shape now and fills it in.",
      spanOver(typeToken.span, nameToken.span),
      [id],
    );

    this.expect("(", "to open the parameter list");
    const params: Param[] = [];
    if (!this.at(")")) {
      do {
        params.push(this.parseParam());
      } while (this.accept(","));
    }
    this.expect(")", "to close the parameter list");

    const body = this.parseBlock();
    return {
      id,
      kind: "Function",
      span: spanOver(typeToken.span, body.span),
      returnType,
      name: nameToken.text,
      params,
      body,
    };
  }

  private parseParam(): Param {
    const { type, token } = this.parseType();
    const nameToken = this.peek();
    if (nameToken.kind !== "identifier") {
      throw new ParseError("expected a parameter name", nameToken.span);
    }
    this.advance();
    const id = this.id();
    this.note(
      `parameter ${nameToken.text}`,
      "Parameters are declarations too — they will get frame slots like locals do.",
      spanOver(token.span, nameToken.span),
      [id],
    );
    return {
      id,
      kind: "Param",
      span: spanOver(token.span, nameToken.span),
      type,
      name: nameToken.text,
    };
  }

  // --------------------------------------------------------------- statements

  private parseBlock(): Stmt & { kind: "Block" } {
    const open = this.expect("{", "to open a block");
    const id = this.id();
    this.note(
      "open a block",
      "A block is a new scope. Names declared inside it stop existing at the closing brace.",
      open.span,
      [id],
    );
    const stmts: Stmt[] = [];
    while (!this.at("}") && this.peek().kind !== "eof") {
      stmts.push(this.parseStatement());
    }
    const close = this.expect("}", "to close the block");
    return {
      id,
      kind: "Block",
      span: spanOver(open.span, close.span),
      stmts,
    };
  }

  private parseStatement(): Stmt {
    if (this.at("{")) return this.parseBlock();
    if (this.atType()) return this.parseVarDecl();
    if (this.at("if")) return this.parseIf();
    if (this.at("while")) return this.parseWhile();
    if (this.at("for")) return this.parseFor();
    if (this.at("return")) return this.parseReturn();
    if (this.at("break") || this.at("continue")) return this.parseJump();
    return this.parseExprStatement();
  }

  private parseVarDecl(): Stmt {
    const { type, token } = this.parseType();
    const nameToken = this.peek();
    if (nameToken.kind !== "identifier") {
      throw new ParseError(
        "expected a variable name after the type",
        nameToken.span,
        "Declarations in this subset are simple: `int x;` or `int x = 1;`.",
      );
    }
    this.advance();
    if (this.at("(")) {
      throw new ParseError(
        "functions cannot be defined inside a function",
        nameToken.span,
        "Move the definition to the top level.",
      );
    }
    const id = this.id();
    let init: Expr | undefined;
    if (this.accept("=")) init = this.parseExpression();
    const semi = this.expect(";", "to end the declaration");
    this.note(
      `declare ${nameToken.text}`,
      "A declaration introduces a name. The parser records it; whether it is legal here is the next stage's problem.",
      spanOver(token.span, semi.span),
      [id],
    );
    return {
      id,
      kind: "VarDecl",
      span: spanOver(token.span, semi.span),
      type,
      name: nameToken.text,
      ...(init ? { init } : {}),
    };
  }

  private parseIf(): Stmt {
    const keyword = this.advance();
    const id = this.id();
    this.note(
      "open an if",
      "Control flow is still a tree here. It becomes jumps and labels two stages later.",
      keyword.span,
      [id],
    );
    this.expect("(", "after `if`");
    const cond = this.parseExpression();
    this.expect(")", "after the condition");
    const then = this.parseStatement();
    let otherwise: Stmt | undefined;
    if (this.accept("else")) otherwise = this.parseStatement();
    return {
      id,
      kind: "If",
      span: spanOver(keyword.span, (otherwise ?? then).span),
      cond,
      then,
      ...(otherwise ? { otherwise } : {}),
    };
  }

  private parseWhile(): Stmt {
    const keyword = this.advance();
    const id = this.id();
    this.note(
      "open a while",
      "One condition, one body. The loop is a node with two children, not yet a backward jump.",
      keyword.span,
      [id],
    );
    this.expect("(", "after `while`");
    const cond = this.parseExpression();
    this.expect(")", "after the condition");
    const body = this.parseStatement();
    return {
      id,
      kind: "While",
      span: spanOver(keyword.span, body.span),
      cond,
      body,
    };
  }

  private parseFor(): Stmt {
    const keyword = this.advance();
    const id = this.id();
    this.note(
      "open a for",
      "A `for` is three optional expressions and a body — the parser keeps them apart so lowering can reorder them.",
      keyword.span,
      [id],
    );
    this.expect("(", "after `for`");

    let init: Stmt | undefined;
    if (!this.at(";")) {
      init = this.atType() ? this.parseVarDecl() : this.parseExprStatement();
    } else {
      this.advance();
    }

    let cond: Expr | undefined;
    if (!this.at(";")) cond = this.parseExpression();
    this.expect(";", "after the loop condition");

    let update: Expr | undefined;
    if (!this.at(")")) update = this.parseExpression();
    this.expect(")", "to close the for header");

    const body = this.parseStatement();
    return {
      id,
      kind: "For",
      span: spanOver(keyword.span, body.span),
      ...(init ? { init } : {}),
      ...(cond ? { cond } : {}),
      ...(update ? { update } : {}),
      body,
    };
  }

  private parseReturn(): Stmt {
    const keyword = this.advance();
    const id = this.id();
    let value: Expr | undefined;
    if (!this.at(";")) value = this.parseExpression();
    const semi = this.expect(";", "to end the return");
    this.note(
      "return",
      "The value is computed first, then handed back. Lowering will make that order explicit.",
      spanOver(keyword.span, semi.span),
      [id],
    );
    return {
      id,
      kind: "Return",
      span: spanOver(keyword.span, semi.span),
      ...(value ? { value } : {}),
    };
  }

  private parseJump(): Stmt {
    const keyword = this.advance();
    const semi = this.expect(";", `to end the \`${keyword.text}\``);
    const id = this.id();
    this.note(
      keyword.text,
      "A bare jump. Which label it lands on depends on the loop it sits in, so lowering decides.",
      spanOver(keyword.span, semi.span),
      [id],
    );
    return {
      id,
      kind: keyword.text === "break" ? "Break" : "Continue",
      span: spanOver(keyword.span, semi.span),
    };
  }

  private parseExprStatement(): Stmt {
    const expr = this.parseExpression();
    const semi = this.expect(";", "to end the statement");
    const id = this.id();
    this.note(
      "statement ends",
      "The semicolon is what turns an expression into a statement: compute it, discard the value.",
      semi.span,
      [id],
    );
    return {
      id,
      kind: "ExprStmt",
      span: spanOver(expr.span, semi.span),
      expr,
    };
  }

  // -------------------------------------------------------------- expressions

  private parseExpression(): Expr {
    return this.parseAssignment();
  }

  private parseAssignment(): Expr {
    // Assignment is right-associative, so recurse rather than loop.
    if (this.peek().kind === "identifier" && this.peek(1).text === "=") {
      const nameToken = this.advance();
      this.advance();
      const value = this.parseAssignment();
      const id = this.id();
      this.note(
        `assign to ${nameToken.text}`,
        "Assignment leans right: `a = b = 1` parses as `a = (b = 1)`.",
        spanOver(nameToken.span, value.span),
        [id],
      );
      return {
        id,
        kind: "Assign",
        span: spanOver(nameToken.span, value.span),
        name: nameToken.text,
        nameSpan: nameToken.span,
        value,
      };
    }
    return this.parseBinary(1);
  }

  /** Precedence climbing: parse operators at `minPrecedence` or tighter. */
  private parseBinary(minPrecedence: number): Expr {
    let left = this.parseUnary();

    for (;;) {
      const token = this.peek();
      const precedence =
        token.kind === "punct" ? PRECEDENCE[token.text] : undefined;
      if (precedence === undefined || precedence < minPrecedence) return left;

      this.advance();
      const right = this.parseBinary(precedence + 1);
      const id = this.id();
      const span = spanOver(left.span, right.span);
      this.note(
        `reduce \`${token.text}\``,
        `Both operands are complete, so \`${token.text}\` becomes their parent. Precedence decided the shape, not the order you read it in.`,
        span,
        [id],
      );
      left = { id, kind: "Binary", span, op: token.text, left, right };
    }
  }

  private parseUnary(): Expr {
    const token = this.peek();
    if (token.kind === "punct" && (token.text === "-" || token.text === "!")) {
      this.advance();
      const operand = this.parseUnary();
      const id = this.id();
      const span = spanOver(token.span, operand.span);
      this.note(
        `unary \`${token.text}\``,
        "A prefix operator takes exactly one operand and binds tighter than any binary one.",
        span,
        [id],
      );
      return { id, kind: "Unary", span, op: token.text, operand };
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const token = this.peek();

    if (token.kind === "number") {
      this.advance();
      const id = this.id();
      this.note(
        `literal ${token.text}`,
        "A leaf. Nothing to compute — the value is already known at compile time.",
        token.span,
        [id],
      );
      return { id, kind: "NumberLit", span: token.span, value: token.value ?? 0 };
    }

    if (token.kind === "char") {
      this.advance();
      const id = this.id();
      this.note(
        `literal ${token.text}`,
        `A character literal is the integer ${token.value}. The quotes are notation, not a type.`,
        token.span,
        [id],
      );
      return {
        id,
        kind: "CharLit",
        span: token.span,
        value: token.value ?? 0,
        text: token.text,
      };
    }

    if (token.kind === "identifier") {
      this.advance();
      if (this.at("(")) return this.parseCall(token);
      const id = this.id();
      this.note(
        `name ${token.text}`,
        "A use of a name. The parser does not check it exists; that is the analyser's job.",
        token.span,
        [id],
      );
      return { id, kind: "Ident", span: token.span, name: token.text };
    }

    if (token.text === "(") {
      this.advance();
      const inner = this.parseExpression();
      this.expect(")", "to close the group");
      // Parentheses leave no node: they only changed which reduction happened.
      return inner;
    }

    const found = token.kind === "eof" ? "the end of the file" : `\`${token.text}\``;
    throw new ParseError(
      `expected a value, found ${found}`,
      token.span,
      "A value is a number, a character, a name, a call, or a group in parentheses.",
    );
  }

  private parseCall(nameToken: Token): Expr {
    this.expect("(", "to open the argument list");
    const args: Expr[] = [];
    if (!this.at(")")) {
      do {
        args.push(this.parseExpression());
      } while (this.accept(","));
    }
    const close = this.expect(")", "to close the argument list");
    const id = this.id();
    const span = spanOver(nameToken.span, close.span);
    this.note(
      `call ${nameToken.text}`,
      "The arguments are already parsed, so the call node closes over them. Whether the function exists is checked later.",
      span,
      [id],
    );
    return { id, kind: "Call", span, callee: nameToken.text, args };
  }
}

export function parse(tokens: Token[]): ParseResult {
  const parser = new Parser(tokens);
  const empty: Program = {
    id: "ast:0",
    kind: "Program",
    span: { start: 0, end: 0 },
    functions: [],
  };

  try {
    const program = parser.parseProgram();
    return { program, steps: parser.log.all() };
  } catch (thrown) {
    if (thrown instanceof ParseError) {
      const error: Diagnostic = {
        stage: "parse",
        message: thrown.message,
        span: thrown.span,
        ...(thrown.hint ? { hint: thrown.hint } : {}),
      };
      return { program: empty, steps: parser.log.all(), error };
    }
    throw thrown;
  }
}
