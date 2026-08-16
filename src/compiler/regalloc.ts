import { functionsOf, valuesOf } from "./frames";
import {
  ALLOCATABLE,
  CALLEE_SAVED,
  CALLER_SAVED,
  COLOURS,
  DIV_CLOBBERS,
  type Reg,
} from "./registers";
import { StepLog } from "./steps";
import type { Diagnostic, IRInstr, IRValue, Span, Step } from "./types";

/**
 * Register allocation, by colouring an interference graph.
 *
 * Lowering invents a temporary for every intermediate value and never reuses
 * one, so a small function can name twenty of them. The machine has fourteen
 * general-purpose registers and this compiler keeps two of those back as scratch.
 * The question this stage answers is which temporaries can share.
 *
 * Two temporaries can share a register exactly when they are never both live at
 * the same moment — "live" meaning a later instruction still reads the value. So:
 *
 *   1. Work out, for every point in the function, which temporaries are live.
 *      That is a backward dataflow problem over the control-flow graph, and a
 *      loop means iterating to a fixed point rather than one pass.
 *   2. Draw an edge between any two that are live together. Call the result an
 *      interference graph.
 *   3. Colour it with twelve colours, where the colours are registers.
 *
 * Step three is graph colouring, which is NP-complete in general. Chaitin's
 * answer is the heuristic used here: a node with fewer than twelve neighbours can
 * always be coloured after everything else is, so set it aside and colour the
 * smaller graph. If every remaining node has twelve or more neighbours, set one
 * aside optimistically anyway — its neighbours often collide with each other and
 * leave it a colour. Whatever is left over at the end has no register and stays
 * in the stack slot `frames.ts` already gave it.
 *
 * Two constraints come from the machine rather than from the program, and both
 * are drawn into the same graph as edges to a physical register:
 *
 *   - A call destroys the caller-saved registers, so anything live across one
 *     must be in `rbx` or the high registers — which is why a value used before
 *     and after a call is the thing that pushes a function into callee-saved
 *     territory.
 *   - `idiv` destroys `rax` and `rdx` whether you wanted it to or not.
 *
 * Named locals are not allocated. `&x` has to mean something, and an address is
 * something only memory has — so a local stays in its frame slot for its whole
 * life and only the compiler's own temporaries compete for registers.
 *
 * One more question sits between building the graph and colouring it: does a
 * copy have to be a copy? x86 arithmetic is two-address — `add eax, ecx`
 * computes `eax = eax + ecx`, overwriting one of its own operands — so lowering
 * a three-address instruction like `t2 = t0 + t1` onto it means either `t0` or
 * `t1` has to already be wherever `t2` is going to live, or codegen has to spend
 * a `mov` making that true first. If `t0` and `t2` do not otherwise interfere,
 * there is a cheaper answer: give them the same colour, and the `mov` has
 * nothing left to do. That is coalescing, and the candidates for it are read
 * straight off the IR — the destination and one operand of every `+`, `-` and
 * `*`, and of unary `-` — because those are exactly the instructions the machine
 * itself asks to share a register.
 *
 * Merging greedily is not safe: forcing two low-degree nodes into one can build
 * a node with enough neighbours that the graph stops being colourable, which
 * would turn a program that fit into one that has to spill somewhere it did not
 * need to. Briggs' conservative rule is the guard: count the neighbours the
 * *merged* node would have that themselves have twelve or more neighbours of
 * their own. If fewer than twelve of those exist, the merge cannot be the thing
 * that pushes anything over the edge, so it is safe regardless of how the rest
 * of the graph gets coloured. Short of that count, the merge is refused and the
 * copy stays — a real `mov`, exactly as CLAUDE.md always said this allocator
 * would emit for one, just no longer for every one.
 */

/** One temporary, as the graph sees it. */
export type RegNode = {
  id: string;
  temp: string;
  width: number;
  /** Other temporaries it cannot share a register with. */
  neighbours: string[];
  /** Physical registers ruled out by a call or a division. */
  forbidden: Reg[];
  /** Position in the simplify order, filled in as nodes are set aside. */
  order?: number;
  /** The colour it got, if it got one. */
  reg?: Reg;
  /** Other temporaries forced to share this one's colour, if any were. */
  coalescedWith?: string[];
};

