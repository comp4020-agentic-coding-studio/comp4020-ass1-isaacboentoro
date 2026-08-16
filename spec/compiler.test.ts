import { describe, expect, it } from "vitest";
import { scan } from "../src/compiler/lexer";
import { parse } from "../src/compiler/parser";
import { formatInstr } from "../src/compiler/ir";
import { compile } from "../src/compiler/pipeline";
import { analyse } from "../src/compiler/semantics";
import { preprocess } from "../src/compiler/preprocess";
import { INT, typeName } from "../src/compiler/ctypes";
import { METHOD, PARSE_RULES, RULES_BY_STAGE } from "../src/compiler/grammar";
import {
  ALLOCATABLE,
  SCRATCH_A,
  SCRATCH_B,
  regName,
} from "../src/compiler/registers";
import { SOURCE, STAGE_IO } from "../src/compiler/stages";
import type { AstNode, Expr, Span, Stmt } from "../src/compiler/types";
import { STAGES, childrenOf, labelOf } from "../src/compiler/types";

/**
 * Stage-level contracts. The one that matters most is the span contract: every
 * artefact must point at text the user actually typed, because that is what the
 * editor highlights while the scrubber moves.
 */

function spanText(source: string, span: Span): string {
  return source.slice(span.start, span.end);
}

describe("preprocess", () => {
  it("passes plain source through unchanged", () => {
    const source = "int main() { return 1; }";
    const result = preprocess(source);
    expect(result.text).toBe(source);
    expect(result.error).toBeUndefined();
  });

  it("replaces a comment with one space and keeps later offsets honest", () => {
    const source = "int a/*gone*/b;";
    const result = preprocess(source);
    expect(result.text).toBe("int a b;");
    // The `b` in the output must still point at the `b` in the input.
    const bAt = result.text.indexOf("b");
    expect(source[result.map[bAt]]).toBe("b");
  });

  it("strips a line comment", () => {
    const result = preprocess("int x; // note\nint y;");
    expect(result.text).toBe("int x;  \nint y;");
    expect(result.expansions[0].kind).toBe("comment");
  });

  it("substitutes an object-like macro", () => {
    const result = preprocess("#define N 4\nint x = N;");
    expect(result.text.trim()).toBe("int x = 4;");
    expect(result.expansions.map((e) => e.kind)).toContain("expansion");
  });

  it("substitutes a function-like macro argument verbatim", () => {
    const result = preprocess("#define TWICE(x) ((x)+(x))\nint y = TWICE(1+2);");
    expect(result.text).toContain("((1+2)+(1+2))");
  });

  it("adds no parentheses of its own, so the classic macro trap survives", () => {
    // TWICE(1) * 3 becomes 1 + 1 * 3, which is 4 — not 6. A preprocessor that
    // quietly parenthesised arguments would hide this.
    const result = preprocess("#define TWICE(x) x + x\nint y = TWICE(1) * 3;");
    expect(result.text).toContain("1 + 1 * 3");
  });

  it("attributes expanded text to the call site, not the macro body", () => {
    const source = "#define N 40\nint x = N;";
    const result = preprocess(source);
    const fourAt = result.text.indexOf("40");
    expect(source.slice(result.map[fourAt], result.map[fourAt] + 1)).toBe("N");
  });

  it("rescans expansion output so a macro inside a macro expands too", () => {
    const result = preprocess(
      "#define SIZE 4\n#define DOUBLE(x) ((x) + (x))\nint n = DOUBLE(SIZE);",
    );
    expect(result.text).toContain("((4) + (4))");
    expect(result.text).not.toContain("SIZE");
  });

  it("expands a chain of object-like macros", () => {
    const result = preprocess("#define A B\n#define B 3\nint x = A;");
    expect(result.text.trim().endsWith("int x = 3;")).toBe(true);
  });

  it("gives up rather than looping on a self-referential macro", () => {
    const result = preprocess("#define LOOP LOOP + 1\nint x = LOOP;");
    expect(result.error).toBeUndefined();
    expect(result.text).toContain("+ 1");
  });

  it("drops #include with a note rather than failing", () => {
    const result = preprocess("#include <stdio.h>\nint main() { return 0; }");
    expect(result.error).toBeUndefined();
    expect(result.expansions[0].note).toContain("#include");
  });

  it("refuses an unsupported directive with a real diagnostic", () => {
    const result = preprocess("#ifdef DEBUG\nint x;\n#endif");
    expect(result.error?.stage).toBe("preprocess");
    expect(result.error?.message).toContain("#ifdef");
  });

  it("emits at least one step for every source", () => {
    expect(preprocess("int x;").steps.length).toBeGreaterThan(0);
  });
});

