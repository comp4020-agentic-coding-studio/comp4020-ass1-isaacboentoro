# Process overview

## What I built

A one-page interactive explainer of what compiling C actually does. You type C
into an editor and each of six stages plays its own work back, step by step:
preprocessing, scanning, parsing, semantic analysis, lowering to
three-address IR, and x86-64 assembly. The compiler is mine, written in
TypeScript and running in the visitor's browser — no wasm, no server. The idea
the page argues for is that compiling is not one translation but a sequence of
small rewrites, each throwing away something the last one needed.

## The moments that mattered

**Cutting the scope before writing a line.** My plan had pointers and arrays in
the C subset. Working out what that cost — C's declarator grammar, array-to-pointer
decay, lvalue-versus-rvalue in the IR — against a rubric that is 45% process and
20% artefact, I dropped them. The obvious move was to keep them and hope; the call
I made was that a smaller compiler that is *right*, plus a day spent on the
interaction, scores better than a large one that half-works. To stop that becoming
a quiet omission I made it visible in three places: a `#limits` section on the
page, a rule in `CLAUDE.md`, and a test that fails if the caveats leave the page
([`faf738c`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-isaacboentoro/commit/faf738c)).

**A test that found a design error, not a typo.** Writing the frame-layout test I
expected `sub rsp, 16` and got 32. The analyser was aligning the frame to 16
bytes, then codegen added the temporaries lowering had invented and aligned again.
The easy fix was to change the assertion. Instead I moved the responsibility: the
analyser now reports the bytes for the names you wrote, and codegen — the only
stage that knows how many temporaries exist — sizes and aligns once
([`ed9ed23`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-isaacboentoro/commit/ed9ed23)).
I knew it had taken because the same commit's tests pin both halves, and the
number in the assembly is now derivable from the pane above it.

**Building a sensor instead of re-prompting.** 139 passing tests said the page
worked. It did not: at 390px no pane rendered at all. Rather than fix it and move
on, I wrote `pnpm shoot` — it serves `dist/`, drives real Chromium at both marking
viewports, and fails on console errors, a scrubber that reveals nothing, a missing
highlight, or the wrong number of visible panes
([`565478c`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-isaacboentoro/commit/565478c)).
It found the bug (`is-active` was going on the scrolling body, not the section the
phone layout hides) and a favicon 404 riding along unnoticed. I then extended it
to the things the course CI does not measure — axe-core, arrow and Home keys, the
cursor surviving a resize, an 18.7kB gzipped budget — and axe immediately found a
real defect: the pane bodies scroll and had no keyboard route in
([`a29a324`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-isaacboentoro/commit/a29a324)).

**Throwing away my own safety hack.** A preset would not compile: `DOUBLE(SIZE)`
left `SIZE` behind, because expansion output was never rescanned. Fixing that
surfaced a worse decision underneath — I had been wrapping macro arguments in
parentheses "for safety", which quietly erased the classic macro precedence trap
this page exists to show. Substitution is now textual, as C's is, and a test pins
`TWICE(1) * 3` becoming `1 + 1 * 3`
([`faf738c`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-isaacboentoro/commit/faf738c)).

## Where to look

[`fac83de...a29a324`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-isaacboentoro/compare/fac83de...a29a324)
is the build in order: compiler stages first, each committed green, then the page,
then the spec tests, then the sensors. Nothing was committed red.
