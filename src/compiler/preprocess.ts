import { StepLog } from "./steps";
import type { Diagnostic, Expansion, PreprocessResult, Span } from "./types";

/**
 * A deliberately small preprocessor: comments out, `#define` in, `#include`
 * noted and dropped. It runs before the scanner and is the reason the rest of
 * the pipeline can trust its spans — every character it emits carries the
 * original offset it came from in `map`, including characters that came from a
 * macro body, which map back to the macro's call site.
 */

type Macro = {
  name: string;
  params?: string[];
  body: string;
  span: Span;
};

const IDENT_START = /[A-Za-z_]/;
const IDENT_PART = /[A-Za-z0-9_]/;

/** Characters that may precede an identifier without it being a use. */
function isIdentPart(ch: string | undefined): boolean {
  return ch !== undefined && IDENT_PART.test(ch);
}

export function preprocess(source: string): PreprocessResult {
  const log = new StepLog("preprocess");
  const expansions: Expansion[] = [];
  const macros = new Map<string, Macro>();

  let text = "";
  const map: number[] = [];
  let error: Diagnostic | undefined;

  /** Copy original characters through, preserving their offsets. */
  const emitOriginal = (from: number, to: number) => {
    for (let i = from; i < to; i += 1) {
      text += source[i];
      map.push(i);
    }
  };

  /** Emit generated characters, all attributed to `at` in the original. */
  const emitGenerated = (generated: string, at: number) => {
    for (const ch of generated) {
      text += ch;
      map.push(at);
    }
  };

  let i = 0;
  let copyFrom = 0;

  /** Flush untouched source up to `to`, then continue from `next`. */
  const flushTo = (to: number, next: number) => {
    emitOriginal(copyFrom, to);
    copyFrom = next;
  };

  while (i < source.length && !error) {
    const ch = source[i];
    const next = source[i + 1];

    // A line comment runs to the newline; a block comment to its terminator.
    if (ch === "/" && (next === "/" || next === "*")) {
      const isLine = next === "/";
      const end = isLine
        ? indexOrEnd(source, "\n", i)
        : indexOrEnd(source, "*/", i + 2, 2);
      const span = { start: i, end };
      flushTo(i, end);
      // Comments become a single space so `a/*x*/b` stays two tokens.
      emitGenerated(" ", i);
      const id = `pp:${expansions.length}`;
      expansions.push({
        id,
        kind: "comment",
        span,
        replacement: " ",
        note: "comment removed",
      });
      log.add(
        "strip a comment",
        "Comments never reach the compiler proper — the preprocessor deletes them first.",
        span,
        [id],
      );
      i = end;
      continue;
    }

    // Directives are only directives at the start of a line.
    if (ch === "#" && atLineStart(source, i)) {
      const end = indexOrEnd(source, "\n", i);
      const line = source.slice(i, end);
      const span = { start: i, end };
      flushTo(i, end);
      const id = `pp:${expansions.length}`;

      if (line.startsWith("#define")) {
        const macro = parseDefine(line, span);
        if (!macro) {
          error = {
            stage: "preprocess",
            message: "malformed #define",
            span,
            hint: "Write `#define NAME value` or `#define NAME(a) body`.",
          };
          break;
        }
        macros.set(macro.name, macro);
        expansions.push({
          id,
          kind: "define",
          span,
          replacement: "",
          note: `${macro.name} defined as \`${macro.body}\``,
        });
        log.add(
          `record #define ${macro.name}`,
          `The directive itself disappears. From here on, ${macro.name} is text the preprocessor will substitute.`,
          span,
          [id],
        );
      } else if (line.startsWith("#include")) {
        expansions.push({
          id,
          kind: "unsupported",
          span,
          replacement: "",
          note: "#include dropped — there is no linker on this page",
        });
        log.add(
          "drop an #include",
          "A real preprocessor pastes the whole header in here. This page has no headers and no linker, so the line is dropped.",
          span,
          [id],
        );
      } else {
        error = {
          stage: "preprocess",
          message: `unsupported directive: ${line.split(/\s/)[0]}`,
          span,
          hint: "This explainer handles #define and #include only.",
        };
        break;
      }
      i = end;
      continue;
    }

    // A macro use: an identifier that matches a name we recorded.
    if (IDENT_START.test(ch) && !isIdentPart(source[i - 1])) {
      let j = i;
      while (j < source.length && IDENT_PART.test(source[j])) j += 1;
      const name = source.slice(i, j);
      const macro = macros.get(name);

      if (macro) {
        const call = macro.params
          ? readArguments(source, j)
          : { end: j, args: [] as string[] };

        if (call) {
          const span = { start: i, end: call.end };
          const body = macro.params
            ? substitute(macro, call.args)
            : macro.body;
          flushTo(i, call.end);
          emitGenerated(body, i);
          const id = `pp:${expansions.length}`;
          expansions.push({
            id,
            kind: "expansion",
            span,
            replacement: body,
            note: `${name} expanded to \`${body}\``,
          });
          log.add(
            `expand ${name}`,
            "Macro expansion is text substitution, not a function call — the compiler never sees the name.",
            span,
            [id],
          );
          i = call.end;
          continue;
        }
      }
      i = j;
      continue;
    }

    i += 1;
  }

  if (!error) emitOriginal(copyFrom, source.length);

  if (expansions.length === 0) {
    log.add(
      "nothing to do",
      "No comments, no directives, no macros — the preprocessor hands the text through untouched.",
      { start: 0, end: source.length },
      [],
    );
  } else {
    log.add(
      "hand the text on",
      `The scanner will read ${text.length} characters, not the ${source.length} you typed.`,
      { start: 0, end: source.length },
      [],
    );
  }

  return { text, map, expansions, steps: log.all(), error };
}