describe("scan", () => {
  function tokensOf(source: string) {
    const pre = preprocess(source);
    return scan(pre.text, pre.map);
  }

  it("classifies keywords, identifiers, numbers and punctuation", () => {
    const { tokens } = tokensOf("int x = 42;");
    expect(tokens.map((t) => [t.kind, t.text])).toEqual([
      ["keyword", "int"],
      ["identifier", "x"],
      ["punct", "="],
      ["number", "42"],
      ["punct", ";"],
      ["eof", ""],
    ]);
  });

  it("prefers the two-character operator", () => {
    const { tokens } = tokensOf("a <= b");
    expect(tokens[1].text).toBe("<=");
  });

  it("reads character literals as integers", () => {
    const { tokens } = tokensOf("char c = 'A';");
    expect(tokens.find((t) => t.kind === "char")?.value).toBe(65);
  });

  it("reads escape sequences", () => {
    const { tokens } = tokensOf("char c = '\\n';");
    expect(tokens.find((t) => t.kind === "char")?.value).toBe(10);
  });

  it("every token span quotes the original text", () => {
    const source = "int total = 7 + 3;";
    const { tokens } = tokensOf(source);
    for (const token of tokens) {
      if (token.kind === "eof") continue;
      expect(spanText(source, token.span)).toBe(token.text);
    }
  });

  it("spans survive a macro expansion by pointing at the call site", () => {
    const source = "#define N 9\nint x = N;";
    const { tokens } = tokensOf(source);
    const nine = tokens.find((t) => t.kind === "number");
    expect(nine?.text).toBe("9");
    expect(spanText(source, nine!.span)).toBe("N");
  });

  it("rejects a stray character with a span", () => {
    const source = "int x = a $ b;";
    const { error } = tokensOf(source);
    expect(error?.stage).toBe("scan");
    expect(spanText(source, error!.span)).toBe("$");
  });

  it("rejects a number glued to a letter", () => {
    const { error } = tokensOf("int x = 12abc;");
    expect(error?.message).toContain("not a number");
  });

  it("emits one step per token", () => {
    const { tokens, steps } = tokensOf("int x;");
    expect(steps.length).toBe(tokens.length);
  });
});

describe("parse", () => {
  function parseSource(source: string) {
    const pre = preprocess(source);
    const scanned = scan(pre.text, pre.map);
    return parse(scanned.tokens);
  }

  /** A parenthesised sketch of the tree, for asserting shape not identity. */
  function sketch(node: AstNode): string {
    const children = childrenOf(node);
    if (children.length === 0) return labelOf(node);
    return `(${labelOf(node)} ${children.map(sketch).join(" ")})`;
  }

  function bodyOf(source: string): Stmt[] {
    const { program, error } = parseSource(source);
    expect(error).toBeUndefined();
    return program.functions[0].body.stmts;
  }

  function firstExpr(expression: string): Expr {
    const stmts = bodyOf(`int main() { return ${expression}; }`);
    const first = stmts[0];
    if (first.kind !== "Return" || !first.value) throw new Error("no expression");
    return first.value;
  }

  it("parses a whole function", () => {
    const { program, error } = parseSource("int main() { return 0; }");
    expect(error).toBeUndefined();
    expect(program.functions).toHaveLength(1);
    expect(program.functions[0].name).toBe("main");
    expect(program.functions[0].returnType).toEqual(INT);
  });

  it("gives `*` tighter precedence than `+`", () => {
    expect(sketch(firstExpr("1 + 2 * 3"))).toBe("(+ 1 (* 2 3))");
  });

  it("keeps binary operators left-associative", () => {
    expect(sketch(firstExpr("1 - 2 - 3"))).toBe("(- (- 1 2) 3)");
  });

  it("lets parentheses override precedence without leaving a node", () => {
    expect(sketch(firstExpr("(1 + 2) * 3"))).toBe("(* (+ 1 2) 3)");
  });

  it("ranks comparison below arithmetic and above &&", () => {
    expect(sketch(firstExpr("a + 1 < b && c"))).toBe("(&& (< (+ a 1) b) c)");
  });

  it("makes assignment right-associative", () => {
    const stmts = bodyOf("int main() { int a; int b; a = b = 1; return a; }");
    // The target is a whole subtree now, not a name on the node.
    expect(sketch(stmts[2])).toBe("(; (= a (= b 1)))");
  });

  it("binds unary minus tighter than any binary operator", () => {
    expect(sketch(firstExpr("-a * b"))).toBe("(* (- a) b)");
  });

  it("parses calls with arguments", () => {
    expect(sketch(firstExpr("add(1, 2 * 3)"))).toBe("(add(…) 1 (* 2 3))");
  });

  it("parses if/else, while and for", () => {
    const stmts = bodyOf(`int main() {
      int i;
      if (i) { i = 1; } else { i = 2; }
      while (i) { i = i - 1; }
      for (int j = 0; j < 3; j = j + 1) { i = i + j; }
      return i;
    }`);
    expect(stmts.map((s) => s.kind)).toEqual([
      "VarDecl",
      "If",
      "While",
      "For",
      "Return",
    ]);
  });

  it("parses several functions and recursion", () => {
    const { program, error } = parseSource(
      "int fact(int n) { if (n < 2) { return 1; } return n * fact(n - 1); } int main() { return fact(5); }",
    );
    expect(error).toBeUndefined();
    expect(program.functions.map((f) => f.name)).toEqual(["fact", "main"]);
    expect(program.functions[0].params[0].name).toBe("n");
  });

  it("reports a missing semicolon at the right place", () => {
    const source = "int main() { int x = 1 return x; }";
    const { error } = parseSource(source);
    expect(error?.stage).toBe("parse");
    expect(error?.message).toContain("expected `;`");
    expect(spanText(source, error!.span)).toBe("return");
  });

  it("reports an unclosed brace against the end of the file", () => {
    const { error } = parseSource("int main() { return 0;");
    expect(error?.message).toContain("expected `}`");
  });

  it("names what is out of subset rather than crashing", () => {
    const { error } = parseSource("int main() { int f() { return 1; } return 0; }");
    expect(error?.message).toContain("functions cannot be defined inside");
  });

  it("keeps every node span inside the original source", () => {
    const source = "int main() { int x = 1 + 2; return x; }";
    const { program } = parseSource(source);
    const walk = (node: AstNode) => {
      expect(node.span.start).toBeGreaterThanOrEqual(0);
      expect(node.span.end).toBeLessThanOrEqual(source.length);
      expect(node.span.end).toBeGreaterThanOrEqual(node.span.start);
      childrenOf(node).forEach(walk);
    };
    walk(program);
  });

  it("reduces expressions bottom-up in the step trace", () => {
    const { steps } = parseSource("int main() { return 1 + 2 * 3; }");
    const titles = steps.map((s) => s.title);
    // The inner `*` must be reduced before the outer `+`.
    expect(titles.indexOf("reduce `*`")).toBeLessThan(titles.indexOf("reduce `+`"));
  });

  it("produces every node id exactly once across its steps", () => {
    const { steps } = parseSource("int main() { int x = 1; return x + 1; }");
    const produced = steps.flatMap((s) => s.produced);
    expect(new Set(produced).size).toBe(produced.length);
  });
});

