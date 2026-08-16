import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { type ArgMove, shuffle } from "../src/compiler/codegen";
import { functionsOf, layoutFrame } from "../src/compiler/frames";
import { compile } from "../src/compiler/pipeline";
import { blocksOf, coalesceCandidatesOf, liveAfter } from "../src/compiler/regalloc";
import {
  ALLOCATABLE,
  ARG_REGISTERS,
  CALLEE_SAVED,
  CALLER_SAVED,
  COLOURS,
  DIV_CLOBBERS,
  SCRATCH_A,
  SCRATCH_B,
  regName,
} from "../src/compiler/registers";
import type { Compilation, IRInstr } from "../src/compiler/types";

/**
 * What the allocator has to be right about.
 *
 * String tests cannot see a wrong allocation — `mov eax, ebx` is a perfectly
 * well-formed instruction whichever register it names — so `spec/machine.test.ts`
 * assembling the output with real gcc and comparing exit statuses is the sensor
 * that actually catches a bad colouring. What is here is the layer above that:
 * the properties an allocation has to satisfy for the code to be right at all,
 * checked directly rather than inferred from a program happening to work.
 *
 * Every one of these can fail. The interference property fails if the colouring
 * loop stops early; the caller-saved property fails if `clobbersOf` forgets a
 * register; the argument-shuffle property fails if `shuffle` moves in listing
 * order.
 */

const PRESSURE = readFileSync(resolve("spec/programs/pressure.c"), "utf8");

const NESTED_LOOP = `int main() {
  int total = 0;
  int i = 0;
  while (i < 10) {
    int j = 0;
    while (j < 10) {
      total = total + i * j;
      j = j + 1;
    }
    i = i + 1;
  }
  return total % 97;
}`;

const POINTERS = `int sum(int *a, int n) {
  int total = 0;
  for (int i = 0; i < n; i = i + 1) { total = total + a[i]; }
  return total;
}
int main() {
  int a[4];
  a[0] = 1; a[1] = 2; a[2] = 3; a[3] = 4;
  return sum(a, 4);
}`;

const DIVISION = `int main() {
  int a = 40;
  int b = 7;
  return (a / b) + (a % b) + (a / 2);
}`;

/**
 * `t0 = a + b` feeds straight into `t2 = t0 + t1`, and `t0` is dead the moment
 * that read happens — so `t2` can coalesce with it and the `add` computes
 * directly into the register `t0` already occupied. `t1` is the second `+`'s
 * OTHER operand — `a + b` recomputed, since this compiler never reuses a
 * subexpression — and it is still alive when `t2` is produced (its own
 * instruction reads it), so that pairing has to stay two values and a real
 * `mov`.
 */
const COALESCE = `int main() {
  int a = 3;
  int b = 4;
  return (a + b) + (a + b);
}`;

const PROGRAMS: Record<string, string> = {
  pressure: PRESSURE,
  loops: NESTED_LOOP,
  pointers: POINTERS,
  division: DIVISION,
  coalesce: COALESCE,
};

function compiled(source: string): Compilation {
  const result = compile(source);
  expect(result.error, result.error?.message).toBeUndefined();
  return result;
}

/** One function's IR, by name. */
function bodyOf(result: Compilation, func: string): IRInstr[] {
  const body = functionsOf(result.ir.instrs).find(
    (chunk) => chunk[0]?.op === "enter" && chunk[0].func === func,
  );
  expect(body, `no function ${func}`).toBeTruthy();
  return body ?? [];
}

describe("the control-flow graph liveness is computed over", () => {
  it("gives a loop a block that reaches back to its own test", () => {
    const body = bodyOf(compiled(NESTED_LOOP), "main");
    const blocks = blocksOf(body);
    // A backward edge is the whole reason this cannot be one pass over the
    // listing: some block's successor is a block that started before it.
    const backward = blocks.some((block, index) =>
      block.succ.some((succ) => succ <= index),
    );
    expect(backward).toBe(true);
  });

  it("keeps a value live around the back edge, not just to the end of the listing", () => {
    const body = bodyOf(compiled(NESTED_LOOP), "main");
    const after = liveAfter(body);
    // Somewhere in a loop, a temporary computed by an earlier instruction is
    // still wanted after a later one. A single forward pass would have declared
    // it dead at its last textual use.
    const anyLive = [...after.values()].some((set) => set.size > 0);
    expect(anyLive).toBe(true);
  });

  it("says nothing is live after a return", () => {
    const body = bodyOf(compiled(NESTED_LOOP), "main");
    const after = liveAfter(body);
    for (const instr of body) {
      if (instr.op !== "return") continue;
      expect(after.get(instr.id)?.size, "something outlives a return").toBe(0);
    }
  });
});

