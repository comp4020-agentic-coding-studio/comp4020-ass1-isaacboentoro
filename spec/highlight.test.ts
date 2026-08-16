import { describe, expect, it } from "vitest";
import { KEYWORDS } from "../src/compiler/lexer";
import { type Region, pieces, regionsOf } from "../src/ui/highlight";
import { PRESETS } from "../src/ui/presets";

/**
 * Syntax colouring is decoration in the sense that it adds no information the
 * page did not already have — which is exactly why it has to be provably
 * harmless. Two things must hold: it never changes a character of the source,
 * and it never claims something is a keyword that the scanner would treat as a
 * name. Everything below is one of those two.
 */

const kindsAt = (text: string, needle: string): string[] =>
  regionsOf(text)
    .filter((region) => text.slice(region.start, region.end) === needle)
    .map((region) => region.kind);

describe("the source highlighter", () => {
  it("returns regions in order, non-overlapping and inside the text", () => {
    for (const preset of PRESETS) {
      let last = 0;
      for (const region of regionsOf(preset.source)) {
        expect(region.start, preset.name).toBeGreaterThanOrEqual(last);
        expect(region.end).toBeGreaterThan(region.start);
        expect(region.end).toBeLessThanOrEqual(preset.source.length);
        last = region.end;
      }
    }
  });

  it("colours a word as reserved only if the scanner reserves it", () => {
    const text = "int width = height;";
    expect(kindsAt(text, "int")).toEqual(["keyword"]);
    expect(kindsAt(text, "width")).toEqual([]);
    expect(kindsAt(text, "height")).toEqual([]);
    // The set is the scanner's own, so the page cannot drift from the compiler.
    for (const word of KEYWORDS) {
      expect(kindsAt(`${word} x;`, word), word).toEqual(["keyword"]);
    }
  });

  it("knows the things the scanner never sees", () => {
    // Comments and directives are gone by the time the real scanner runs, which
    // is why this cannot be built on `scan()`.
    expect(kindsAt("x = 1; // note\n", "// note")).toEqual(["comment"]);
    expect(kindsAt("/* two\nlines */\nint x;", "/* two\nlines */")).toEqual(["comment"]);
    expect(kindsAt("#define N 4\n", "#define")).toEqual(["directive"]);
    expect(kindsAt("#include <stdio.h>\n", "<stdio.h>")).toEqual(["header"]);
    expect(kindsAt("int x = 42;", "42")).toEqual(["number"]);
    expect(kindsAt("char c = 'a';", "'a'")).toEqual(["char"]);
  });

  it("only reads a directive at the start of a line", () => {
    expect(kindsAt("int x = 1; #define N 2\n", "#define")).toEqual([]);
  });

  it("classifies half-written code instead of failing on it", () => {
    // The mirror repaints on every keystroke, so unterminated everything is the
    // normal case, not an edge one.
    for (const text of ["/* open", "'", '"unclosed\nint x;', "#", "#include", "1abc"]) {
      expect(() => regionsOf(text), text).not.toThrow();
      for (const region of regionsOf(text)) {
        expect(region.end, text).toBeLessThanOrEqual(text.length);
      }
    }
    // A stray quote is a typo on one line, not a swallowed rest-of-file.
    const stray = "char c = ';\nint x;";
    const swallowed = regionsOf(stray).filter((r) => r.kind === "char");
    for (const region of swallowed) {
      expect(stray.slice(region.start, region.end)).not.toContain("\n");
    }
  });
});

describe("cutting the source into pieces", () => {
  const cover = (text: string, marking: { start: number; end: number } | null) => {
    const cut = pieces(text.length, regionsOf(text), marking);
    return cut.map((piece) => text.slice(piece.start, piece.end)).join("");
  };

  it("never loses or duplicates a character, marked or not", () => {
    for (const preset of PRESETS) {
      expect(cover(preset.source, null), preset.name).toBe(preset.source);
      for (const at of [0, 7, 30, preset.source.length - 1]) {
        const marking = { start: Math.max(0, at), end: Math.max(0, at) + 5 };
        expect(cover(preset.source, marking), preset.name).toBe(preset.source);
      }
    }
    expect(cover("", null)).toBe("");
  });

  it("splits a token that straddles the edge of the highlight", () => {
    // Without the split the mark would have to swallow a whole token or none of
    // it, and the span a step reports is not required to land on token edges.
    const text = "int x;";
    const cut = pieces(text.length, regionsOf(text), { start: 1, end: 4 });
    const keyword = cut.filter((piece) => piece.kind === "keyword");
    expect(keyword.length).toBe(2);
    expect(keyword.map((piece) => text.slice(piece.start, piece.end))).toEqual(["i", "nt"]);
  });

  it("gives every piece exactly the kind of the region covering it", () => {
    const text = "#define N 4\nint main() { return N; }\n";
    const regions: Region[] = regionsOf(text);
    for (const piece of pieces(text.length, regions, { start: 12, end: 20 })) {
      const covering = regions.find(
        (region) => region.start <= piece.start && region.end >= piece.end,
      );
      expect(piece.kind).toBe(covering?.kind);
    }
  });
});
