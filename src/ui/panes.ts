import { formatAsm } from "../compiler/codegen";
import { formatInstr } from "../compiler/ir";
import type { AstNode, Compilation, StageId } from "../compiler/types";
import { typeName } from "../compiler/ctypes";
import { METHOD, RULES_BY_STAGE } from "../compiler/grammar";
import { PLAYERS, childrenOf, labelOf } from "../compiler/types";
import { type StageTrace, tracesOf } from "./reveal";

/**
 * Builds the six stage views for one compilation, and nothing else. Nothing in
 * here knows about the cursor: every artefact element is stamped with the step
 * that produced it, and the scrubber decides what is visible by toggling classes.
 * Building once per compile and toggling per step is what keeps dragging smooth.
 */

export type Reveal = { el: HTMLElement | SVGElement; step: number };

export type BuiltPanes = {
  /** Reveal lists are per stage, because each stage has its own player. */
  reveals: Record<StageId, Reveal[]>;
  traces: Record<StageId, StageTrace>;
  /** The element that holds the current-step marker, per stage. */
  bodies: Record<StageId, HTMLElement>;
};

/** SVG needs its own namespace, or the browser builds inert HTML elements. */
function svgEl(
  tag: string,
  className?: string,
  attributes: Record<string, string | number> = {},
): SVGElement {
  const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
  if (className) node.setAttribute("class", className);
  for (const [name, value] of Object.entries(attributes)) {
    node.setAttribute(name, String(value));
  }
  return node;
}

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

/**
 * The grammar a stage follows, listed beside the source it is reading.
 *
 * These are not artefacts: they exist before the stage runs and they do not
 * accumulate, so they are never hidden. What moves is the marker saying which
 * rule the current step applied.
 */
export function buildRules(stage: StageId, container: HTMLElement): void {
  container.replaceChildren();
  const rules = RULES_BY_STAGE[stage];
  if (!rules) return;

  container.append(
    el("p", "field-label", stage === "scan" ? "The rules it matches" : "The grammar it follows"),
  );

  const list = el("ol", "rule-list");
  list.tabIndex = 0;
  list.setAttribute(
    "aria-label",
    stage === "scan" ? "Lexical rules" : "Grammar productions",
  );
  for (const rule of rules) {
    const item = el("li", "rule");
    item.dataset.rule = rule.id;
    item.append(el("code", "rule-text", rule.text));
    item.append(el("span", "rule-note", rule.note));
    list.append(item);
  }
  container.append(list);
  container.append(el("p", "pane-note", METHOD[stage] ?? ""));
}

