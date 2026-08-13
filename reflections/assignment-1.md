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

I had been treating tests as proof that code works. This week they were better
than that twice over. An assertion about stack-frame size found a design error
rather than a typo, and I moved a responsibility between stages instead of editing
the number. Then 139 green tests told me the page worked while the phone viewport
rendered nothing at all — which is when I stopped patching and spent an hour
building a sensor that drives a real browser.

The part that changed how I think came last. I cut pointers and arrays on day one
because I could not verify them in the time I had. With three days left I added
them, but only after writing a check that assembles the output with gcc and runs
it, so correctness stopped being something I argued for and became something I
measured. The instrument did not only catch bugs; it changed what I could afford
to attempt. I want to be the developer who builds a new instrument when the
existing ones cannot see the problem, rather than the one who squints harder at
the same dials.