export type RegEdge = { id: string; a: string; b: string };

/** One `dest`/operand pair a two-address instruction offered to coalesce. */
export type CoalesceDecision = {
  a: string;
  b: string;
  via: string;
  merged: boolean;
  reason: string;
};

export type FunctionAlloc = {
  func: string;
  nodes: RegNode[];
  edges: RegEdge[];
  /** temp name -> register. A missing name stayed in its stack slot. */
  colours: Map<string, Reg>;
  /** Callee-saved registers this function has to save and restore. */
  saved: Reg[];
  spilled: string[];
  /** Every coalescing candidate the allocator considered, and what it decided. */
  coalesced: CoalesceDecision[];
};

export type RegallocResult = {
  functions: FunctionAlloc[];
  steps: Step[];
  error?: Diagnostic;
};

/** The register a temporary lives in, or undefined if it stayed in memory. */
export function registerOf(
  alloc: RegallocResult,
  func: string,
  temp: string,
): Reg | undefined {
  return alloc.functions.find((one) => one.func === func)?.colours.get(temp);
}

export function allocationFor(
  alloc: RegallocResult,
  func: string,
): FunctionAlloc | undefined {
  return alloc.functions.find((one) => one.func === func);
}

// --------------------------------------------------------------- def and use

/** The temporary an instruction writes, if it writes one. */
function defOf(instr: IRInstr): string | undefined {
  switch (instr.op) {
    case "move":
    case "binary":
    case "unary":
    case "addr":
    case "load":
      return instr.dest.kind === "temp" ? instr.dest.name : undefined;
    case "call":
      return instr.dest?.kind === "temp" ? instr.dest.name : undefined;
    default:
      return undefined;
  }
}

/** The temporaries an instruction reads. A `store` reads both of its operands. */
function usesOf(instr: IRInstr): string[] {
  const read: IRValue[] = readsOf(instr);
  const names: string[] = [];
  for (const value of read) {
    if (value.kind === "temp" && !names.includes(value.name)) names.push(value.name);
  }
  return names;
}

function readsOf(instr: IRInstr): IRValue[] {
  switch (instr.op) {
    case "move":
      return [instr.src];
    case "binary":
      return [instr.left, instr.right];
    case "unary":
      return [instr.operand];
    case "branchFalse":
    case "branchTrue":
      return [instr.cond];
    case "call":
      return instr.args;
    case "return":
      return instr.value ? [instr.value] : [];
    case "load":
      return [instr.from];
    case "store":
      return [instr.to, instr.src];
    default:
      return [];
  }
}

/** Registers this instruction destroys behind the compiler's back. */
function clobbersOf(instr: IRInstr): Reg[] {
  if (instr.op === "call") return CALLER_SAVED;
  if (instr.op === "binary" && (instr.operator === "/" || instr.operator === "%")) {
    return DIV_CLOBBERS;
  }
  return [];
}

/** The two-address arithmetic ops: the ones x86 computes into one of its own operands. */
const TWO_ADDRESS = new Set(["+", "-", "*"]);
const COMMUTATIVE = new Set(["+", "*"]);

/**
 * Every `dest`/operand pair a two-address instruction would rather not have to
 * separate with a `mov`.
 *
 * `t2 = t0 + t1` offers `(t2, t0)` always, and `(t2, t1)` as well when the
 * operator is commutative — `sub` cannot read its operands the other way
 * around, but `add` and `imul` can, so codegen is free to swap them to make
 * either pairing the one that lands in place. Division is not here: `idiv`
 * reads and writes fixed registers regardless of what the allocator decides,
 * so there is no `mov` a coalesce could remove.
 */