describe("analyse", () => {
  function analyseSource(source: string) {
    const pre = preprocess(source);
    const scanned = scan(pre.text, pre.map);
    const parsed = parse(scanned.tokens);
    expect(parsed.error).toBeUndefined();
    return analyse(parsed.program);
  }

  it("records a symbol for every declaration", () => {
    const result = analyseSource("int main() { int x; char c; return x; }");
    expect(result.error).toBeUndefined();
    expect(result.symbols.map((s) => [s.name, s.role])).toEqual([
      ["main", "function"],
      ["x", "local"],
      ["c", "local"],
    ]);
  });

  it("gives each local its own frame slot and aligns the frame to 16", () => {
    const result = analyseSource("int main() { int a; int b; return a; }");
    const slots = result.symbols
      .filter((s) => s.role !== "function")
      .map((s) => s.slot);
    expect(slots).toEqual([-4, -8]);
    // Only the named locals; temporaries and alignment are codegen's problem.
    expect(result.frames.main).toBe(8);
  });

  it("restarts slot numbering for each function", () => {
    const result = analyseSource(
      "int helper(int a) { int b; return a + b; } int main() { int z; return helper(z); }",
    );
    const byName = new Map(result.symbols.map((s) => [s.name, s.slot]));
    expect(byName.get("a")).toBe(-4);
    expect(byName.get("z")).toBe(-4);
  });

  it("resolves a use to the innermost declaration", () => {
    const result = analyseSource(
      "int main() { int x; { int x; x = 1; } return x; }",
    );
    expect(result.error).toBeUndefined();
    const xs = result.symbols.filter((s) => s.name === "x");
    expect(xs.map((s) => s.depth)).toEqual([1, 2]);
  });

  it("rejects an undeclared name and points at it", () => {
    const source = "int main() { return missing; }";
    const { error } = analyseSource(source);
    expect(error?.stage).toBe("semantics");
    expect(spanText(source, error!.span)).toBe("missing");
  });

  it("rejects a redeclaration in the same scope", () => {
    const { error } = analyseSource("int main() { int x; int x; return x; }");
    expect(error?.message).toContain("already declared");
  });

  it("treats the body as the parameters' own scope, not a nested one", () => {
    const { error } = analyseSource(
      "int f(int a) { int a; return a; } int main() { return f(1); }",
    );
    expect(error?.message).toContain("already declared");
  });

  it("rejects a name reading itself in its own initialiser", () => {
    const { error } = analyseSource("int main() { int x = x; return x; }");
    expect(error?.message).toContain("not declared");
  });

  it("rejects a call with the wrong number of arguments", () => {
    const { error } = analyseSource(
      "int add(int a, int b) { return a + b; } int main() { return add(1); }",
    );
    expect(error?.message).toContain("takes 2 arguments, not 1");
  });

  it("rejects calling something that is not a function", () => {
    const { error } = analyseSource("int main() { int x; return x(1); }");
    expect(error?.message).toContain("is not a function");
  });

  it("rejects using a void result as a value", () => {
    const { error } = analyseSource(
      "void nothing() { return; } int main() { int x = nothing(); return x; }",
    );
    expect(error?.message).toContain("void");
  });

  it("rejects break outside a loop", () => {
    const { error } = analyseSource("int main() { break; return 0; }");
    expect(error?.message).toContain("outside a loop");
  });

  it("accepts break inside a loop", () => {
    const { error } = analyseSource(
      "int main() { while (1) { break; } return 0; }",
    );
    expect(error).toBeUndefined();
  });

  it("requires main", () => {
    const { error } = analyseSource("int helper() { return 1; }");
    expect(error?.message).toContain("no `main`");
  });

  it("allows a call to a function defined later", () => {
    const { error } = analyseSource(
      "int main() { return later(); } int later() { return 1; }",
    );
    expect(error).toBeUndefined();
  });

  it("allows recursion", () => {
    const { error } = analyseSource(
      "int fact(int n) { if (n < 2) { return 1; } return n * fact(n - 1); } int main() { return fact(5); }",
    );
    expect(error).toBeUndefined();
  });

  it("types arithmetic as int even when the operands are chars", () => {
    const source = "int main() { char a; char b; return a + b; }";
    const pre = preprocess(source);
    const parsed = parse(scan(pre.text, pre.map).tokens);
    const result = analyse(parsed.program);
    const returned = parsed.program.functions[0].body.stmts[2];
    if (returned.kind !== "Return" || !returned.value) throw new Error("no return");
    expect(typeName(result.types[returned.value.id])).toBe("int");
  });

  it("scopes a for-header declaration to the loop", () => {
    const { error } = analyseSource(
      "int main() { for (int i = 0; i < 3; i = i + 1) { } return i; }",
    );
    expect(error?.message).toContain("`i` is not declared");
  });
});

