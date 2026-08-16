import { KEYWORDS } from "../compiler/lexer";

/**
 * A syntax highlighter for the ORIGINAL source text — the thing the visitor
 * typed, comments and directives and all — not the preprocessed text the
 * scanner reads. That is the whole reason it cannot just be `scan()`: by the
 * time the real scanner runs, the comments are gone and the macros have already
 * been substituted, so a highlighter built on it could not colour either.
 *
 * It classifies, it never fails: unterminated comments and stray characters are
 * regions like anything else, because the source is highlighted while it is
 * still being typed and half-written code is the normal case.
 *
 * Keywords come from the scanner's own set, so the page can never colour a word
 * as reserved that the compiler would treat as a name.
 */

export type SyntaxKind =
  | "comment"
  | "directive"
  | "header"
  | "keyword"
  | "number"
  | "char"
  | "punct";

export type Region = { start: number; end: number; kind: SyntaxKind };

const PUNCT = new Set("+-*/%<>=!&|[](){};,".split(""));

/**
 * Regions in source order, non-overlapping, gaps meaning "nothing to say".
 * Identifiers are a gap on purpose: a name is the ordinary case, so it wears the
 * surrounding text colour and the marked-up kinds stand out against it.
 */
export function regionsOf(text: string): Region[] {
  const regions: Region[] = [];
  const push = (start: number, end: number, kind: SyntaxKind) => {
    if (end > start) regions.push({ start, end, kind });
  };

  let i = 0;
  let lineStart = true;

  while (i < text.length) {
    const ch = text[i];

    if (ch === "\n") {
      lineStart = true;
      i += 1;
      continue;
    }

    if (ch === " " || ch === "\t" || ch === "\r") {
      i += 1;
      continue;
    }

    if (ch === "/" && text[i + 1] === "/") {
      const end = endOfLine(text, i);
      push(i, end, "comment");
      i = end;
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      const closed = text.indexOf("*/", i + 2);
      const end = closed === -1 ? text.length : closed + 2;
      push(i, end, "comment");
      i = end;
      lineStart = false;
      continue;
    }

    // A directive owns its `#name` only; the rest of the line is code, so a
    // macro body is coloured the same way as the code it will be pasted into.
    if (ch === "#" && lineStart) {
      let j = i + 1;
      while (j < text.length && /[A-Za-z_]/.test(text[j])) j += 1;
      push(i, j, "directive");
      const name = text.slice(i + 1, j);
      i = j;
      if (name === "include") {
        const rest = readHeader(text, i);
        if (rest) {
          push(rest.start, rest.end, "header");
          i = rest.end;
        }
      }
      lineStart = false;
      continue;
    }

    lineStart = false;

    if (/[0-9]/.test(ch)) {
      let j = i;
      // Trailing letters are the scanner's error to report, not ours to hide.
      while (j < text.length && /[0-9A-Za-z_]/.test(text[j])) j += 1;
      push(i, j, "number");
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j += 1;
      if (KEYWORDS.has(text.slice(i, j))) push(i, j, "keyword");
      i = j;
      continue;
    }

    if (ch === "'" || ch === '"') {
      const end = endOfLiteral(text, i, ch);
      push(i, end, "char");
      i = end;
      continue;
    }

    if (PUNCT.has(ch)) {
      push(i, i + 1, "punct");
      i += 1;
      continue;
    }

    i += 1;
  }

  return regions;
}

function endOfLine(text: string, at: number): number {
  const nl = text.indexOf("\n", at);
  return nl === -1 ? text.length : nl;
}

/** `<stdio.h>` or `"local.h"` after an `#include`, whitespace skipped. */
function readHeader(text: string, at: number): { start: number; end: number } | null {
  let i = at;
  while (i < text.length && (text[i] === " " || text[i] === "\t")) i += 1;
  const open = text[i];
  const close = open === "<" ? ">" : open === '"' ? '"' : null;
  if (!close) return null;
  const found = text.indexOf(close, i + 1);
  const line = endOfLine(text, i);
  if (found === -1 || found > line) return { start: i, end: line };
  return { start: i, end: found + 1 };
}

/** Never runs past the line: an unclosed quote is a typo, not a swallowed file. */
function endOfLiteral(text: string, at: number, quote: string): number {
  const line = endOfLine(text, at);
  let i = at + 1;
  while (i < line) {
    if (text[i] === "\\") {
      i += 2;
      continue;
    }
    if (text[i] === quote) return i + 1;
    i += 1;
  }
  return line;
}

type Piece = { start: number; end: number; kind?: SyntaxKind };

/**
 * Cut the source into runs that are uniform in both things that colour it: the
 * syntax kind, and whether the marked span covers it. Splitting on both at once
 * is what lets a highlighted token straddle the edge of the mark without either
 * one having to know about the other.
 */
export function pieces(
  length: number,
  regions: Region[],
  marking: { start: number; end: number } | null,
): Piece[] {
  const cuts = new Set<number>([0, length]);
  for (const region of regions) {
    cuts.add(region.start);
    cuts.add(region.end);
  }
  if (marking) {
    cuts.add(marking.start);
    cuts.add(marking.end);
  }

  const bounds = [...cuts]
    .filter((at) => at >= 0 && at <= length)
    .sort((a, b) => a - b);

  const out: Piece[] = [];
  let next = 0;
  for (let i = 0; i + 1 < bounds.length; i += 1) {
    const start = bounds[i];
    const end = bounds[i + 1];
    while (next < regions.length && regions[next].end <= start) next += 1;
    const region = regions[next];
    const inside = region !== undefined && region.start <= start && region.end >= end;
    out.push(inside ? { start, end, kind: region.kind } : { start, end });
  }
  return out;
}

