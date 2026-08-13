# Assignment 1

## The breakthrough

Making every compiler stage emit a `Step[]` instead of just its output.

I started to build this as six views of six artefacts — a token list, a tree, an
IR listing — and it was dead. Six boxes of output do not explain anything, because
the interesting part of compiling is not what each stage produces, it is the order
in which it decides things. So I changed the shape: every stage logs each thing it
did, what source text it was looking at, and which artefacts came into existence
because of it. The pipeline concatenates those logs into one flat array.

Everything else fell out of that one decision. The scrubber is an index into the
array, so the page is a pure function of a single integer and rendering has no
history to get wrong. The parser announcing itself bottom-up for expressions and
top-down for statements is not something I designed — it is what the trace shows,
and it turned out to be the most interesting thing on the page.

## What it changed about me

I've been treating tests as proof that code works. Twice this week they were
better than that: an assertion about stack-frame size found a design error, not a
typo, and I moved a responsibility between stages rather than editing the number.

The sharper lesson was that a green suite is not a green page. 139 tests passed
while the phone viewport rendered nothing at all. What fixed that permanently was
not the one-line patch, it was spending an hour building a sensor that drives a
real browser at both viewports and fails on things I would never think to check by
hand. I want to be the developer who reaches for a new instrument when the existing
ones can't see the problem, rather than the one who looks harder at the same dials.