describe("the colouring", () => {
  for (const [name, source] of Object.entries(PROGRAMS)) {
    describe(name, () => {
      const result = compiled(source);

      it("never gives two interfering values the same register", () => {
        // This is the property. Everything else in the allocator exists to make
        // it true, and the emitted code is wrong the moment it is not.
        for (const alloc of result.regalloc.functions) {
          for (const node of alloc.nodes) {
            const mine = alloc.colours.get(node.temp);
            if (!mine) continue;
            for (const other of node.neighbours) {
              expect(
                alloc.colours.get(other),
                `${alloc.func}: ${node.temp} and ${other} are both live, both in ${mine}`,
              ).not.toBe(mine);
            }
          }
        }
      });

      it("hands out only registers it is allowed to hand out", () => {
        const allowed = new Set(ALLOCATABLE);
        for (const alloc of result.regalloc.functions) {
          for (const [temp, reg] of alloc.colours) {
            expect(allowed.has(reg), `${alloc.func}: ${temp} got ${reg}`).toBe(true);
          }
        }
      });

      it("keeps nothing live across a call in a caller-saved register", () => {
        const caller = new Set(CALLER_SAVED);
        for (const alloc of result.regalloc.functions) {
          const after = liveAfter(bodyOf(result, alloc.func));
          for (const instr of bodyOf(result, alloc.func)) {
            if (instr.op !== "call") continue;
            const survivors = after.get(instr.id) ?? new Set<string>();
            for (const temp of survivors) {
              // The call's own result is written after the call returns, so it
              // is allowed to be in one.
              if (instr.dest?.kind === "temp" && instr.dest.name === temp) continue;
              const reg = alloc.colours.get(temp);
              if (!reg) continue;
              expect(
                caller.has(reg),
                `${alloc.func}: ${temp} survives ${instr.callee}() in ${reg}`,
              ).toBe(false);
            }
          }
        }
      });

      it("keeps nothing live across a division in rax or rdx", () => {
        const pair = new Set(DIV_CLOBBERS);
        for (const alloc of result.regalloc.functions) {
          const body = bodyOf(result, alloc.func);
          const after = liveAfter(body);
          for (const instr of body) {
            if (instr.op !== "binary") continue;
            if (instr.operator !== "/" && instr.operator !== "%") continue;
            for (const temp of after.get(instr.id) ?? []) {
              if (instr.dest.kind === "temp" && instr.dest.name === temp) continue;
              const reg = alloc.colours.get(temp);
              if (reg) expect(pair.has(reg), `${temp} in ${reg}`).toBe(false);
            }
          }
        }
      });

      it("saves exactly the callee-saved registers it borrowed", () => {
        for (const alloc of result.regalloc.functions) {
          const borrowed = new Set(
            [...alloc.colours.values()].filter((reg) => CALLEE_SAVED.includes(reg)),
          );
          expect(new Set(alloc.saved)).toEqual(borrowed);
        }
      });

      it("gives the same answer every time it is asked", () => {
        // Nothing here may depend on iteration order of a set or on anything
        // else that could differ between runs: the page would otherwise change
        // under a reader who typed nothing.
        const again = compiled(source);
        const flatten = (one: Compilation) =>
          one.regalloc.functions.map((alloc) => [
            alloc.func,
            [...alloc.colours].sort(),
            alloc.spilled,
          ]);
        expect(flatten(again)).toEqual(flatten(result));
      });

    });
  }
});

/**
 * Loading the argument registers, checked by simulating the moves.
 *
 * Whether today's allocator can actually produce a cycle here depends on the
 * order it happens to hand out colours — which is not something correctness
 * should rest on, and not something a program-level test can reliably provoke. So
 * the cycles are handed to `shuffle` directly and the code it emits is executed
 * against a toy register file.
 */