describe("lower to IR", () => {
  function irOf(source: string): string[] {
    const result = compile(source);
    expect(result.error).toBeUndefined();
    return result.ir.instrs.map(formatInstr);
  }

  function inMain(source: string): string[] {
    const lines = irOf(source);
    const start = lines.findIndex((line) => line.startsWith("main:"));
    return lines.slice(start + 1);
  }

  it("flattens a nested expression into three-address form", () => {
    expect(inMain("int main() { return 1 + 2 * 3; }")).toEqual([
      "t0 = 2 * 3",
      "t1 = 1 + t0",
      "return t1",
    ]);
  });

  it("turns an if into one conditional jump and a label", () => {
    expect(inMain("int main() { int x; if (x) { x = 1; } return x; }")).toEqual([
      "if !x jump .Lmain0_endif",
      "x = 1",
      ".Lmain0_endif:",
      "return x",
    ]);
  });

  it("gives if/else a jump over the else branch", () => {
    const ir = inMain(
      "int main() { int x; if (x) { x = 1; } else { x = 2; } return x; }",
    );
    expect(ir).toEqual([
      "if !x jump .Lmain0_else",
      "x = 1",
      "jump .Lmain1_endif",
      ".Lmain0_else:",
      "x = 2",
      ".Lmain1_endif:",
      "return x",
    ]);
  });

  it("turns a while into a backward jump", () => {
    const ir = inMain("int main() { int x; while (x) { x = x - 1; } return x; }");
    expect(ir[0]).toBe(".Lmain0_while:");
    expect(ir).toContain("jump .Lmain0_while");
    expect(ir.at(-2)).toBe(".Lmain1_endwhile:");
  });

  it("puts the for-update after the body so continue still runs it", () => {
    const ir = inMain(
      "int main() { int s = 0; for (int i = 0; i < 3; i = i + 1) { continue; } return s; }",
    );
    const step = ir.indexOf(".Lmain1_forstep:");
    const jumpBack = ir.indexOf("jump .Lmain0_for");
    expect(ir).toContain("jump .Lmain1_forstep");
    expect(step).toBeLessThan(jumpBack);
  });

  it("sends break to the loop's exit label", () => {
    const ir = inMain("int main() { while (1) { break; } return 0; }");
    expect(ir).toContain("jump .Lmain1_endwhile");
  });

  it("short-circuits && into a branch that skips the right operand", () => {
    const ir = inMain("int main() { int a; int b; return a && b; }");
    expect(ir).toEqual([
      "t0 = 0",
      "if !a jump .Lmain0_and",
      "if !b jump .Lmain0_and",
      "t0 = 1",
      ".Lmain0_and:",
      "return t0",
    ]);
  });

  it("short-circuits || the other way around", () => {
    const ir = inMain("int main() { int a; int b; return a || b; }");
    expect(ir[0]).toBe("t0 = 1");
    expect(ir[1]).toBe("if a jump .Lmain0_or");
    expect(ir).toContain("t0 = 0");
  });

  it("evaluates call arguments into temporaries before the call", () => {
    const ir = inMain(
      "int add(int a, int b) { return a + b; } int main() { return add(1 + 1, 2); }",
    );
    expect(ir).toEqual(["t0 = 1 + 1", "t1 = call add(t0, 2)", "return t1"]);
  });

  it("emits a return even when the source forgot one", () => {
    const ir = inMain("int main() { int x; }");
    expect(ir.at(-1)).toBe("return 0");
  });

  it("names labels per function so two functions cannot collide", () => {
    const ir = irOf(
      "int f(int n) { if (n) { return 1; } return 0; } int main() { if (1) { return 1; } return 0; }",
    );
    const labels = ir.filter((line) => line.startsWith(".L"));
    expect(new Set(labels).size).toBe(labels.length);
  });

  it("restarts temporaries per function", () => {
    const ir = irOf(
      "int f() { return 1 + 1; } int main() { return 2 + 2; }",
    );
    expect(ir.filter((line) => line.startsWith("t0 =")).length).toBe(2);
  });

  it("keeps every instruction's span inside the source", () => {
    const source = "int main() { int x = 1; while (x) { x = x - 1; } return x; }";
    const result = compile(source);
    for (const instr of result.ir.instrs) {
      expect(instr.span.start).toBeGreaterThanOrEqual(0);
      expect(instr.span.end).toBeLessThanOrEqual(source.length);
    }
  });
});