export function buildPanes(
  compilation: Compilation,
  panes: Record<StageId, HTMLElement>,
): BuiltPanes {
  const traces = tracesOf(compilation);
  const reveals = {} as Record<StageId, Reveal[]>;
  const bodies = {} as Record<StageId, HTMLElement>;

  for (const stage of PLAYERS) {
    const stageReveals: Reveal[] = [];
    reveals[stage] = stageReveals;
    const at = traces[stage].producedAt;

    /** Stamp an element with the local step that brings it into existence. */
    const reveal = <T extends HTMLElement | SVGElement>(node: T, id: string): T => {
      const step = at.get(id);
      if (step !== undefined) {
        node.dataset.reveal = String(step);
        stageReveals.push({ el: node, step });
      }
      return node;
    };

    /**
     * Structure that should not exist yet at all. `reveal` reserves an
     * artefact's space so lists do not jump; `grow` collapses a container until
     * something inside it has been produced, which is what lets the tree grow
     * rather than fill in a skeleton that was there from the start.
     */
    const grow = (node: HTMLElement, step: number): HTMLElement => {
      node.dataset.grow = String(step);
      stageReveals.push({ el: node, step });
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
        buildParse(compilation, body, reveal, grow, (id) => at.get(id));
        break;
      case "semantics":
        buildSemantics(compilation, body, reveal);
        break;
      case "ir":
        buildIr(compilation, body, reveal);
        break;
      case "regalloc":
        buildRegalloc(compilation, body, reveal);
        break;
      case "codegen":
        buildCodegen(compilation, body, reveal);
        break;
      case "run":
        buildRun(compilation, body, reveal);
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
    case "regalloc":
      return "register allocation";
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

type Reveals = <T extends HTMLElement | SVGElement>(node: T, id: string) => T;

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
  grow: (node: HTMLElement, step: number) => HTMLElement,
  stepOf: (id: string) => number | undefined,
): void {
  const { program } = compilation.parse;
  if (program.functions.length === 0) {
    body.append(el("p", "pane-note", "No tree yet."));
    return;
  }

  /**
   * The tree grows rather than filling in. A node's label is revealed at the step
   * that built it, and every container collapses until the earliest step anywhere
   * inside it — so a branch appears when its first leaf does and the indentation
   * arrives with the nodes instead of waiting for them.
   *
   * Expressions are built bottom-up, so a parent's label lands after its children:
   * the item has to be on screen before its own label is.
   */
  const buildNode = (node: AstNode): { el: HTMLElement; from: number } => {
    const item = el("li", "tree-node");
    const label = el("span", `tree-label tree-${node.kind}`, labelOf(node));
    label.append(el("span", "tree-kind", node.kind));
    reveal(label, node.id);
    item.append(label);

    const own = stepOf(node.id) ?? 0;
    let from = own;

    const children = childrenOf(node);
    if (children.length > 0) {
      const list = el("ul", "tree-children");
      let earliest = Number.POSITIVE_INFINITY;
      for (const child of children) {
        const built = buildNode(child);
        list.append(built.el);
        earliest = Math.min(earliest, built.from);
      }
      const listFrom = Number.isFinite(earliest) ? earliest : own;
      grow(list, listFrom);
      from = Math.min(from, listFrom);
      item.append(list);
    }

    grow(item, from);
    return { el: item, from };
  };

  const root = el("ul", "tree");
  root.append(buildNode(program).el);
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
    row.append(el("td", undefined, typeName(symbol.type)));
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

/**
 * The interference graph, drawn, and the same thing as a table.
 *
 * The drawing is the argument — two temporaries joined by a line cannot share a
 * register — but it is not the accessible copy: an SVG full of eleven-pixel text
 * is no way to read a table, so the graph is hidden from the accessibility tree
 * and the table beside it carries every fact the graph does.
 *
 * There is deliberately no hue in here. On this page the accent means "here" and
 * syntax colour means "what kind of token"; a third meaning would make both of
 * them ambiguous. So a coloured node is labelled with the name of the register it
 * got, which is what the colour stood for anyway. A coalesced pair gets a dashed
 * line rather than a colour of its own, for the same reason — the table beside
 * it says the same thing in words either way.
 */
function buildRegalloc(
  compilation: Compilation,
  body: HTMLElement,
  reveal: Reveals,
): void {
  const { functions } = compilation.regalloc;
  const withTemps = functions.filter((one) => one.nodes.length > 0);

  if (withTemps.length === 0) {
    body.append(
      el(
        "p",
        "pane-note",
        "Nothing to allocate: this program computes no intermediate values, so there is no graph and no competition for a register.",
      ),
    );
    return;
  }

  for (const alloc of withTemps) {
    body.append(el("h3", "pane-subhead", `${alloc.func} — ${alloc.nodes.length} temporaries`));
    body.append(graphOf(alloc, reveal));
    body.append(tableOf(alloc, reveal));
  }

  body.append(
    el(
      "p",
      "pane-note",
      "Twelve colours, because two of the fourteen general-purpose registers are held back as scratch and neither the stack pointer nor the frame pointer is ever available. A temporary with no colour keeps the stack slot it already had.",
    ),
  );
  body.append(
    el(
      "p",
      "pane-note",
      "A dashed line is a coalesce, not an interference: x86 arithmetic computes into one of its own operands, so a destination and an operand that never overlap are given the same register on purpose — the copy between them would otherwise be a real instruction with nothing to do.",
    ),
  );
}

const GRAPH_SIZE = 260;
const GRAPH_RADIUS = 96;

function graphOf(
  alloc: Compilation["regalloc"]["functions"][number],
  reveal: Reveals,
): SVGElement {
  const nodes = alloc.nodes;
  const centre = GRAPH_SIZE / 2;
  const dot = Math.max(9, Math.min(17, 220 / Math.max(5, nodes.length)));

  const at = (index: number) => {
    if (nodes.length === 1) return { x: centre, y: centre };
    const angle = -Math.PI / 2 + (index * 2 * Math.PI) / nodes.length;
    return {
      x: centre + GRAPH_RADIUS * Math.cos(angle),
      y: centre + GRAPH_RADIUS * Math.sin(angle),
    };
  };

  const where = new Map(nodes.map((node, index) => [node.temp, at(index)]));
  const svg = svgEl("svg", "graph", {
    viewBox: `0 0 ${GRAPH_SIZE} ${GRAPH_SIZE}`,
    "aria-hidden": "true",
    focusable: "false",
  });

  // Edges first, so a node's circle sits on top of the lines that reach it.
  for (const edge of alloc.edges) {
    const from = where.get(edge.a);
    const to = where.get(edge.b);
    if (!from || !to) continue;
    svg.append(
      reveal(
        svgEl("line", "graph-edge", { x1: from.x, y1: from.y, x2: to.x, y2: to.y }),
        edge.id,
      ),
    );
  }

  // A coalesced pair never has an interference edge — that is the whole
  // precondition for merging them — so it gets its own dashed line instead,
  // revealed at the same step the pair is coloured, since that is the step
  // that makes the merge real rather than merely proposed. A group of more
  // than two draws as a chain, one link to its next member, rather than every
  // pair: a five-way merge drawn completely is ten crossing lines saying the
  // same thing ten times, which is noise, not evidence.
  const indexOf = new Map(nodes.map((node, index) => [node.temp, index]));
  for (const node of nodes) {
    const members = node.coalescedWith ?? [];
    if (members.length === 0) continue;
    const myIndex = indexOf.get(node.temp) ?? 0;
    let next: string | undefined;
    let nextIndex = Number.POSITIVE_INFINITY;
    for (const partner of members) {
      const index = indexOf.get(partner) ?? -1;
      if (index > myIndex && index < nextIndex) {
        nextIndex = index;
        next = partner;
      }
    }
    if (!next) continue;
    const from = where.get(node.temp);
    const to = where.get(next);
    if (!from || !to) continue;
    svg.append(
      reveal(
        svgEl("line", "graph-coalesce", { x1: from.x, y1: from.y, x2: to.x, y2: to.y }),
        `${node.id}:reg`,
      ),
    );
  }

  for (const node of nodes) {
    const point = where.get(node.temp);
    if (!point) continue;

    const group = svgEl("g", "graph-node");
    group.append(svgEl("circle", "graph-dot", { cx: point.x, cy: point.y, r: dot }));
    const name = svgEl("text", "graph-name", {
      x: point.x,
      y: point.y,
      "text-anchor": "middle",
      "dominant-baseline": "central",
    });
    name.textContent = node.temp;
    group.append(name);
    svg.append(reveal(group, node.id));

    const register = svgEl("text", "graph-reg", {
      x: point.x,
      y: point.y + dot + 10,
      "text-anchor": "middle",
    });
    register.textContent = node.reg ?? "stack";
    svg.append(reveal(register, `${node.id}:reg`));
  }

  return svg;
}

function tableOf(
  alloc: Compilation["regalloc"]["functions"][number],
  reveal: Reveals,
): HTMLElement {
  const table = el("table", "symbols allocation");
  const head = el("thead");
  const headRow = el("tr");
  for (const heading of [
    "value",
    "cannot share with",
    "coalesced with",
    "set aside",
    "lives in",
  ]) {
    headRow.append(el("th", undefined, heading));
  }
  head.append(headRow);
  table.append(head);

  const tbody = el("tbody");
  for (const node of alloc.nodes) {
    const row = el("tr", "symbol");
    row.append(el("td", "symbol-name", node.temp));
    row.append(
      el(
        "td",
        undefined,
        node.neighbours.length > 0 ? node.neighbours.join(" ") : "—",
      ),
    );
    row.append(
      el(
        "td",
        "alloc-coalesced",
        node.coalescedWith && node.coalescedWith.length > 0
          ? node.coalescedWith.join(" ")
          : "—",
      ),
    );
    row.append(
      reveal(
        el("td", "alloc-order", node.order === undefined ? "—" : `#${node.order}`),
        `${node.id}:order`,
      ),
    );
    row.append(
      reveal(
        el("td", "alloc-reg", node.reg ?? "the frame"),
        `${node.id}:reg`,
      ),
    );
    tbody.append(reveal(row, node.id));
  }
  table.append(tbody);
  return table;
}

function buildRun(
  compilation: Compilation,
  body: HTMLElement,
  reveal: Reveals,
): void {
  const run = compilation.run;
  if (!run) {
    body.append(
      el("p", "pane-note", "Nothing to run: the program never reached the IR."),
    );
    return;
  }

  if (run.error) {
    const box = el("div", "diagnostic");
    box.setAttribute("role", "status");
    box.append(el("p", "diagnostic-message", run.error.message));
    if (run.error.hint) box.append(el("p", "diagnostic-hint", run.error.hint));
    body.append(box);
  }

  const list = el("ol", "effects");
  for (const effect of run.effects) {
    const item = el("li", effect.id === "run:result" ? "effect effect-result" : "effect");
    item.append(el("span", "effect-text", effect.text));
    item.append(el("span", "effect-where", effect.instr));
    list.append(reveal(item, effect.id));
  }
  body.append(list);

  if (run.truncated) {
    body.append(
      el(
        "p",
        "pane-note",
        `The trace stops here, but the program did not: ${run.executed.toLocaleString()} instructions ran in total. Stepping through all of them would take longer than reading the source.`,
      ),
    );
  }

  body.append(
    el(
      "p",
      "pane-note",
      "Memory is one flat array here, so a pointer is an index into it. That is why writing past the end of an array lands on whatever happens to sit next to it, quietly, exactly as C does.",
    ),
  );
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