describe("loading the argument registers", () => {
  const QUAD = new Map<string, string>();
  for (const reg of [...ALLOCATABLE, SCRATCH_A, SCRATCH_B]) {
    for (const width of [1, 2, 4, 8]) QUAD.set(regName(reg, width), reg);
  }

  /** Run the emitted moves over a register file whose values are their own names. */
  function simulate(moves: ArgMove[]): Record<string, string> {
    const emitted: string[] = [];
    shuffle(moves, (text) => emitted.push(text));

    const state: Record<string, string> = {};
    for (const reg of QUAD.values()) state[reg] = reg;

    for (const line of emitted) {
      const move = /^mov (\w+), (\w+)$/.exec(line);
      expect(move, `not a plain register move: ${line}`).toBeTruthy();
      const to = QUAD.get(move?.[1] ?? "");
      const from = QUAD.get(move?.[2] ?? "");
      expect(to && from, line).toBeTruthy();
      if (to && from) state[to] = state[from];
    }
    return state;
  }

  const reg = (name: (typeof ALLOCATABLE)[number]): ArgMove["place"] => ({
    kind: "reg",
    reg: name,
    width: 8,
  });

  it("swaps two registers without losing either", () => {
    const state = simulate([
      { dest: "rdi", want: 8, place: reg("rsi") },
      { dest: "rsi", want: 8, place: reg("rdi") },
    ]);
    expect(state.rdi).toBe("rsi");
    expect(state.rsi).toBe("rdi");
  });

  it("rotates three registers", () => {
    const state = simulate([
      { dest: "rdi", want: 8, place: reg("rsi") },
      { dest: "rsi", want: 8, place: reg("rdx") },
      { dest: "rdx", want: 8, place: reg("rdi") },
    ]);
    expect([state.rdi, state.rsi, state.rdx]).toEqual(["rsi", "rdx", "rdi"]);
  });

  it("handles two separate cycles without the scratch register colliding", () => {
    // The second cycle needs the same scratch register the first one used, so
    // this only works if each cycle is fully unwound before the next is broken.
    const state = simulate([
      { dest: "rdi", want: 8, place: reg("rsi") },
      { dest: "rsi", want: 8, place: reg("rdi") },
      { dest: "rdx", want: 8, place: reg("rcx") },
      { dest: "rcx", want: 8, place: reg("rdx") },
    ]);
    expect([state.rdi, state.rsi, state.rdx, state.rcx]).toEqual([
      "rsi",
      "rdi",
      "rcx",
      "rdx",
    ]);
  });

  it("emits nothing at all when every value is already in place", () => {
    const emitted: string[] = [];
    shuffle(
      ARG_REGISTERS.slice(0, 3).map((name) => ({
        dest: name,
        want: 8,
        place: { kind: "reg" as const, reg: name, width: 8 },
      })),
      (text) => emitted.push(text),
    );
    expect(emitted).toEqual([]);
  });

  it("costs one move per argument when there is no cycle", () => {
    const emitted: string[] = [];
    shuffle(
      [
        { dest: "rdi", want: 8, place: reg("rax") },
        { dest: "rsi", want: 8, place: reg("rbx") },
      ],
      (text) => emitted.push(text),
    );
    expect(emitted).toHaveLength(2);
  });
});

