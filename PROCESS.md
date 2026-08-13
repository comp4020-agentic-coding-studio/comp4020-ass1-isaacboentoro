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

**Cutting scope, then earning it back.** My plan had pointers and arrays. Costing
them out — C's declarator grammar, array-to-pointer decay, lvalue-versus-rvalue in
the IR — against a rubric that is 45% process and 20% artefact, I dropped them and
shipped without. The call was that a smaller compiler that is *right* beats a
larger one that half-works, and I made the gap visible rather than quiet: a
`#limits` section, a `CLAUDE.md` rule, and a test that fails if the caveats leave
the page ([`faf738c`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-isaacboentoro/commit/faf738c)). With three days left I
added them after all — but only once I had built the check that made it safe to,
below. Both halves were the same judgement: what can I verify?

**A test that found a design error, not a typo.** Writing the frame-layout test I
expected `sub rsp, 16` and got 32: the analyser aligned the frame, then codegen
added the temporaries lowering had invented and aligned again. The easy fix was to
change the assertion. Instead I moved the responsibility — the analyser reports the
bytes for the names you wrote, and codegen, the only stage that knows how many
temporaries exist, sizes and aligns once
([`ed9ed23`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-isaacboentoro/commit/ed9ed23)). The number in the assembly is now
derivable from the pane above it.

**Building a sensor instead of re-prompting.** 139 passing tests said the page
worked. It did not: at 390px no pane rendered at all. Rather than patch and move
on, I wrote `pnpm shoot`, which drives real Chromium at both marking viewports
([`565478c`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-isaacboentoro/commit/565478c)). It found the bug — `is-active`
was going on the scrolling body, not the section the phone layout hides — plus a
favicon 404 nobody had noticed. Extending it to what CI does not measure (axe,
arrow keys, resize, a gzip budget) immediately turned up another: the pane bodies
scroll and had no keyboard route in
([`a29a324`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-isaacboentoro/commit/a29a324)).

**A check that made a rejected feature affordable.** Adding pointers meant widths,
addresses and index scaling — the class of bug no string comparison catches. A
`setl` that should be `setg`, a stride of 4 on a char array, a frame offset four
bytes out: every one of those passes a test that compares listings. So before
trusting any of it I wrote `spec/machine.test.ts`, which assembles the emitted
code with real gcc, runs it, and compares the exit status against a binary gcc
built from the same source — ten programs covering decay, pointer walking,
pointer-to-pointer and char widths
([`4d711a3`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-isaacboentoro/commit/4d711a3)). I checked it could fail before
believing it: forcing the element size to 4 makes the char program segfault and
the check goes red. That is the only reason a feature I had deliberately refused
became a safe thing to build in the time left.

## Where to look

[`fac83de...4d711a3`](https://github.com/comp4020-agentic-coding-studio/comp4020-ass1-isaacboentoro/compare/fac83de...4d711a3)
is the build in order: compiler stages first, each committed green, then the page,
then the spec tests, then the sensors, then pointers once the sensors could vouch
for them. Nothing was committed red.
