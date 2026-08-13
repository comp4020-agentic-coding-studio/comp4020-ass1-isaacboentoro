import { formatAsm } from "../compiler/codegen";
import { formatInstr } from "../compiler/ir";
import type { AstNode, Compilation, StageId } from "../compiler/types";
import { STAGES, childrenOf, labelOf } from "../compiler/types";
import { type StageTrace, tracesOf } from "./reveal";

/**
 * Builds the six stage views for one compilation, and nothing else. Nothing in
 * here knows about the cursor: every artefact element is stamped with the step
 * that produced it, and the scrubber decides what is visible by toggling classes.
 * Building once per compile and toggling per step is what keeps dragging smooth.
 */

export type Reveal = { el: HTMLElement; step: number };

export type BuiltPanes = {
  /** Reveal lists are per stage, because each stage has its own player. */
  reveals: Record<StageId, Reveal[]>;
  traces: Record<StageId, StageTrace>;
  /** The element that holds the current-step marker, per stage. */
  bodies: Record<StageId, HTMLElement>;
};

/** Never use innerHTML here: the source text is the visitor's own input. */
function el(
  tag: string,
  className?: string,
  text?: string,
): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function buildPanes(
  compilation: Compilation,
  panes: Record<StageId, HTMLElement>,
): BuiltPanes {
  const traces = tracesOf(compilation);
  const reveals = {} as Record<StageId, Reveal[]>;
  const bodies = {} as Record<StageId, HTMLElement>;

  for (const stage of STAGES) {
    const stageReveals: Reveal[] = [];
    reveals[stage] = stageReveals;
    const at = traces[stage].producedAt;

    /** Stamp an element with the local step that brings it into existence. */
    const reveal = (node: HTMLElement, id: string): HTMLElement => {
      const step = at.get(id);
      if (step !== undefined) {
        node.dataset.reveal = String(step);
        stageReveals.push({ el: node, step });
      }
      return node;
    };

    const pane = panes[stage];
    pane.replaceChildren();
    const body = el("div", "pane-body");
    bodies[stage] = body;
    pane.append(body);

    const reachedIt =
      compilation.reached.includes(stage) || compilation.error?.stage === stage;
    if (!reachedIt) {
      const stopped = compilation.error?.stage ?? "an earlier stage";
      body.append(
        el(
          "p",
          "pane-note",
          `Never reached. The compiler stopped in ${stageName(stopped)}, so this stage never ran — which is exactly what happens with a real compiler.`,
        ),
      );
      continue;
    }

    if (compilation.error?.stage === stage) {
      body.append(diagnostic(compilation));
    }

    switch (stage) {
      case "preprocess":
        buildPreprocess(compilation, body, reveal);
        break;
      case "scan":
        buildScan(compilation, body, reveal);
        break;
      case "parse":
        buildParse(compilation, body, reveal);
        break;
      case "semantics":
        buildSemantics(compilation, body, reveal);
        break;
      case "ir":
        buildIr(compilation, body, reveal);
        break;
      case "codegen":
        buildCodegen(compilation, body, reveal);
        break;
    }
  }

  return { reveals, traces, bodies };
}

function stageName(stage: StageId | string): string {
  switch (stage) {
    case "preprocess":
      return "the preprocessor";
    case "scan":
      return "the scanner";
    case "parse":
      return "the parser";
    case "semantics":
      return "the analyser";
    case "ir":
      return "lowering";
    case "codegen":
      return "code generation";
    default:
      return "an earlier stage";
  }
}

function diagnostic(compilation: Compilation): HTMLElement {
  const error = compilation.error;
  const box = el("div", "diagnostic");
  box.setAttribute("role", "status");
  if (!error) return box;

  const line = lineAndColumn(compilation.source, error.span.start);
  box.append(el("p", "diagnostic-message", `${error.message}`));
  box.append(
    el("p", "diagnostic-where", `line ${line.line}, column ${line.column}`),
  );
  if (error.hint) box.append(el("p", "diagnostic-hint", error.hint));
  return box;
}