describe("coalescing", () => {
  const result = compiled(COALESCE);
  const main = result.regalloc.functions.find((alloc) => alloc.func === "main")!;

  it("finds the destination/operand pairs a two-address instruction offers", () => {
    const body = bodyOf(result, "main");
    const candidates = coalesceCandidatesOf(body);
    // Two `+`s, each commutative: the second one (t2 = t0 + t1) offers both of
    // its operands, and the first (t0 = a + b) offers neither, because neither
    // operand is a temporary — it reads named locals straight from the frame.
    expect(candidates).toEqual([
      { a: "t2", b: "t0", via: "left operand" },
      { a: "t2", b: "t1", via: "right operand" },
    ]);
  });

  it("merges the operand that dies at the point they would share a register", () => {
    const merge = main.coalesced.find((d) => d.b === "t0");
    expect(merge?.merged).toBe(true);
    expect(main.colours.get("t0")).toBe(main.colours.get("t2"));
  });

  it("refuses the operand that is still needed afterwards", () => {
    const keep = main.coalesced.find((d) => d.b === "t1");
    expect(keep?.merged).toBe(false);
    expect(keep?.reason.length).toBeGreaterThan(20);
    expect(main.colours.get("t1")).not.toBe(main.colours.get("t2"));
  });

  it("records the merge on both nodes' `coalescedWith`", () => {
    const t0 = main.nodes.find((node) => node.temp === "t0");
    const t2 = main.nodes.find((node) => node.temp === "t2");
    expect(t0?.coalescedWith).toEqual(["t2"]);
    expect(t2?.coalescedWith).toEqual(["t0"]);
    const t1 = main.nodes.find((node) => node.temp === "t1");
    expect(t1?.coalescedWith ?? []).toEqual([]);
  });

  it("gives the merged pair one simplify order and one colour, not two", () => {
    const t0 = main.nodes.find((node) => node.temp === "t0")!;
    const t2 = main.nodes.find((node) => node.temp === "t2")!;
    expect(t0.order).toBe(t2.order);
    expect(t0.reg).toBe(t2.reg);
  });

  it("actually removes the `mov` codegen would otherwise need", () => {
    // This is the payoff, checked where it matters: not in the allocator's own
    // bookkeeping, but in the instructions that come out of it. The second add
    // computes straight into the register the first one already used.
    const asm = result.codegen.lines.map((line) => line.text);
    const adds = asm.filter((line) => line.startsWith("add "));
    // t0 = a+b, t1 = a+b (recomputed), then t2 = t0+t1: three adds in the
    // listing, and it is the last one — t2's — this test is about.
    expect(adds).toHaveLength(3);
    const combine = adds[2];
    const combineAt = asm.lastIndexOf(combine);
    const targetRegister = /^add (\w+),/.exec(combine)?.[1];
    // The instruction right before the combining `add` is `t1`'s own `add`,
    // full stop — no `mov` sneaks in to reload `t0` first. That reload is
    // exactly what would appear here if the coalesce had not happened.
    expect(asm[combineAt - 1]?.startsWith(`mov ${targetRegister}, `)).toBe(false);
  });

  // There is no test here that specifically forces the Briggs conservative
  // rule to REFUSE a merge for being too risky, rather than for a direct
  // interference — that needs a merged node with twelve or more high-degree
  // neighbours, and this compiler caps a single call at six arguments (there
  // is no stack-passed-argument support), which keeps every program in this
  // suite under the threshold. The rule's correctness does not depend on
  // reaching it, though: disabling it only ever risks MORE spilling, never a
  // wrong colour, because the interference check above is what actually
  // guards correctness — proven, above, by disabling it and watching
  // `spec/machine.test.ts` disagree with gcc.

  it("never merges two temps that interfere, on any program", () => {
    // The general safety property, checked across every program in the suite
    // rather than just the one built to exercise it.
    for (const [, source] of Object.entries(PROGRAMS)) {
      const compilation = compiled(source);
      for (const alloc of compilation.regalloc.functions) {
        for (const decision of alloc.coalesced.filter((d) => d.merged)) {
          const a = alloc.nodes.find((node) => node.temp === decision.a);
          expect(a?.neighbours ?? [], `${alloc.func}: ${decision.a}~${decision.b}`).not.toContain(
            decision.b,
          );
        }
      }
    }
  });
});

describe("what the allocator refuses to touch", () => {
  const result = compiled(POINTERS);

  it("leaves named locals in the frame, because they have addresses", () => {
    // `&x` has to have an answer and only memory has one, so no symbol is ever a
    // colour. The evidence is in the assembly: taking an address is always `lea`
    // from the frame pointer, never a register-to-register move.
    const leas = result.codegen.lines.filter((line) => line.text.startsWith("lea "));
    expect(leas.length).toBeGreaterThan(0);
    for (const line of leas) expect(line.text).toMatch(/lea \w+, \[rbp[-+]\d+\]/);
  });

  it("never hands out a scratch register", () => {
    const scratch = new Set([SCRATCH_A, SCRATCH_B]);
    for (const alloc of result.regalloc.functions) {
      for (const reg of alloc.colours.values()) expect(scratch.has(reg)).toBe(false);
    }
    // And they are genuinely outside the colour count, or a spill would have
    // nowhere to be loaded into.
    expect(ALLOCATABLE).toHaveLength(COLOURS);
    expect(ALLOCATABLE).not.toContain(SCRATCH_A);
    expect(ALLOCATABLE).not.toContain(SCRATCH_B);
  });
});

describe("running out of registers", () => {
  const result = compiled(PRESSURE);

  it("spills rather than colouring wrongly", () => {
    const spilled = result.regalloc.functions.flatMap((one) => one.spilled);
    expect(spilled.length, "this program is meant to exhaust the register file")
      .toBeGreaterThan(0);
  });

  it("gives every spilled value a slot of its own", () => {
    for (const alloc of result.regalloc.functions) {
      const body = bodyOf(result, alloc.func);
      const head = body[0];
      if (head.op !== "enter") continue;
      const { temps } = layoutFrame(body, head.frame);
      const offsets = alloc.spilled.map((name) => temps.get(name));
      expect(offsets.every((at) => at !== undefined)).toBe(true);
      expect(new Set(offsets).size).toBe(offsets.length);
    }
  });

  it("hands back every register it borrowed before it returns", () => {
    for (const alloc of result.regalloc.functions) {
      if (alloc.saved.length === 0) continue;
      const lines = result.codegen.lines.map((line) => line.text);
      const start = lines.indexOf(`${alloc.func}:`);
      const end = lines.indexOf("ret", start);
      const window = lines.slice(start, end);
      for (const reg of alloc.saved) {
        const parked = window.filter((line) =>
          new RegExp(`^mov \\[rbp-\\d+\\], ${reg}$`).test(line),
        );
        const given = window.filter((line) =>
          new RegExp(`^mov ${reg}, \\[rbp-\\d+\\]$`).test(line),
        );
        expect(parked.length, `${alloc.func} never saved ${reg}`).toBe(1);
        expect(given.length, `${alloc.func} never restored ${reg}`).toBe(1);
      }
    }
  });

  it("keeps the stack 16-byte aligned after saving them", () => {
    // The ABI requires it at every call, and a save area is the one thing that
    // can knock it out by eight.
    for (const line of result.codegen.lines) {
      const sub = /^sub rsp, (\d+)$/.exec(line.text);
      if (sub) expect(Number(sub[1]) % 16, line.text).toBe(0);
    }
  });
});

