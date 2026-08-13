# Assignment 1

## The breakthrough

Making every compiler stage emit a `Step[]` instead of just its output.

I started to build this as six views of six artefacts — a token list, a tree, an IR
listing — and it was dead. Output does not explain anything, because the interesting
part of compiling is not what a stage produces but the order in which it decides
things. So I changed the shape: every stage logs each thing it did, what source text
it was looking at, and which artefacts came into existence because of it.

Everything else fell out of that one decision. A player is just an index into that
array, so a stage's view is a pure function of one integer and rendering has no
history to get wrong. Splitting the page into six independent players later cost
almost nothing, because the trace was already per-stage underneath. And the parser
announcing itself bottom-up for expressions and top-down for statements is not
something I designed — it is what the trace shows.

## What it changed about me

I've been treating tests as proof that code works. Twice this week they were
better than that: an assertion about stack-frame size found a design error, not a
typo, and I moved a responsibility between stages rather than editing the number.

The sharper lesson was that a green suite is not a green page. 139 tests passed
while the phone viewport rendered nothing at all. What fixed that permanently was
not the one-line patch but an hour spent building a sensor that drives a real
browser and fails on things I would never think to check by hand. I want to be the
developer who reaches for a new instrument when the existing ones cannot see the
problem, rather than the one who squints harder at the same dials.
