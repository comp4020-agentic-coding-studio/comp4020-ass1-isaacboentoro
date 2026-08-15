# Compiling C, explained

An interactive explainer. Type C into the page, then play any of the six stages —
preprocessing, scanning, parsing, semantic analysis, lowering to three-address IR,
and x86-64 assembly — and watch it do its work one step at a time. Each stage is
its own section with its own player, showing the source it is reading beside what
it produced.

A seventh section runs the result — the three-address IR, interpreted, on the same
frame layout the assembly addresses. Not the assembly itself: that is text, and
there is no processor on the page. `spec/machine.test.ts` checks all three agree
— our assembly built by gcc, gcc's own build, and the interpreter.

The parser is hand-written recursive descent with precedence climbing for
expressions — one function per grammar rule, chosen by the next token — and the
page shows that grammar beside the tree, marking each production as it is applied.

The compiler is written from scratch in TypeScript and runs in the browser. There
is no server, no wasm toolchain, and no network call — the whole thing is 18.7kB
gzipped.

The point it argues: compiling is not one translation. It is a sequence of small
rewrites, and each one throws away something the last one needed.

COMP4020 Assignment 1. The deployed page is the deliverable; `PROCESS.md` is the
reading guide to how it was built, and `reflections/assignment-1.md` is the
reflection.

## Layout

- `src/compiler/` — the compiler. One module per stage, all pure functions, no DOM.
  Every stage returns its artefacts **and** a `Step[]` describing what it did; that
  step trace is what the page plays back. `ctypes.ts` is the only thing that
  decides how big a type is; `grammar.ts` holds the productions the page shows,
  which every scan and parse step names; `frames.ts` is shared by codegen and the
  interpreter so both agree where a variable lives.
- `src/ui/` — the page. `app` owns the six per-stage players, `panes` builds the
  six views, `reveal` holds the one visibility rule and the local step numbering.
- `src/pages/index.astro`, `src/styles/global.css` — the shell and the layout.
- `spec/` — `invariants.test.ts` (shipped, untouched), `compiler.test.ts` (stage
  contracts), `interaction.test.ts` (the core interaction, as a property and driven
  in jsdom), `page.test.ts` (what has to be true of the built HTML),
  `machine.test.ts` (assemble with gcc and compare exit codes against it, using
  the programs in `spec/programs/`).
- `scripts/shoot.ts` — drives real Chromium at both marking viewports.

## Commands

```sh
pnpm install
pnpm dev              # local dev server
pnpm check            # typecheck, build, lint, and every test — what CI runs
pnpm build            # produce dist/
pnpm shoot            # build first: real Chromium at 1920x1080 and 390x844,
                      # axe-core, keyboard, resize, bundle budget, screenshots
pnpm check:evidence   # PROCESS.md citations, reflection, CLAUDE.md
pnpm dlx linkinator ./dist --silent --skip "^https?://(?!localhost|127)"
```

`CLAUDE.md` carries the rules this prototype has to hold to, and why each one is
there.

## The C subset

`int`, `char`, `void`; locals; arithmetic and comparison; `if`/`else`, `while`,
`for`, `break`, `continue`; functions with parameters, calls and recursion;
`#define` (object- and function-like) and comments. Pointers and arrays:
`&x`, `*p`, `a[i]`, `int *p`, `int a[10]`, array parameters that decay, pointer
arithmetic scaled by the element size, and the null pointer constant.

Deliberately absent, and said so on the page: structs, floats, strings, bitwise
operators, pointer subtraction, `&array`, more than one array dimension, function
pointers, `#include`, the standard library, register allocation, bounds checking,
the assembler and the linker.

The emitted assembly is real: `gcc` assembles it, and `spec/machine.test.ts`
builds and runs ten programs on every check, comparing each exit status against a
binary gcc built from the same source.