describe("generate assembly", () => {
  function asmOf(source: string): string[] {
    const result = compile(source);
    expect(result.error).toBeUndefined();
    return result.codegen.lines.map((line) => line.text);
  }

  it("opens with directives and a global entry point", () => {
    const asm = asmOf("int main() { return 0; }");
    expect(asm.slice(0, 3)).toEqual([
      ".intel_syntax noprefix",
      ".text",
      ".globl main",
    ]);
  });

  it("emits a prologue that reserves room for locals and temporaries", () => {
    const asm = asmOf("int main() { int a; int b; return a + b; }");
    expect(asm).toContain("push rbp");
    expect(asm).toContain("mov rbp, rsp");
    // 8 bytes of locals plus one temporary, aligned up to 16.
    expect(asm).toContain("sub rsp, 16");
  });

  it("spills incoming arguments from registers to their slots", () => {
    const asm = asmOf(
      "int add(int a, int b) { return a + b; } int main() { return add(1, 2); }",
    );
    expect(asm).toContain("mov [rbp-4], edi");
    expect(asm).toContain("mov [rbp-8], esi");
  });

  it("passes arguments in the System V registers", () => {
    const asm = asmOf(
      "int add(int a, int b) { return a + b; } int main() { return add(1, 2); }",
    );
    expect(asm).toContain("mov edi, 1");
    expect(asm).toContain("mov esi, 2");
    expect(asm).toContain("call add");
  });

  it("turns a comparison into cmp plus setcc", () => {
    const asm = asmOf("int main() { int a; return a < 3; }");
    // `a` is a named local, so it has to be fetched; the answer is a temporary,
    // so it lands wherever the allocator put it.
    expect(asm.some((line) => /^cmp \w+, 3$/.test(line))).toBe(true);
    expect(asm.some((line) => /^setl \w+$/.test(line))).toBe(true);
    expect(asm.some((line) => /^movzx \w+, \w+$/.test(line))).toBe(true);
  });

  it("uses idiv, and puts the divisor somewhere idiv will not destroy", () => {
    const div = asmOf("int main() { int a; return a / 2; }");
    expect(div).toContain("cdq");
    // The divisor goes to a scratch register first: `cdq` overwrites edx and
    // `idiv` reads eax, so a divisor allocated to either would be gone.
    expect(div).toContain("idiv r10d");
    expect(div).toContain("mov eax, [rbp-4]");
    expect(div.indexOf("mov r10d, 2")).toBeLessThan(div.indexOf("cdq"));

    const mod = asmOf("int main() { int a; return a % 2; }");
    // The remainder comes out of edx instead, and is the only difference.
    expect(mod).toContain("idiv r10d");
    expect(mod).toContain("mov eax, edx");
  });

  it("stores a constant without borrowing a register", () => {
    const asm = asmOf("int main() { int x = 7; return x; }");
    expect(asm).toContain("mov dword ptr [rbp-4], 7");
  });

  it("ends every function with leave and ret", () => {
    const asm = asmOf("int main() { return 0; }");
    expect(asm.at(-2)).toBe("leave");
    expect(asm.at(-1)).toBe("ret");
  });

  it("keeps a chain of temporaries entirely in registers", () => {
    // Every temporary here dies as soon as the next one is computed, so they can
    // all share one register and the whole expression never touches memory. This
    // used to be twelve instructions with a store after every one of them.
    const asm = asmOf("int main() { return 1 + 2 * 3 + 4; }");
    const body = asm.slice(asm.indexOf("main:") + 1);
    expect(body.filter((line) => /\[rbp/.test(line))).toEqual([]);
    expect(body).toContain("imul eax, 3");
  });


  it("attributes every line to the IR instruction that caused it", () => {
    const result = compile("int main() { int x = 1; return x; }");
    const irIds = new Set(result.ir.instrs.map((instr) => instr.id));
    for (const line of result.codegen.lines) {
      if (line.kind === "directive") continue;
      expect(irIds.has(line.from ?? "")).toBe(true);
    }
  });
});

describe("pointers and arrays", () => {
  function compileOk(source: string) {
    const result = compile(source);
    expect(result.error, result.error?.message).toBeUndefined();
    return result;
  }

  function failure(source: string) {
    const result = compile(source);
    expect(result.error, "expected this to be rejected").toBeDefined();
    return result.error!;
  }

  function irOf(source: string): string[] {
    return compileOk(source).ir.instrs.map(formatInstr);
  }

  function inMain(source: string): string[] {
    const lines = irOf(source);
    return lines.slice(lines.findIndex((line) => line.startsWith("main:")) + 1);
  }

  function typeOfReturn(source: string): string {
    const result = compileOk(source);
    const main = result.parse.program.functions.at(-1);
    const returned = main?.body.stmts.at(-1);
    if (returned?.kind !== "Return" || !returned.value) throw new Error("no return");
    return typeName(result.semantics.types[returned.value.id]);
  }

  // ------------------------------------------------------------------- parsing

  it("parses a pointer declarator", () => {
    const result = compileOk("int main() { int x; int *p = &x; return *p; }");
    const decl = result.parse.program.functions[0].body.stmts[1];
    if (decl.kind !== "VarDecl") throw new Error("expected a declaration");
    expect(typeName(decl.type)).toBe("int*");
  });

  it("parses an array declarator with its length", () => {
    const result = compileOk("int main() { int a[10]; a[0] = 1; return a[0]; }");
    const decl = result.parse.program.functions[0].body.stmts[0];
    if (decl.kind !== "VarDecl") throw new Error("expected a declaration");
    expect(typeName(decl.type)).toBe("int[10]");
  });

  it("stacks stars for a pointer to a pointer", () => {
    expect(typeOfReturn("int main() { int x; int *p = &x; int **q = &p; return **q; }"))
      .toBe("int");
  });

  it("treats an array parameter as a pointer, because C does", () => {
    const result = compileOk(
      "int first(int a[]) { return a[0]; } int main() { int b[2]; b[0] = 3; return first(b); }",
    );
    expect(typeName(result.parse.program.functions[0].params[0].type)).toBe("int*");
  });

  it("assigns through a dereference and through an index", () => {
    const stmts = compileOk(
      "int main() { int a[2]; int *p = a; *p = 1; a[1] = 2; return a[0] + a[1]; }",
    ).parse.program.functions[0].body.stmts;
    const deref = stmts[2];
    const index = stmts[3];
    if (deref.kind !== "ExprStmt" || deref.expr.kind !== "Assign") throw new Error("no");
    if (index.kind !== "ExprStmt" || index.expr.kind !== "Assign") throw new Error("no");
    expect(deref.expr.target.kind).toBe("Deref");
    expect(index.expr.target.kind).toBe("Index");
  });

  it("refuses to assign to something that is not a place", () => {
    expect(failure("int main() { int x; x + 1 = 2; return x; }").message).toContain(
      "cannot be assigned to",
    );
  });

  // ------------------------------------------------------------------- typing

  it("types &x as a pointer to x's type", () => {
    expect(typeOfReturn("int main() { char c = 'a'; char *p = &c; return *p; }"))
      .toBe("char");
  });

  it("decays an array to a pointer when it is used as a value", () => {
    expect(typeOfReturn("int main() { int a[3]; a[0] = 1; int *p = a; return *p; }"))
      .toBe("int");
  });

  it("keeps pointer arithmetic pointer-typed", () => {
    expect(typeOfReturn("int main() { int a[3]; a[2] = 9; int *p = a; return *(p + 2); }"))
      .toBe("int");
  });

  it("rejects dereferencing something that is not a pointer", () => {
    expect(failure("int main() { int x = 1; return *x; }").message).toContain(
      "cannot dereference",
    );
  });

  it("rejects taking the address of a value that has no home", () => {
    expect(failure("int main() { return *&1; }").message).toContain(
      "no address to take",
    );
  });

  it("rejects mixing a pointer and an integer", () => {
    expect(
      failure("int main() { int x; int *p = &x; return p; }").message,
    ).toContain("cannot put");
  });

  it("rejects assigning to a whole array", () => {
    expect(
      failure("int main() { int a[2]; int b[2]; a = b; return 0; }").message,
    ).toContain("array cannot be assigned");
  });

  it("names what is out of subset instead of guessing", () => {
    expect(failure("int main() { int a[2]; int b[2]; return &a - &b; }").hint ?? "")
      .toBeTruthy();
    expect(failure("int main() { int (*f)[2]; return 0; }").message).toContain(
      "too clever",
    );
    expect(failure("int main() { int a[2][2]; return 0; }").message).toContain(
      "one dimension",
    );
  });

  // -------------------------------------------------------------------- sizes

  it("gives an array its whole size in the frame, not one slot", () => {
    const result = compileOk("int main() { int a[5]; a[0] = 1; return a[0]; }");
    const array = result.semantics.symbols.find((symbol) => symbol.name === "a");
    expect(array?.slot).toBe(-20);
    expect(result.semantics.frames.main).toBe(20);
  });

  it("packs a char into one byte and aligns a pointer to eight", () => {
    const result = compileOk(
      "int main() { char c = 'x'; int *p; p = 0; return c; }",
    );
    const slots = Object.fromEntries(
      result.semantics.symbols
        .filter((symbol) => symbol.role !== "function")
        .map((symbol) => [symbol.name, symbol.slot]),
    );
    expect(slots.c).toBe(-1);
    // The pointer cannot start at -9; it is rounded out to its own alignment.
    expect(slots.p).toBe(-16);
  });

  // ---------------------------------------------------------------- lowering

  it("lowers a[i] into a visible multiply and add", () => {
    const ir = inMain("int main() { int a[3]; int i = 1; return a[i]; }");
    expect(ir).toContain("t0 = &a");
    expect(ir.some((line) => /t\d = i \* 4/.test(line))).toBe(true);
    expect(ir.some((line) => /t\d = t\d \+ t\d/.test(line))).toBe(true);
    expect(ir.some((line) => /t\d = \*t\d/.test(line))).toBe(true);
  });

  it("scales pointer arithmetic by the element size, not by one", () => {
    const ints = inMain("int main() { int a[3]; int *p = a; return *(p + 1); }");
    expect(ints.some((line) => line.includes("* 4"))).toBe(true);

    const chars = inMain("int main() { char a[3]; char *p = a; return *(p + 1); }");
    expect(chars.some((line) => line.includes("* 4"))).toBe(false);
  });

  it("stores through a computed address rather than into a name", () => {
    const ir = inMain("int main() { int a[2]; a[0] = 7; return a[0]; }");
    expect(ir.some((line) => /^\*t\d = 7$/.test(line))).toBe(true);
  });

  it("passes an array by address, copying nothing", () => {
    const ir = inMain(
      "int first(int *p) { return *p; } int main() { int a[2]; a[0] = 1; return first(a); }",
    );
    expect(ir).toContain("t0 = &a");
    expect(ir.some((line) => /call first\(t\d\)/.test(line))).toBe(true);
  });

  // ---------------------------------------------------------------- assembly

  it("takes an address with lea, which reads nothing", () => {
    const asm = compileOk("int main() { int x = 1; int *p = &x; return *p; }")
      .codegen.lines.map((line) => line.text);
    expect(asm).toContain("lea rax, [rbp-4]");
  });

  it("moves addresses in 64-bit registers and ints in 32-bit ones", () => {
    const asm = compileOk("int main() { int x = 1; int *p = &x; return *p; }")
      .codegen.lines.map((line) => line.text);
    // `p` is a named local, so reading it is a load — and it is eight bytes wide,
    // so the register it lands in has to be a 64-bit one.
    const fetch = asm.find((line) => /^mov \w+, \[rbp-\d+\]$/.test(line)) ?? "";
    const register = /^mov (\w+),/.exec(fetch)?.[1] ?? "";
    const quads = new Set(
      [...ALLOCATABLE, SCRATCH_A, SCRATCH_B].map((reg) => regName(reg, 8)),
    );
    expect(quads.has(register), fetch).toBe(true);
    // Dereferencing it reads four bytes, because that is what it points at.
    expect(asm.some((line) => /^mov e\w+, \[\w+\]$/.test(line))).toBe(true);
  });

  it("sign-extends a char rather than reading four bytes from a one-byte slot", () => {
    const asm = compileOk("int main() { char c = 'a'; int n = c; return n; }")
      .codegen.lines.map((line) => line.text);
    expect(asm.some((line) => /^movsx \w+, byte ptr /.test(line))).toBe(true);
  });

  it("writes a char back one byte at a time", () => {
    const asm = compileOk("int main() { char a[2]; a[0] = 'x'; return a[0]; }")
      .codegen.lines.map((line) => line.text);
    expect(asm.some((line) => /^mov byte ptr \[rax\], \d+$/.test(line))).toBe(true);
  });
});

describe("the grammar shown on the page", () => {
  const PROGRAM = `#define TWO 2
int add(int *p, int n) {
  int total = 0;
  for (int i = 0; i < n; i = i + 1) {
    total = total + p[i];
    if (total > 100) { break; } else { continue; }
  }
  while (total) { total = total - TWO; }
  char c = 'x';
  return total + c;
}

int main() {
  int a[3];
  a[0] = 1;
  int *q = &a[0];
  return add(q, 3);
}`;

  const compiled = compile(PROGRAM);

  it("compiles the program that exercises every rule", () => {
    expect(compiled.error?.message).toBeUndefined();
  });

  it("names a rule on every scanning and parsing step", () => {
    for (const step of compiled.steps) {
      if (step.stage !== "scan" && step.stage !== "parse") continue;
      expect(step.rule, `${step.stage}: "${step.title}" names no rule`).toBeTruthy();
    }
  });

  it("never names a rule that is not in the grammar", () => {
    for (const step of compiled.steps) {
      const rules = RULES_BY_STAGE[step.stage];
      if (!rules || !step.rule) continue;
      expect(
        rules.map((rule) => rule.id),
        `${step.stage} step "${step.title}"`,
      ).toContain(step.rule);
    }
  });

  it("has no rule that the compiler never uses", () => {
    // Both directions matter: an unused rule is a rule that has drifted away
    // from the code, and it would be shown to a reader as if it were true.
    const used = new Set(compiled.steps.map((step) => step.rule));
    for (const [stage, rules] of Object.entries(RULES_BY_STAGE)) {
      for (const rule of rules) {
        expect(used.has(rule.id), `${stage}: ${rule.id} is never applied`).toBe(true);
      }
    }
  });

  it("writes every production without left recursion", () => {
    // A top-down parser cannot survive `expr ::= expr '+' term`, so a rule whose
    // right side starts with its own name is a grammar the code cannot implement.
    for (const rule of PARSE_RULES) {
      const [left, right] = rule.text.split("::=");
      const head = left.trim().replace(/\(.*\)/, "");
      expect(
        right.trim().startsWith(head),
        `${rule.id} is left-recursive: ${rule.text}`,
      ).toBe(false);
    }
  });

  it("explains the method, and what the alternative would cost", () => {
    expect(METHOD.parse).toContain("Recursive descent");
    expect(METHOD.parse).toContain("LR");
  });
});

describe("what each stage actually consumes", () => {
  const source = `int main() {
  int a[2];
  a[0] = 1 + 2;
  int *p = &a[0];
  return *p;
}`;
  const compiled = compile(source);

  it("consumes only what an earlier stage produced", () => {
    // The chain has to hang together, or the labels on the page are decoration.
    const producedSoFar = new Set<string>([SOURCE]);
    for (const stage of STAGES) {
      for (const input of STAGE_IO[stage].consumes) {
        expect(
          producedSoFar.has(input),
          `${stage} consumes "${input}", which nothing before it produces`,
        ).toBe(true);
      }
      producedSoFar.add(STAGE_IO[stage].produces);
    }
  });

  it("says lowering reads the tree, because it does", () => {
    // The claim on the page and the argument list of `lower()` have to agree.
    expect(STAGE_IO.ir.consumes).toContain("a syntax tree");
    expect(STAGE_IO.parse.produces).toBe("a syntax tree");
    expect(STAGE_IO.ir.consumes).toContain(STAGE_IO.semantics.produces);
  });

  it("never claims a later stage reads your source", () => {
    for (const stage of STAGES) {
      if (stage === "preprocess") continue;
      expect(STAGE_IO[stage].consumes, stage).not.toContain(SOURCE);
    }
  });

  it("derives every IR instruction from a node of the tree", () => {
    // The strongest available evidence that lowering walks the AST rather than
    // re-reading anything: every instruction's span is one it could only have
    // got from a tree node it visited.
    const spans = new Set<string>();
    const collect = (node: AstNode) => {
      spans.add(`${node.span.start}:${node.span.end}`);
      if (node.kind === "Function") {
        spans.add(`${node.nameSpan.start}:${node.nameSpan.end}`);
      }
      childrenOf(node).forEach(collect);
    };
    collect(compiled.parse.program);

    expect(compiled.ir.instrs.length).toBeGreaterThan(5);
    for (const instr of compiled.ir.instrs) {
      expect(
        spans.has(`${instr.span.start}:${instr.span.end}`),
        `${formatInstr(instr)} has a span no AST node has`,
      ).toBe(true);
    }
  });

  it("derives every assembly line from an IR instruction", () => {
    const irIds = new Set(compiled.ir.instrs.map((instr) => instr.id));
    for (const line of compiled.codegen.lines) {
      if (line.kind === "directive") continue;
      expect(irIds.has(line.from ?? ""), line.text).toBe(true);
    }
  });
});

describe("running the IR", () => {
  function run(source: string) {
    const result = compile(source);
    expect(result.error?.message).toBeUndefined();
    return result.run!;
  }

  it("returns what the program returns", () => {
    expect(run("int main() { return 6 * 7; }").value).toBe(42);
  });

  it("runs loops, calls and recursion", () => {
    expect(
      run(`int fact(int n) { if (n < 2) { return 1; } return n * fact(n - 1); }
int main() {
  int total = 0;
  for (int i = 1; i <= 5; i = i + 1) { total = total + fact(i); }
  return total;
}`).value,
    ).toBe(153);
  });

  it("reads and writes through pointers", () => {
    expect(
      run(`void swap(int *a, int *b) { int t = *a; *a = *b; *b = t; }
int main() { int x = 7; int y = 100; swap(&x, &y); return y - x; }`).value,
    ).toBe(-93);
  });

  it("indexes arrays at the right stride", () => {
    expect(
      run(`int main() {
  char s[3];
  s[0] = 1;
  s[1] = 2;
  s[2] = 3;
  return s[0] + s[1] + s[2];
}`).value,
    ).toBe(6);
  });

  it("lets a write run off the end of an array, exactly as C does", () => {
    // The point of the preset: nothing traps, nothing warns, the program keeps
    // going. If this ever started failing, the page would be teaching a lie.
    const result = run(`int main() {
  int a[3];
  a[0] = 1;
  a[5] = 99;
  return a[0];
}`);
    expect(result.error).toBeUndefined();
    expect(result.value).toBe(1);
  });

  it("stops a program that never would, and says so", () => {
    const result = run("int main() { while (1) { } return 0; }");
    expect(result.error?.message).toContain("does not stop");
    expect(result.executed).toBeGreaterThan(1000);
  });

  it("reports division by zero rather than returning nonsense", () => {
    const result = run("int main() { int n = 0; return 10 / n; }");
    expect(result.error?.message).toContain("divided by zero");
  });

  it("reports running out of stack", () => {
    const result = run("int down(int n) { return down(n + 1); } int main() { return down(0); }");
    expect(result.error?.message).toContain("stack");
  });

  it("traces one step per instruction executed", () => {
    const result = run("int main() { int x = 1; return x + 1; }");
    expect(result.steps.length).toBe(result.executed);
    for (const step of result.steps) expect(step.stage).toBe("run");
  });

  it("reveals the answer with the step that produced it, not before", () => {
    const result = run("int main() { return 3; }");
    const last = result.steps.at(-1);
    expect(last?.produced).toContain("run:result");
    expect(result.effects.at(-1)?.text).toBe("main returned 3");
  });

  it("runs on the same frame layout the assembly addresses", () => {
    // Both backends ask frames.ts, so an address in the run pane and an offset
    // in the assembly pane describe the same byte.
    const result = compile("int main() { int x = 5; int *p = &x; return *p; }");
    const lea = result.codegen.lines.find((line) => line.text.startsWith("lea rax,"));
    expect(lea?.text).toBe("lea rax, [rbp-4]");
    expect(result.run?.value).toBe(5);
  });
});