export function coalesceCandidatesOf(
  body: IRInstr[],
): { a: string; b: string; via: string }[] {
  const found: { a: string; b: string; via: string }[] = [];
  for (const instr of body) {
    if (instr.op === "binary" && TWO_ADDRESS.has(instr.operator)) {
      if (instr.dest.kind === "temp" && instr.left.kind === "temp") {
        found.push({ a: instr.dest.name, b: instr.left.name, via: "left operand" });
      }
      if (
        COMMUTATIVE.has(instr.operator) &&
        instr.dest.kind === "temp" &&
        instr.right.kind === "temp"
      ) {
        found.push({ a: instr.dest.name, b: instr.right.name, via: "right operand" });
      }
    } else if (
      instr.op === "unary" &&
      instr.operator === "-" &&
      instr.dest.kind === "temp" &&
      instr.operand.kind === "temp"
    ) {
      found.push({ a: instr.dest.name, b: instr.operand.name, via: "its operand" });
    }
  }
  return found;
}

// ------------------------------------------------------------ control flow

export type Block = { start: number; end: number; succ: number[] };

/**
 * Split a function into basic blocks: straight-line runs with one way in and one
 * way out. A block starts at a label or just after a jump, and liveness is
 * computed over the graph they form rather than over the listing, because a
 * backward jump makes the listing order a lie.
 */
export function blocksOf(body: IRInstr[]): Block[] {
  const leaders = new Set<number>([0]);
  body.forEach((instr, index) => {
    if (instr.op === "label") leaders.add(index);
    if (
      instr.op === "jump" ||
      instr.op === "branchFalse" ||
      instr.op === "branchTrue" ||
      instr.op === "return"
    ) {
      if (index + 1 < body.length) leaders.add(index + 1);
    }
  });

  const starts = [...leaders].sort((a, b) => a - b);
  const blocks: Block[] = starts.map((start, index) => ({
    start,
    end: index + 1 < starts.length ? starts[index + 1] : body.length,
    succ: [],
  }));

  const byLabel = new Map<string, number>();
  blocks.forEach((block, index) => {
    const first = body[block.start];
    if (first?.op === "label") byLabel.set(first.name, index);
  });

  blocks.forEach((block, index) => {
    const last = body[block.end - 1];
    if (!last) return;
    const fallthrough = index + 1 < blocks.length ? [index + 1] : [];
    switch (last.op) {
      case "jump": {
        const target = byLabel.get(last.target);
        if (target !== undefined) block.succ.push(target);
        return;
      }
      case "branchFalse":
      case "branchTrue": {
        const target = byLabel.get(last.target);
        if (target !== undefined) block.succ.push(target);
        block.succ.push(...fallthrough);
        return;
      }
      case "return":
        return;
      default:
        block.succ.push(...fallthrough);
    }
  });

  return blocks;
}

/**
 * Which temporaries are live on the way out of each block.
 *
 * Backward, because liveness flows from a use towards the definition that fed it,
 * and iterated to a fixed point, because a loop's body is live-out of the test
 * that comes before it in the listing. The sets only ever grow, so the loop
 * terminates.
 */
export function livenessOf(
  body: IRInstr[],
  blocks: Block[],
): { liveIn: Set<string>[]; liveOut: Set<string>[] } {
  const use: Set<string>[] = [];
  const def: Set<string>[] = [];

  for (const block of blocks) {
    const blockUse = new Set<string>();
    const blockDef = new Set<string>();
    for (let at = block.start; at < block.end; at += 1) {
      for (const name of usesOf(body[at])) {
        if (!blockDef.has(name)) blockUse.add(name);
      }
      const written = defOf(body[at]);
      if (written) blockDef.add(written);
    }
    use.push(blockUse);
    def.push(blockDef);
  }

  let liveIn = blocks.map(() => new Set<string>());
  let liveOut = blocks.map(() => new Set<string>());

  for (let round = 0; round < blocks.length + 2; round += 1) {
    let grew = false;
    const nextIn = liveIn.map((set) => new Set(set));
    const nextOut = liveOut.map((set) => new Set(set));

    for (let index = blocks.length - 1; index >= 0; index -= 1) {
      const out = new Set<string>();
      for (const succ of blocks[index].succ) {
        for (const name of nextIn[succ]) out.add(name);
      }
      const inner = new Set(out);
      for (const name of def[index]) inner.delete(name);
      for (const name of use[index]) inner.add(name);
      if (out.size !== nextOut[index].size || inner.size !== nextIn[index].size) {
        grew = true;
      }
      nextOut[index] = out;
      nextIn[index] = inner;
    }

    liveIn = nextIn;
    liveOut = nextOut;
    if (!grew) break;
  }

  return { liveIn, liveOut };
}

