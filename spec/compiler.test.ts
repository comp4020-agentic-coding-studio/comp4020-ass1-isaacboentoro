import { describe, expect, it } from "vitest";
import { scan } from "../src/compiler/lexer";
import { preprocess } from "../src/compiler/preprocess";
import type { Span } from "../src/compiler/types";

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

  it("substitutes a function-like macro and parenthesises arguments", () => {
    const result = preprocess("#define TWICE(x) ((x)+(x))\nint y = TWICE(1+2);");
    expect(result.text).toContain("((1+2))+((1+2))");
  });

  it("attributes expanded text to the call site, not the macro body", () => {
    const source = "#define N 40\nint x = N;";
    const result = preprocess(source);
    const fourAt = result.text.indexOf("40");
    expect(source.slice(result.map[fourAt], result.map[fourAt] + 1)).toBe("N");
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