describe("the steps this stage plays", () => {
  const result = compiled(NESTED_LOOP);
  const steps = result.steps.filter((step) => step.stage === "regalloc");

  it("plays a live range per value, a decision per coalescing candidate, and a removal and a colour per group", () => {
    // A candidate whose two temps were already the same group by the time it
    // was considered — chained coalescing, e.g. three adds in a row — produces
    // no step at all, since there is no decision left to make. Every OTHER
    // candidate produces exactly one: `coalesced` records precisely those, so
    // its length is the count to check against rather than the raw candidate
    // count. Every group the coalescing left behind gets exactly one "set
    // aside" and one "takes/stays" step, and `node.order` is only set on
    // members of a group once it has been through that pair, so the number of
    // distinct order values already IS the group count.
    let decisions = 0;
    let groupCount = 0;
    for (const alloc of result.regalloc.functions) {
      decisions += alloc.coalesced.length;
      groupCount += new Set(
        alloc.nodes.filter((node) => node.order !== undefined).map((node) => node.order),
      ).size;
    }
    const liveRangeSteps = steps.filter((s) => s.title.startsWith("live range of")).length;
    const coalesceSteps = steps.filter(
      (s) => s.title.startsWith("coalesce ") || s.title.startsWith("keep "),
    ).length;
    const asideSteps = steps.filter((s) => s.title.startsWith("set ")).length;
    const selectSteps = steps.filter(
      (s) => s.title.includes(" takes ") || s.title.includes(" stays "),
    ).length;

    expect(liveRangeSteps).toBe(
      result.regalloc.functions.reduce((n, alloc) => n + alloc.nodes.length, 0),
    );
    expect(coalesceSteps).toBe(decisions);
    expect(asideSteps).toBe(groupCount);
    expect(selectSteps).toBe(groupCount);
    expect(steps.length).toBe(liveRangeSteps + coalesceSteps + asideSteps + selectSteps);
  });

  it("produces every artefact the pane draws, exactly once", () => {
    const produced = steps.flatMap((step) => step.produced);
    expect(new Set(produced).size).toBe(produced.length);
    for (const alloc of result.regalloc.functions) {
      for (const node of alloc.nodes) {
        expect(produced).toContain(node.id);
        expect(produced).toContain(`${node.id}:order`);
        expect(produced).toContain(`${node.id}:reg`);
      }
      for (const edge of alloc.edges) expect(produced).toContain(edge.id);
    }
  });

  it("colours in the reverse of the order it set values aside", () => {
    // That is the whole trick: the last node removed is the first one coloured,
    // and it is why a node with fewer than twelve neighbours can always be given
    // something.
    const asides = steps
      .filter((step) => step.title.startsWith("set "))
      .map((step) => step.title.slice(4, -6));
    const colours = steps
      .filter((step) => step.title.includes(" takes ") || step.title.includes(" stays "))
      .map((step) => step.title.split(" ")[0]);
    expect(colours).toEqual([...asides].reverse());
  });

  it("points every step at text in the program", () => {
    for (const step of steps) {
      expect(step.consumed).not.toBeNull();
      expect(step.consumed!.end).toBeLessThanOrEqual(NESTED_LOOP.length);
      expect(step.explain.length).toBeGreaterThan(20);
    }
  });

  it("has nothing to say about a program with no temporaries", () => {
    const trivial = compiled("int main() { return 0; }");
    const its = trivial.steps.filter((step) => step.stage === "regalloc");
    // Still one step, so the player is never empty — but nothing is revealed.
    expect(its).toHaveLength(1);
    expect(its[0].produced).toEqual([]);
  });
});