/**
 * Which temporaries are still wanted immediately after each instruction, keyed by
 * the instruction's id.
 *
 * This is the whole answer the graph is built from, and it is worth being able to
 * ask for on its own: "is this value live across that call" is a question about
 * this map, and it is the question the machine constraints turn on.
 */
export function liveAfter(body: IRInstr[]): Map<string, Set<string>> {
  const blocks = blocksOf(body);
  const { liveOut } = livenessOf(body, blocks);
  const after = new Map<string, Set<string>>();

  blocks.forEach((block, index) => {
    const live = new Set(liveOut[index]);
    for (let at = block.end - 1; at >= block.start; at -= 1) {
      const instr = body[at];
      after.set(instr.id, new Set(live));
      const written = defOf(instr);
      if (written) live.delete(written);
      for (const name of usesOf(instr)) live.add(name);
    }
  });

  return after;
}

// ------------------------------------------------------------------- the pass

export function allocate(instrs: IRInstr[]): RegallocResult {
  const log = new StepLog("regalloc");
  const functions: FunctionAlloc[] = [];

  for (const body of functionsOf(instrs)) {
    const head = body[0];
    if (head.op !== "enter") continue;
    functions.push(allocateOne(head.func, body, head.span, log));
  }

  return { functions, steps: log.all() };
}

