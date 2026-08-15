import { StepLog } from "./steps";
import { CHAR, INT, VOID, arrayOf, isArray, pointerTo, typeName } from "./ctypes";
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

  /** Every note names the grammar rule it came from; `grammar.ts` lists them. */
  private note(
    title: string,
    explain: string,
    span: Span,
    ids: string[],
    rule: string,
  ): void {
    this.log.add(title, explain, span, ids, rule);
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
      "program",
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
    const base = token.text === "int" ? INT : token.text === "char" ? CHAR : VOID;
    return { type: base, token };
  }

  /**
   * A declarator: the stars before a name and the brackets after it.
   *
   * C reads declarations inside-out, which is how `int (*a)[10]` differs from
   * `int *a[10]`. This subset deliberately accepts only the simple shapes —
   * `int x`, `int *p`, `int **q`, `int a[10]` — and says so rather than
   * mis-parsing anything cleverer.
   */
  private parseDeclarator(
    base: CType,
    options: { arrays: "sized" | "decayed" | "no" },
  ): { type: CType; nameToken: Token } {
    let type = base;
    while (this.accept("*")) type = pointerTo(type);

    if (this.at("(")) {
      throw new ParseError(
        "this declaration is too clever for this explainer",
        this.peek().span,
        "Function pointers and parenthesised declarators are out of subset. Try `int *p` or `int a[10]`.",
      );
    }

    const nameToken = this.peek();
    if (nameToken.kind !== "identifier") {
      throw new ParseError(
        "expected a name in this declaration",
        nameToken.span,
        "Declarations look like `int x;`, `int *p;` or `int a[10];`.",
      );
    }
    this.advance();

    if (this.at("[")) {
      const open = this.advance();
      if (options.arrays === "no") {
        throw new ParseError(
          "an array cannot be declared here",
          open.span,
          "Arrays are locals and parameters only.",
        );
      }

      // `int a[]` as a parameter is a pointer; C decays it and so do we.
      if (options.arrays === "decayed" && this.at("]")) {
        this.advance();
        return { type: pointerTo(type), nameToken };
      }

      const size = this.peek();
      if (size.kind !== "number" || (size.value ?? 0) <= 0) {
        throw new ParseError(
          "an array needs a constant length",
          size.span,
          "Write `int a[10];` — the length has to be known while compiling.",
        );
      }
      this.advance();
      const close = this.expect("]", "to close the array length");
      type = options.arrays === "decayed" ? pointerTo(type) : arrayOf(type, size.value ?? 0);

      if (this.at("[")) {
        throw new ParseError(
          "only one dimension is supported",
          this.peek().span,
          "A second dimension changes what the name decays to, which this explainer does not model.",
        );
      }
      void close;
    }

    // The declarator is where C is at its least obvious, so it says what it read
    // even though it builds no node of its own.
    this.note(
      `declarator ${nameToken.text}`,
      type.kind === "array"
        ? "Brackets bind after the name, so this is an array of the base type — the whole block, not a pointer to it."
        : type.kind === "pointer"
          ? "Stars bind before the name. Read it as: this name, dereferenced, is the base type."
          : "No stars and no brackets, so the declared type is the base type exactly as written.",
      spanOver(nameToken.span, nameToken.span),
      [],
      "declarator",
    );

    return { type, nameToken };
  }

  private parseFunction(): FunctionDecl {
    const { type: base, token: typeToken } = this.parseType();
    let returnType = base;
    while (this.accept("*")) returnType = pointerTo(returnType);

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
      "function",
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
      nameSpan: nameToken.span,
      params,
      body,
    };
  }

  private parseParam(): Param {
    const { type: base, token } = this.parseType();
    // A parameter written `int a[]` is a pointer. C says so, and pretending
    // otherwise is where the array/pointer confusion starts.
    const { type, nameToken } = this.parseDeclarator(base, { arrays: "decayed" });
    const id = this.id();
    this.note(
      `parameter ${nameToken.text}`,
      type.kind === "pointer"
        ? "An array parameter is a pointer — C passes the address, never the elements. The size is gone."
        : "Parameters are declarations too — they will get frame slots like locals do.",
      spanOver(token.span, nameToken.span),
      [id],
      "param",
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
      "block",
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
    const { type: base, token } = this.parseType();
    if (this.peek().kind === "identifier" && this.peek(1).text === "(") {
      throw new ParseError(
        "functions cannot be defined inside a function",
        this.peek().span,
        "Move the definition to the top level.",
      );
    }
    const { type, nameToken } = this.parseDeclarator(base, { arrays: "sized" });

    const id = this.id();
    let init: Expr | undefined;
    if (this.at("=")) {
      const equals = this.advance();
      if (isArray(type)) {
        throw new ParseError(
          "an array cannot be initialised here",
          equals.span,
          "Brace initialisers are out of subset. Declare `int a[3];` and assign each element.",
        );
      }
      init = this.parseExpression();
    }
    const semi = this.expect(";", "to end the declaration");
    this.note(
      `declare ${nameToken.text}`,
      isArray(type)
        ? `An array reserves ${typeName(type)} worth of contiguous stack in one go. The name is not a pointer — it names the whole block.`
        : "A declaration introduces a name. The parser records it; whether it is legal here is the next stage's problem.",
      spanOver(token.span, semi.span),
      [id],
      "declaration",
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
      "if",
    );
    this.expect("(", "after `if`");
    const cond = this.parseExpression();
    this.expect(")", "after the condition");
    const thenBranch = this.parseStatement();
    let otherwise: Stmt | undefined;
    if (this.accept("else")) otherwise = this.parseStatement();
    return {
      id,
      kind: "If",
      span: spanOver(keyword.span, (otherwise ?? thenBranch).span),
      cond,
      thenBranch,
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
      "while",
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
      "for",
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
      "return",
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
      "jump",
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
      "exprstmt",
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

  /**
   * Parse the left side first, then look for `=`.
   *
   * With pointers, an assignment target is no longer just a name — `*p = 1` and
   * `a[i] = 2` are both legal — so the parser cannot decide from one token of
   * lookahead. It parses an expression and then reinterprets it as a target,
   * which is close to how C's grammar actually defines it.
   */
  private parseAssignment(): Expr {
    const left = this.parseBinary(1);
    if (!this.at("=")) return left;

    this.advance();
    if (left.kind !== "Ident" && left.kind !== "Deref" && left.kind !== "Index") {
      throw new ParseError(
        "this cannot be assigned to",
        left.span,
        "The left of `=` has to name a place: a variable, `*p`, or `a[i]`.",
      );
    }

    // Right-associative, so recurse rather than loop: `a = b = 1` is `a = (b = 1)`.
    const value = this.parseAssignment();
    const id = this.id();
    const span = spanOver(left.span, value.span);
    this.note(
      "assign",
      left.kind === "Ident"
        ? "Assignment leans right: `a = b = 1` parses as `a = (b = 1)`."
        : "The left side is a place, not a value. Lowering will compute its address rather than reading it.",
      span,
      [id],
      "assignment",
    );
    return { id, kind: "Assign", span, target: left, value };
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
        "binary",
      );
      left = { id, kind: "Binary", span, op: token.text, left, right };
    }
  }

  private parseUnary(): Expr {
    const token = this.peek();

    if (token.kind === "punct" && (token.text === "*" || token.text === "&")) {
      this.advance();
      const operand = this.parseUnary();
      const id = this.id();
      const span = spanOver(token.span, operand.span);
      const deref = token.text === "*";
      this.note(
        deref ? "dereference" : "address of",
        deref
          ? "The same character that means multiply between two operands means \"follow this address\" in front of one. Position decides, not spelling."
          : "`&` asks for the address of a place. It is the only way to get one, and it is why the variable had to live in memory at all.",
        span,
        [id],
        "unary",
      );
      return deref
        ? { id, kind: "Deref", span, operand }
        : { id, kind: "AddressOf", span, operand };
    }

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
        "unary",
      );
      return { id, kind: "Unary", span, op: token.text, operand };
    }

    return this.parsePostfix();
  }

  /** `a[i]`, and `a[i][j]` would chain here if the subset allowed it. */
  private parsePostfix(): Expr {
    let value = this.parsePrimary();

    while (this.at("[")) {
      this.advance();
      const index = this.parseExpression();
      const close = this.expect("]", "to close the index");
      const id = this.id();
      const span = spanOver(value.span, close.span);
      this.note(
        "index",
        "`a[i]` is defined as `*(a + i)` — brackets are notation for pointer arithmetic, which is why `i[a]` is also legal C.",
        span,
        [id],
        "postfix",
      );
      value = { id, kind: "Index", span, array: value, index };
    }

    return value;
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
        "primary",
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
        "primary",
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
        "primary",
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
      "A value is a number, a character, a name, a call, `*p`, `&x`, or a group in parentheses.",
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
      "call",
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