function atLineStart(source: string, at: number): boolean {
  for (let i = at - 1; i >= 0; i -= 1) {
    const ch = source[i];
    if (ch === "\n") return true;
    if (ch !== " " && ch !== "\t") return false;
  }
  return true;
}

function indexOrEnd(
  source: string,
  needle: string,
  from: number,
  extra = 0,
): number {
  const at = source.indexOf(needle, from);
  return at === -1 ? source.length : at + extra;
}

function parseDefine(line: string, span: Span): Macro | null {
  const rest = line.slice("#define".length);
  if (!rest.startsWith(" ") && !rest.startsWith("\t")) return null;

  const match = /^\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(rest);
  if (!match) return null;

  const name = match[1];
  let after = rest.slice(match[0].length);

  if (after.startsWith("(")) {
    const close = after.indexOf(")");
    if (close === -1) return null;
    const params = after
      .slice(1, close)
      .split(",")
      .map((param) => param.trim())
      .filter((param) => param.length > 0);
    after = after.slice(close + 1);
    return { name, params, body: after.trim(), span };
  }

  return { name, body: after.trim(), span };
}

/** Read `(a, b)` starting at `from`; null when the call isn't there. */
function readArguments(
  source: string,
  from: number,
): { end: number; args: string[] } | null {
  let i = from;
  while (i < source.length && /\s/.test(source[i])) i += 1;
  if (source[i] !== "(") return null;

  const args: string[] = [];
  let depth = 0;
  let current = "";
  for (; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") {
      depth += 1;
      if (depth === 1) continue;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        args.push(current.trim());
        return { end: i + 1, args: args.filter((arg) => arg.length > 0) };
      }
    } else if (ch === "," && depth === 1) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += ch;
  }
  return null;
}

function substitute(macro: Macro, args: string[]): string {
  const params = macro.params ?? [];
  let body = macro.body;
  params.forEach((param, index) => {
    const argument = args[index] ?? "";
    body = body.replace(
      new RegExp(`\\b${escapeRegExp(param)}\\b`, "g"),
      `(${argument})`,
    );
  });
  return body;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Map a span in preprocessed text back to the original source. */
export function toOriginalSpan(
  map: number[],
  start: number,
  end: number,
): Span {
  const first = map[start] ?? map.at(-1) ?? 0;
  const last = end > start ? (map[end - 1] ?? first) : first;
  return { start: first, end: Math.max(first, last + 1) };
}
