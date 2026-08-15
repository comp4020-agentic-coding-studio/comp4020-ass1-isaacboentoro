# COMP4020 prototype

This is your starter repo for a COMP4020 prototype: a static site written in
HTML/CSS/TypeScript that builds to plain HTML/CSS/JS and deploys to GitHub
Pages. The **deployed site is what gets marked** --- not this repo, and not "it
works on my machine". It's marked live in Chrome against the deployed URL at two
viewports --- 1920×1080 (desktop) and 390×844 (phone) --- and both count in
full, so make that artefact good at both and use the checks below to know
whether it is.

The course website publishes this deliverable's brief and spec. The brief poses
the problem; the spec is the fixed contract every response must satisfy. This
repo's name tells you which deliverable applies. Run the course plugin's
**start** skill at the start of each week: it pulls the right spec from the
course API, carries your harness forward from last week, and helps you turn the
spec's checkable lines into tests of your own. Read the brief and spec before
you plan or build, and see `spec/README.md` for how the checks relate to them.

### Writing paragraphs in websites

When writing paragraphs or text, try to keep it short and boilerplate so I can expand on it instead.

## This prototype: rules the work has to hold to

The site is one interactive explainer of C compilation. Its whole design rests on
these, and each one is here because breaking it cost me something.

- **Every stage emits `Step[]`, not just a final artefact.** A stage that returns
  only its output cannot be scrubbed through and cannot explain itself. Steps are
  emitted as the work happens, never reconstructed afterwards.
- **Each stage is its own player, and its steps are numbered locally.** A stage's
  step 3 is the third thing THAT stage did. Six cursors, six sliders, six play
  buttons; a stage never reads another stage's cursor. Scrubbing one stage must
  leave the other five untouched — there is a test for exactly that.
- **A stage view is a pure function of that stage's cursor.** Panes are built once
  per compile and then only have classes toggled; if rendering ever needs to know
  what the previous cursor was, the design has gone wrong.
- **Unrevealed artefacts use `visibility: hidden`, never a low opacity.** It keeps
  the space reserved so nothing jumps, and it keeps text that has not been
  produced yet out of the accessibility tree. Dimming instead left 53 elements of
  unreadable text on the page as far as axe was concerned, and axe was right.
- **Two hiding rules, on purpose.** `data-reveal` reserves an artefact's space
  (`visibility`), which is what stops a listing jumping line by line.
  `data-grow` collapses a container entirely (`display: none`) until the earliest
  step anywhere inside it. The tree uses growth so it grows instead of filling in
  a skeleton; the listings use reservation. A container stamped `data-grow` is
  structure, so it never wears the current-step marker.
- **"It grows" is a claim about layout, so test layout.** Counting classes cannot
  see a fixed skeleton. `pnpm shoot` measures the parse tree's height at three
  cursors and fails unless it increases.
- **A pane's box never changes size while it plays.** `reserveHeights()` in
  `app.ts` measures each pane's fully-revealed height once per compile and pins it
  as `min-height`, capped by the CSS `max-height`. Content grows inside a box that
  does not move; without it, the tree pushed everything below it down by 223px over
  a play and the whole page felt like jitter. Anything with per-step text — the
  commentary, the step counter — gets a reserved size in CSS for the same reason.
  `pnpm shoot` fails if any stage section reports two different heights.
- **Prove a new check can fail before trusting it.** The first version of the
  jitter check compared two fully-revealed states, so it measured nothing and
  passed on the broken build. Comment the fix out, watch the check go red, put it
  back. A check that cannot fail is worse than no check, because it reads as
  evidence.
- **A step whose span covers most of the file highlights nothing.** Painting every
  line yellow is noise. Where a step really is about the whole file, the
  commentary carries it — and prefer a narrow span in the first place: the
  analyser points at a function's name, not its body.
- **Motion is short, and only opacity and transform.** 120ms for state, 170ms for
  something coming into existence, one easing curve in `--ease`. Never animate a
  property that costs a layout, and never bounce — brutalism can move, it should
  not spring. `display` cannot be transitioned, so growth is a keyframe that runs
  when the class lands.
- **Every duration must die under `prefers-reduced-motion`.** The switch is
  wholesale (`*, *::before, *::after`) so a transition added later cannot escape
  it by accident, and `pnpm shoot` asks the browser to confirm it: it emulates the
  preference and fails if anything still animates for longer than 50ms.
