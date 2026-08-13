import { toOriginalSpan } from "./preprocess";
import { StepLog } from "./steps";
import type { Diagnostic, ScanResult, Token, TokenKind } from "./types";

/**
 * The scanner. Reads the preprocessed text left to right and never backs up
 * further than one character, which is the whole reason C is cheap to lex.
 * Every token carries a span in the ORIGINAL source, resolved through the
 * preprocessor's map, so highlighting a token highlights what the user typed.
 */

export const KEYWORDS = new Set([
  "int",
  "char",
  "void",
  "return",
  "if",
  "else",
  "while",
  "for",
  "break",
  "continue",
]);

/** Longest first: `<=` must be tried before `<`. */
const PUNCTUATION = [
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "+",
  "-",
  "*",
  "/",
  "%",
  "<",
  ">",
  "=",
  "!",
  "&",
  "[",
  "]",
  "(",
  ")",
  "{",
  "}",
  ";",
  ",",
];

const ESCAPES: Record<string, number> = {
  n: 10,
  t: 9,
  r: 13,
  "0": 0,
  "\\": 92,
  "'": 39,
};

const EXPLAIN: Record<TokenKind, string> = {
  keyword: "A reserved word. The parser can branch on it without looking anything up.",
  identifier: "A name. The scanner does not know or care what it refers to yet.",
  number: "Digits become one integer literal — a value, not text, from here on.",
  char: "A character literal is just a small integer with quotes around it.",
  punct: "Punctuation carries the structure. Two-character operators are matched before one.",
  eof: "End of input. The parser needs this to know a program finished rather than stopped.",
};

export function scan(text: string, map: number[]): ScanResult {
  const log = new StepLog("scan");
  const tokens: Token[] = [];
  let error: Diagnostic | undefined;
  let i = 0;

  const push = (kind: TokenKind, start: number, end: number, value?: number) => {
    const token: Token = {
      id: `tok:${tokens.length}`,
      kind,
      text: text.slice(start, end),
      span: toOriginalSpan(map, start, end),
      ...(value === undefined ? {} : { value }),
    };
    tokens.push(token);
    log.add(
      `${kind}: ${token.text}`,
      EXPLAIN[kind],
      token.span,
      [token.id],
    );
    return token;
  };

  while (i < text.length) {
    const ch = text[i];

    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }

    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < text.length && /[0-9]/.test(text[j])) j += 1;
      if (j < text.length && /[A-Za-z_]/.test(text[j])) {
        error = {
          stage: "scan",
          message: `\`${text.slice(i, j + 1)}\` is not a number`,
          span: toOriginalSpan(map, i, j + 1),
          hint: "A digit cannot be followed straight by a letter.",
        };
        break;
      }
      push("number", i, j, Number(text.slice(i, j)));
      i = j;
      continue;
    }

    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < text.length && /[A-Za-z0-9_]/.test(text[j])) j += 1;
      const word = text.slice(i, j);
      push(KEYWORDS.has(word) ? "keyword" : "identifier", i, j);
      i = j;
      continue;
    }

    if (ch === "'") {
      const parsed = readCharLiteral(text, i);
      if (!parsed) {
        error = {
          stage: "scan",
          message: "unterminated character literal",
          span: toOriginalSpan(map, i, Math.min(i + 2, text.length)),
          hint: "Character literals hold exactly one character, like 'a' or '\\n'.",
        };
        break;
      }
      push("char", i, parsed.end, parsed.value);
      i = parsed.end;
      continue;
    }

    const punct = PUNCTUATION.find((candidate) => text.startsWith(candidate, i));
    if (punct) {
      push("punct", i, i + punct.length);
      i += punct.length;
      continue;
    }

    error = {
      stage: "scan",
      message: `stray \`${ch}\` in the input`,
      span: toOriginalSpan(map, i, i + 1),
      hint: "This subset has no strings, structs, floats or bitwise operators.",
    };
    break;
  }

  if (!error) push("eof", text.length, text.length);

  return { tokens, steps: log.all(), error };
}

function readCharLiteral(
  text: string,
  at: number,
): { end: number; value: number } | null {
  if (text[at + 1] === "\\") {
    const escape = text[at + 2];
    if (escape === undefined || text[at + 3] !== "'") return null;
    const value = ESCAPES[escape];
    if (value === undefined) return null;
    return { end: at + 4, value };
  }
  const ch = text[at + 1];
  if (ch === undefined || ch === "'" || text[at + 2] !== "'") return null;
  return { end: at + 3, value: ch.charCodeAt(0) };
}