function allocateOne(
  func: string,
  body: IRInstr[],
  funcSpan: Span,
  log: StepLog,
): FunctionAlloc {
  // Definition order, and the same order `layoutFrame` walks, so the table here
  // and the slots in the frame list the temporaries the same way.
  const temps: string[] = [];
  const width = new Map<string, number>();
  const definedAt = new Map<string, Span>();
  for (const instr of body) {
    for (const value of valuesOf(instr)) {
      if (value.kind !== "temp" || width.has(value.name)) continue;
      temps.push(value.name);
      width.set(value.name, value.width);
      definedAt.set(value.name, instr.span);
    }
  }

  const alloc: FunctionAlloc = {
    func,
    nodes: [],
    edges: [],
    colours: new Map(),
    saved: [],
    spilled: [],
    coalesced: [],
  };

  if (temps.length === 0) {
    log.add(
      `nothing to allocate in ${func}`,
      `${func} never needed a temporary: every value it computes goes straight where it belongs. There is no graph to colour, so nothing here competes for a register.`,
      funcSpan,
    );
    return alloc;
  }

  const rank = new Map(temps.map((name, index) => [name, index]));
  const adjacent = new Map<string, Set<string>>(temps.map((name) => [name, new Set()]));
  const forbidden = new Map<string, Set<Reg>>(temps.map((name) => [name, new Set()]));

  const interfere = (a: string, b: string) => {
    if (a === b) return;
    adjacent.get(a)?.add(b);
    adjacent.get(b)?.add(a);
  };

  const after = liveAfter(body);
  for (const instr of body) {
    const live = after.get(instr.id) ?? new Set<string>();
    const written = defOf(instr);

    // Whatever this instruction writes cannot go anywhere that is still wanted.
    if (written) {
      for (const other of live) interfere(written, other);
    }

    // A clobber is against whatever is live AFTER the instruction. The value
    // this instruction produces is not: it is moved out of the clobbered
    // register the moment the instruction finishes.
    const clobbers = clobbersOf(instr);
    if (clobbers.length > 0) {
      for (const other of live) {
        if (other === written) continue;
        const set = forbidden.get(other);
        for (const reg of clobbers) set?.add(reg);
      }
    }
  }

  // ------------------------------------------------------------ the graph

  const nodes = new Map<string, RegNode>();
  const introduced = new Set<string>();

  for (const temp of temps) {
    const neighbours = [...(adjacent.get(temp) ?? [])].sort(
      (a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0),
    );
    const blocked = [...(forbidden.get(temp) ?? [])];
    const node: RegNode = {
      id: `ra:${func}:${temp}`,
      temp,
      width: width.get(temp) ?? 4,
      neighbours,
      forbidden: blocked,
    };
    nodes.set(temp, node);
    alloc.nodes.push(node);

    // An edge exists once both of its ends do, so it is revealed with whichever
    // of the two arrives second.
    const produced = [node.id];
    for (const other of neighbours) {
      if (!introduced.has(other)) continue;
      const edge: RegEdge = { id: edgeId(func, other, temp), a: other, b: temp };
      alloc.edges.push(edge);
      produced.push(edge.id);
    }
    introduced.add(temp);

    log.add(
      `live range of ${temp}`,
      explainRange(temp, neighbours, blocked),
      definedAt.get(temp) ?? funcSpan,
      produced,
    );
  }

  // ---------------------------------------------------------- coalesce

  // Union-find over the original temps: `repOf` answers "which group is this
  // temp in now", `groups` answers "who is in this group". Both start as every
  // temp on its own; merging only ever moves members into an existing key and
  // deletes the one it absorbed, so `groups`' insertion order — and therefore
  // the definition order every other pass relies on — never changes.
  const repOf = new Map<string, string>(temps.map((temp) => [temp, temp]));
  const groups = new Map<string, string[]>(temps.map((temp) => [temp, [temp]]));
  const find = (temp: string): string => repOf.get(temp) ?? temp;

  /** Every OTHER group this one is still live alongside, as of right now. */
  const neighbourGroupsOf = (rep: string): Set<string> => {
    const result = new Set<string>();
    for (const member of groups.get(rep) ?? [rep]) {
      for (const neighbour of nodes.get(member)?.neighbours ?? []) {
        const neighbourRep = find(neighbour);
        if (neighbourRep !== rep) result.add(neighbourRep);
      }
    }
    return result;
  };

  for (const { a, b, via } of coalesceCandidatesOf(body)) {
    const ra = find(a);
    const rb = find(b);
    // Already the same value — usually because an earlier candidate in the
    // same expression already pulled them together. Nothing left to decide.
    if (ra === rb) continue;

    const neighboursOfA = neighbourGroupsOf(ra);
    if (neighboursOfA.has(rb)) {
      alloc.coalesced.push({
        a,
        b,
        via,
        merged: false,
        reason: `${a} and ${b} are live at the same moment, so forcing them into one register would be wrong, not just expensive. The \`mov\` stays.`,
      });
      log.add(
        `keep ${a} and ${b} separate`,
        `${a} is ${via} of the instruction that produces it, and x86 would rather compute the answer directly into ${b}'s register than copy it there afterwards. But ${b} is still needed after that point, so the two cannot be the same value. The copy is real work, not waste.`,
        definedAt.get(a) ?? funcSpan,
        [],
      );
      continue;
    }

    // Briggs' conservative test: count the neighbours the MERGED node would
    // have that are themselves near the colour limit. Only those can be
    // pushed over the edge by adding one more neighbour, so if there are
    // fewer of them than there are colours, the merge cannot be the move that
    // makes the graph uncolourable.
    const combined = new Set([...neighboursOfA, ...neighbourGroupsOf(rb)]);
    let risky = 0;
    for (const neighbour of combined) {
      if (neighbourGroupsOf(neighbour).size >= COLOURS) risky += 1;
    }

    if (risky < COLOURS) {
      // The earlier-defined temp keeps its name as the group's representative,
      // so which of two merged values "is" the group never depends on the
      // order the allocator happened to visit them in.
      const survivor = (rank.get(ra) ?? 0) <= (rank.get(rb) ?? 0) ? ra : rb;
      const absorbed = survivor === ra ? rb : ra;
      for (const member of groups.get(absorbed) ?? []) repOf.set(member, survivor);
      groups.set(
        survivor,
        [...(groups.get(survivor) ?? []), ...(groups.get(absorbed) ?? [])].sort(
          (x, y) => (rank.get(x) ?? 0) - (rank.get(y) ?? 0),
        ),
      );
      groups.delete(absorbed);

      alloc.coalesced.push({ a, b, via, merged: true, reason: "" });
      log.add(
        `coalesce ${a} with ${b}`,
        `${a} is ${via} of the instruction that produces it, so x86 can compute the answer directly into ${b}'s register instead of somewhere else and copying it in. ${combined.size} other value${combined.size === 1 ? "" : "s"} is${combined.size === 1 ? "" : " are"} live alongside the merged pair, and fewer than ${COLOURS} of ${combined.size === 1 ? "it" : "them"} ${combined.size === 1 ? "is" : "are"} themselves near the colour limit — so this cannot be the merge that makes the graph uncolourable. ${a} and ${b} become one value, and the \`mov\` between them disappears.`,
        definedAt.get(a) ?? funcSpan,
        [],
      );
    } else {
      alloc.coalesced.push({
        a,
        b,
        via,
        merged: false,
        reason: `Merging ${a} and ${b} would give the combined value ${risky} neighbours that are themselves near the colour limit — ${COLOURS} or more — which is enough to risk making the whole graph uncolourable. The conservative rule refuses rather than find out; the copy stays.`,
      });
      log.add(
        `keep ${a} and ${b} separate`,
        `${a} and ${b} do not interfere, so merging them would not be wrong — but ${risky} of the values they would together be live alongside are themselves close to running out of colours, which is exactly the situation that can turn a colourable graph into one that is not. The conservative rule declines rather than gamble, so the copy between them stays.`,
        definedAt.get(a) ?? funcSpan,
        [],
      );
    }
  }

  for (const temp of temps) {
    const members = (groups.get(find(temp)) ?? [temp]).filter((other) => other !== temp);
    if (members.length > 0) {
      const node = nodes.get(temp);
      if (node) node.coalescedWith = members;
    }
  }

  // Every group left is one unit for the rest of the algorithm. `groups`' key
  // order is still definition order, because merging only ever deletes a key,
  // never inserts one.
  const reps = [...groups.keys()];
  const label = (rep: string): string => (groups.get(rep) ?? [rep]).join("/");
  const repNeighbours = new Map<string, string[]>(
    reps.map((rep) => [
      rep,
      [...neighbourGroupsOf(rep)].sort((a, b) => (rank.get(a) ?? 0) - (rank.get(b) ?? 0)),
    ]),
  );
  const repForbidden = new Map<string, Set<Reg>>(
    reps.map((rep) => [
      rep,
      new Set((groups.get(rep) ?? [rep]).flatMap((member) => nodes.get(member)?.forbidden ?? [])),
    ]),
  );

  // ----------------------------------------------------------- simplify

  const degree = new Map(reps.map((rep) => [rep, repNeighbours.get(rep)?.length ?? 0]));
  const removed = new Set<string>();
  const stack: string[] = [];

  while (stack.length < reps.length) {
    // The first node under the colour count, in listing order. Deterministic on
    // purpose: the same program has to produce the same allocation every time,
    // or the page would change under a reader who typed nothing.
    let pick = reps.find((rep) => !removed.has(rep) && (degree.get(rep) ?? 0) < COLOURS);
    let optimistic = false;
    if (!pick) {
      optimistic = true;
      let worst = -1;
      for (const rep of reps) {
        if (removed.has(rep)) continue;
        const at = degree.get(rep) ?? 0;
        if (at > worst) {
          worst = at;
          pick = rep;
        }
      }
    }
    if (!pick) break;

    const left = degree.get(pick) ?? 0;
    removed.add(pick);
    const order = stack.length + 1;
    stack.push(pick);
    for (const other of repNeighbours.get(pick) ?? []) {
      if (!removed.has(other)) degree.set(other, (degree.get(other) ?? 1) - 1);
    }

    const members = groups.get(pick) ?? [pick];
    const ids: string[] = [];
    for (const member of members) {
      const node = nodes.get(member);
      if (!node) continue;
      node.order = order;
      ids.push(`${node.id}:order`);
    }

    log.add(
      `set ${label(pick)} aside`,
      optimistic
        ? `Every value left has ${COLOURS} neighbours or more, so none of them is safely colourable. ${label(pick)} goes on the stack anyway — its neighbours may yet share colours with each other and leave it one. If they do not, it stays in memory.`
        : `${label(pick)} has ${left} neighbour${left === 1 ? "" : "s"} still in the graph, fewer than the ${COLOURS} colours available. Whatever the rest of the graph does, there will be a register left over for it — so it can be removed and dealt with last.`,
      definedAt.get(pick) ?? funcSpan,
      ids,
    );
  }

  // ------------------------------------------------------------- select

  const repColour = new Map<string, Reg>();

  while (stack.length > 0) {
    const rep = stack.pop();
    if (!rep) break;
    const members = groups.get(rep) ?? [rep];

    const taken = new Set<Reg>(repForbidden.get(rep) ?? []);
    for (const other of repNeighbours.get(rep) ?? []) {
      const colour = repColour.get(other);
      if (colour) taken.add(colour);
    }
    const free = ALLOCATABLE.find((reg) => !taken.has(reg));

    const ids: string[] = [];
    if (free) {
      repColour.set(rep, free);
      if (CALLEE_SAVED.includes(free) && !alloc.saved.includes(free)) {
        alloc.saved.push(free);
      }
    }
    for (const member of members) {
      const node = nodes.get(member);
      if (free) {
        alloc.colours.set(member, free);
        if (node) node.reg = free;
      } else {
        alloc.spilled.push(member);
      }
      if (node) ids.push(`${node.id}:reg`);
    }

    log.add(
      free ? `${label(rep)} takes ${free}` : `${label(rep)} stays in memory`,
      explainColour(label(rep), free, repNeighbours.get(rep)?.length ?? 0, taken.size, members.length),
      definedAt.get(rep) ?? funcSpan,
      ids,
    );
  }

  // Save in a fixed order rather than in the order the colours happened to land,
  // so the prologue of a given program is the same every time it is compiled.
  alloc.saved = CALLEE_SAVED.filter((reg) => alloc.saved.includes(reg));
  return alloc;
}