- **The accent colour means "here" and nothing else.** The current step and the
  source it is reading. Never decoration, never a third meaning. Square corners,
  thick rules, monospace: if a change would soften the page, it is wrong.
- **Layout in CSS, state in JavaScript.** Never resize or reflow by script. The
  marker resizes mid-interaction, and the cursor has to survive it.
- **Every artefact's span points into the original source.** Not the preprocessed
  text, not an intermediate. Macro-generated text resolves to its call site.
  `spec/compiler.test.ts` asserts this; it is the contract the highlight rests on.
- **No stage throws. Stages return a `Diagnostic`.** Bad input is content, not a
  crash: the failing stage explains itself and later panes say they were never
  reached.
- **Out-of-subset C gets a named error, never a crash and never silence.** Pointer
  subtraction, `&array`, two array dimensions and function pointers are all
  refused by name, with a hint saying why. Silence or a crash would both be worse
  than a diagnostic that admits the edge.
- **Never `innerHTML` in `src/ui/`.** The source text is visitor input. Build
  nodes and set `textContent`.
- **Simplifications are stated on the page, not just in comments.** No register
  allocator, no assembler, no linker, no structs, no bounds checking. The
  `#limits` section is part of the deliverable and `spec/page.test.ts` checks it
  is still there.
- **A type knows its size, and only `ctypes.ts` decides what that is.** `p + 1`
  moves four bytes or one depending on the pointee, `a[i]` scales by the element,
  and a frame slot is as big as the thing in it. Nothing else in the compiler may
  hard-code 4.
- **Lvalues and values are separate lowering paths.** `lowerAddress` produces a
  place, `lowerExpr` produces a value, and the difference between `x = 1` and
  `*p = 1` lives entirely in which one gets called. Collapsing them is how pointer
  support turns into pointer bugs.
- **`a[i]` lowers to the multiply and the add, never to one opaque step.** The
  element size is the lesson; hiding it in an addressing mode would waste the only
  stage where it is visible.
- **Say what a stage really consumes.** Only the preprocessor reads your source;
  the scanner reads preprocessed text, the parser reads tokens, and lowering walks
  the syntax tree. `stages.ts` holds the in/out pairs the page shows, and
  `spec/compiler.test.ts` checks everything a stage consumes was produced by an
  earlier one — plus that every IR instruction's span matches an AST node's, which
  is the evidence lowering really did walk the tree. The source echo beside each
  stage is provenance, not input, and it is labelled as such.
- **What a stage reads stays on screen while it plays.** On a wide screen the
  left column — source echo and grammar — is sticky and capped to the viewport,
  with the rule list scrolling inside it, so the production being applied is
  never off screen at the moment it matters. `pnpm shoot` walks every parse step
  and fails if the marked rule leaves view.
- **Scroll a box with rects, never `offsetTop`.** `offsetTop` is measured from the
  nearest *positioned* ancestor, which these boxes are not, so the arithmetic
  silently targets the wrong origin. Use `getBoundingClientRect` deltas. And never
  `scrollIntoView`, which moves the page and drags the reader away from the stage
  they were watching.
- **The grammar on the page is data, and a test keeps it true.** `grammar.ts`
  holds the productions the page shows; every scan and parse step names one of
  them, and `spec/compiler.test.ts` fails if a step names a rule that does not
  exist OR if a listed rule is never applied. Both directions matter — an unused
  rule is one that has drifted from the code, and a wrong grammar shown
  confidently is worse than no grammar. The same test rejects any left-recursive
  production, because a top-down parser cannot implement one.
- **String tests cannot see a wrong `setcc` or a wrong stride.** `spec/machine.test.ts`
  assembles the emitted code with real gcc, runs it, and compares the exit status
  against a binary gcc built from the same source. Add a program to
  `spec/programs/` whenever the compiler learns something new. It skips where gcc
  is missing, so read the skip rather than assuming it ran.
- **Presets are load-bearing.** Nobody types C on a 390px phone, so every preset
  must compile (except the one deliberately named "A mistake"), and
  `spec/interaction.test.ts` compiles all of them.
- **Don't parenthesise macro arguments.** Textual substitution is the behaviour
  and the trap is the teaching point. There is a test pinning this.

## How to work in here