function lineAndColumn(source: string, offset: number) {
  const before = source.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

// -------------------------------------------------------------------- panes

type Reveals = (node: HTMLElement, id: string) => HTMLElement;

function buildPreprocess(
  compilation: Compilation,
  body: HTMLElement,
  reveal: Reveals,
): void {
  const { expansions, text } = compilation.preprocess;

  if (expansions.length === 0) {
    body.append(
      el(
        "p",
        "pane-note",
        "Nothing to do. No comments, no directives, no macros — the text reaches the scanner exactly as you typed it.",
      ),
    );
  } else {
    const list = el("ul", "edits");
    for (const expansion of expansions) {
      const item = el("li", `edit edit-${expansion.kind}`);
      item.append(el("span", "edit-kind", expansion.kind));
      item.append(el("span", "edit-note", expansion.note));
      list.append(reveal(item, expansion.id));
    }
    body.append(list);
  }

  const output = el("pre", "listing listing-text");
  output.append(el("code", undefined, text));
  body.append(el("h3", "pane-subhead", "What the scanner will read"));
  body.append(output);
}

function buildScan(
  compilation: Compilation,
  body: HTMLElement,
  reveal: Reveals,
): void {
  const strip = el("div", "tokens");
  for (const token of compilation.scan.tokens) {
    const chip = el("span", `token token-${token.kind}`);
    chip.append(el("span", "token-text", token.kind === "eof" ? "EOF" : token.text));
    chip.append(el("span", "token-kind", token.kind));
    strip.append(reveal(chip, token.id));
  }
  body.append(strip);
}

function buildParse(
  compilation: Compilation,
  body: HTMLElement,
  reveal: Reveals,
): void {
  const { program } = compilation.parse;
  if (program.functions.length === 0) {
    body.append(el("p", "pane-note", "No tree yet."));
    return;
  }

  // The label is what gets revealed, not the list item — an expression's parent
  // is built after its children, and hiding the item would hide them too.
  const buildNode = (node: AstNode): HTMLElement => {
    const item = el("li", "tree-node");
    const label = el("span", `tree-label tree-${node.kind}`, labelOf(node));
    label.append(el("span", "tree-kind", node.kind));
    item.append(reveal(label, node.id));

    const children = childrenOf(node);
    if (children.length > 0) {
      const list = el("ul", "tree-children");
      for (const child of children) list.append(buildNode(child));
      item.append(list);
    }
    return item;
  };

  const root = el("ul", "tree");
  root.append(buildNode(program));
  body.append(root);
}

function buildSemantics(
  compilation: Compilation,
  body: HTMLElement,
  reveal: Reveals,
): void {
  const { symbols } = compilation.semantics;
  if (symbols.length === 0) {
    body.append(el("p", "pane-note", "No names to record."));
    return;
  }

  const table = el("table", "symbols");
  const head = el("thead");
  const headRow = el("tr");
  for (const heading of ["name", "type", "kind", "scope", "slot"]) {
    headRow.append(el("th", undefined, heading));
  }
  head.append(headRow);
  table.append(head);

  const tbody = el("tbody");
  for (const symbol of symbols) {
    const row = el("tr", "symbol");
    row.append(el("td", "symbol-name", symbol.name));
    row.append(el("td", undefined, symbol.type));
    row.append(el("td", undefined, symbol.role));
    row.append(
      el(
        "td",
        undefined,
        symbol.role === "function" ? "global" : `${symbol.owner ?? "?"} · depth ${symbol.depth}`,
      ),
    );
    row.append(
      el("td", "symbol-slot", symbol.slot === undefined ? "—" : `rbp${symbol.slot}`),
    );
    tbody.append(reveal(row, symbol.id));
  }
  table.append(tbody);
  body.append(table);
}

function buildIr(
  compilation: Compilation,
  body: HTMLElement,
  reveal: Reveals,
): void {
  const listing = el("ol", "listing listing-ir");
  for (const instr of compilation.ir.instrs) {
    const line = el(
      "li",
      instr.op === "label" || instr.op === "enter" ? "ir-line ir-label" : "ir-line",
      formatInstr(instr),
    );
    listing.append(reveal(line, instr.id));
  }
  body.append(listing);
}

function buildCodegen(
  compilation: Compilation,
  body: HTMLElement,
  reveal: Reveals,
): void {
  const listing = el("ol", "listing listing-asm");
  for (const line of compilation.codegen.lines) {
    const item = el("li", `asm-line asm-${line.kind}`);
    item.append(el("span", "asm-text", formatAsm(line)));
    if (line.comment) item.append(el("span", "asm-comment", `; ${line.comment}`));
    listing.append(reveal(item, line.id));
  }
  body.append(listing);

  body.append(
    el(
      "p",
      "pane-note",
      "Assembly text, not machine code. Turning this into bytes is the assembler's job, and stitching object files together is the linker's — two more stages that do not run on this page.",
    ),
  );
}