export function edgeId(func: string, a: string, b: string): string {
  return `ra:${func}:${a}~${b}`;
}

function explainRange(temp: string, neighbours: string[], blocked: Reg[]): string {
  const clash =
    neighbours.length === 0
      ? `Nothing else is live while ${temp} is, so it can have any register at all.`
      : `${temp} is live at the same moment as ${list(neighbours)}, so it cannot share a register with ${neighbours.length === 1 ? "it" : "any of them"}. That is one edge in the graph per name.`;
  if (blocked.length === 0) return clash;
  return `${clash} It also has to survive an instruction that destroys ${list(blocked.slice(0, 4))}${blocked.length > 4 ? " and the rest of the caller-saved half" : ""}, so those registers are ruled out before the colouring starts.`;
}

function explainColour(
  label: string,
  free: Reg | undefined,
  neighbourCount: number,
  taken: number,
  members: number,
): string {
  const coalesced =
    members > 1 ? ` They were coalesced into one value, so one colour is all ${members} of them need.` : "";
  if (free) {
    return `Putting ${label} back into the graph, ${taken} of the ${COLOURS} colours are already spoken for by its neighbours or ruled out by the machine. ${free} is the first one left, so ${label} lives there instead of in memory.${coalesced}`;
  }
  return `All ${COLOURS} colours are taken by ${label}'s ${neighbourCount} neighbour${neighbourCount === 1 ? "" : "s"}, so the optimism did not pay off. ${label} keeps the stack slot${members > 1 ? "s" : ""} the frame layout already gave it, and every use of it becomes a load — which is exactly what a register-starved function costs.`;
}

function list(names: string[]): string {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

export const EMPTY_ALLOCATION: RegallocResult = { functions: [], steps: [] };