- Keep the dev server running (`pnpm dev`) so you see changes as you make them.
- Before you push, run `pnpm check`. It runs most of what CI runs --- build,
  lint, and the spec --- so you catch those in seconds instead of waiting for
  the pipeline. The links check, the evidence check, the secrets scan, and the
  deploy itself only run in CI; run
  `pnpm dlx linkinator ./dist --silent --skip "^https?://(?!localhost|127)"`
  locally against a fresh `pnpm build` for the links check without waiting for
  CI.
- **Run `pnpm shoot` before believing the page works.** It builds nothing itself,
  so `pnpm build` first. It serves `dist/`, drives real Chromium at 1920×1080 and
  390×844, and fails on: any console or page error, a stage player that changes
  nothing, a stage that leaks into another, a stage that never highlights source,
  arrow/Home keys not moving a cursor, a resize losing the cursors, a stage section
  missing, horizontal overflow, a failing program that shows no diagnostic, any
  serious or critical axe violation, and a gzipped bundle over 60kB. Screenshots land in `.screens/` — look at them.
  This is local-only (it needs a system Chromium), so it is deliberately not part
  of `pnpm check`, which has to keep working in CI.
- To see what the page actually looks like rather than what you assume it looks
  like, open it in a browser (the `agent-browser` CLI, documented on
  [the course site](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/topics/backpressure/#agent-browser-the-rendered-page-as-ground-truth),
  works well for this). The rendered page is the truth; your mental model of it
  isn't.
- When a check fails, read its output before changing anything. Each check below
  names what it measures, and the failure message is the instruction: it tells
  you the file, the line, or the contract. Treat a red check as authoritative
  --- the page is wrong until the check is green, not until you decide it should
  be.
- Commit when the checks pass. Never commit a red state.

## The checks (your sensors)

CI runs these on every push once your repo is public. GitHub's checks UI shows
two jobs, `check` and `deploy` --- not one status per sensor below --- and
within `check` the steps run in sequence (`pnpm check` chains typecheck, build,
lint, and the spec with `&&`), so an early failure like a broken build stops the
later sensors from running for that push; fix it and push again to see the rest.
While the repo is private (all week, until you ship) the CI jobs stay skipped
--- `pnpm check` is the same roster on your machine, and it's the faster loop
anyway. They aren't hoops. Each is a different way of finding out something true
about the site that you can't reliably see by looking at it.

They also carry a mark at a crit: the sweep runs fifteen minutes after your
cutoff, and green checks there are worth half that week's shipped mark. Still
running counts as not green, so ship with time for CI to finish.

- **typecheck** --- `tsc --noEmit` runs first in `pnpm check`, so a type error
  stops the roster before the build even starts. The types are extra
  backpressure: a red here is the compiler telling you a claim in the code is
  false.
- **build** --- the site must build (`pnpm build`). A build failure means the
  deployed site is broken or stale, so nothing else matters until this is green.
- **deploy / online** --- the live GitHub Pages URL must load and return the
  page you expect. An asset that 404s on the deployed URL counts as broken even
  if it loads locally.
- **spec** --- `spec/invariants.test.ts` asserts what's true of any good
  website, whatever the week's brief asks; the tests you write for the week's
  spec run alongside it (any `spec/*.test.ts`). A failure names the contract you
  haven't met yet.
- **lint** --- `stylelint` for CSS, `oxlint` for TypeScript. Flags code that's
  wrong, fragile, or non-idiomatic. Read the rule it names.
- **tests** --- any other tests you write, wherever you put them (co-located
  with your source is fine, not just `spec/`), must pass. Vitest picks up both
  this and the spec suite in one `vitest run`, the last step of `pnpm check`. A
  failing test is a claim about the site that's no longer true.
- **evidence** (`pnpm check:evidence`) --- checks your process evidence:
  `PROCESS.md`'s citations resolve to real commits, the current deliverable's
  exact reflection is in `reflections/` (worked out from this repo's name
  against the public course API), and your `CLAUDE.md` is present. Evidence
  gates the deploy --- `deploy` needs `check` to pass, so failing evidence
  blocks the deploy alongside everything else. See
  [Your process is part of the mark](#your-process-is-part-of-the-mark) below,
  and the course website's
  [assessment page](https://comp.anu.edu.au/courses/comp4020-agentic-coding-studio/topics/assessment/#what-you-submit)
  for what counts as evidence.
- **links** --- internal links must resolve. A broken link is a dead end you
  didn't mean to ship. Links off your site aren't checked, so that a third
  party's rate limiter can't decide whether your site ships --- a dead outbound
  link is yours to catch.
- **secrets** --- the repo is scanned for committed credentials. Never put a
  key, token, or password in a tracked file. If one leaks, rotate it. A local
  pre-commit hook (`.githooks/pre-commit`, installed by `pnpm install`) also
  blocks any commit containing something shaped like an API key --- by the time
  CI sees a key it's already pushed, so the hook is the sensor that matters.

Nothing here measures **accessibility** or **performance** --- wiring those
sensors (`axe-core`, Lighthouse, or whatever you choose) is your work, and later
in the course the spec will ask you to show how you tested both. When you do,
read a green performance result honestly: it's a lab estimate from one run on a
CI machine, not proof the site is fast for real users.

## The stack is swappable

This repo runs on Astro (`src/pages/*.astro` are pages, `astro build` emits
`dist/`) --- carried forward from last week, not this week's template default,
because nothing in CI names a tool. The whole contract is:

- `pnpm build` emits the complete site into `dist/`
- the `package.json` scripts (`check`, `check:evidence`, `build`) keep working
- whatever lands in `dist/` still passes the invariants in `spec/`

Two things bite in a swap. The deployed site lives under a path
(`…github.io/<repo>/`), so configure your generator's base path --- Astro needs
`base` set explicitly in `astro.config.mjs`, and getting it wrong looks fine
locally while every asset 404s on the live URL. And commit the updated
`pnpm-lock.yaml`: CI installs with `--frozen-lockfile`.

Don't wire a future swap by hand: the course plugin's `stack` skill runs a
tested conversion script that handles both of the traps above plus the CI
link-check patch, and leaves the whole change staged as one reviewable diff.

## Your process is part of the mark

The deployed page is only half of it. How you got there is marked too: your
commit history, your agent files, and the decisions visible across them. The
checks above can't see any of that, so a person reads it directly --- which
means building legibly is part of building well.

- **Commit as you go.** Small, frequent commits are the record of how the work
  came together, and that record is read, not just the final state. A trail that
  grew alongside the code is the strongest evidence of your process; a single
  dump the night before is the weakest.
- **Keep a process overview** (`PROCESS.md`). A short reading-guide, not an
  essay: what you built, the moments that mattered --- each pointing at a
  commit, a `CLAUDE.md` change, or a prompt and the commit it produced --- and
  where to look in the history. It points a marker at the evidence; it doesn't
  stand in for it, and claims the history doesn't back don't count. The
  `PROCESS.md` in this repo is a template showing the shape and the citation
  format (link text the commit hash or range, target the commit or compare URL);
  `pnpm check:evidence` verifies your citations resolve to real commits before
  you ship. Markers follow those citations and don't trawl the repo for evidence
  you didn't cite.
- **Write your reflection in `reflections/`** --- a short markdown file in this
  repo, named for the deliverable it answers, so the number in the filename is
  the number in this repo's name (`crit-1.md` in `comp4020-crit1-<you>`,
  `assignment-1.md` in `comp4020-ass1-<you>`); `reflections/README.md` has the
  full rule. `pnpm check:evidence` checks the exact current name against the
  course API, not merely the presence of any well-named file. It answers the two
  standing prompts: the breakthrough that moved the work forward, and what this
  work changed about the developer you want to be. It stays out of the deployed
  site. It's due at the cutoff, and if it isn't in the repo by then the week
  doesn't count as shipped, however good the prototype is.
- **This file is process evidence.** The harness you build to direct the work,
  this `CLAUDE.md` and any `AGENTS.md`, is itself read as part of how you
  worked. Keep it honest and current (see below).

You don't need a name, a student number, or any identity file in the repo: we
know whose repo it is. Spend the effort on the work.

## This file is yours

This CLAUDE.md is a starting point, not a fixed rulebook. As you learn what your
prototype needs --- a convention the work has to hold to, a sensor that keeps
catching you out, a fact about the stack that's easy to get wrong --- write it
down here. Growing this file is the work of harness engineering, and the gap
between this boilerplate and your own version is part of what your prototype
says about the developer you're becoming.
