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
  step 3 is the third thing THAT stage did. Seven cursors, seven sliders, seven
  play buttons; a stage never reads another stage's cursor. Scrubbing one stage
  must leave the other six untouched — there is a test for exactly that.
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
- **Syntax colour is the one other use of hue, and it gets out of the accent's
  way.** `highlight.ts` classifies the ORIGINAL source — comments and directives
  included, which is why it cannot be `scan()`, since both are gone by the time
  the scanner runs — and its keyword set is imported from the lexer so the page
  can never colour a word as reserved that the compiler treats as a name.
  Identifiers are left uncoloured on purpose. Inside a `mark`, tokens inherit the
  accent's colour rather than setting their own, so "here" stays one colour and
  the text stays readable on yellow. Every syntax colour clears 4.5:1 on black;
  `pnpm shoot`'s axe pass is what says so.
- **A palette is data, and `palettes.ts` is the only place colour values live.**
  `global.css` names tokens and never sets a hex; the palettes are emitted into
  the document head at build time, so the first paint is already the right
  colours and there is one source of truth rather than blocks scattered through
  the stylesheet. A palette is one attribute on `<html>`: switching it restyles
  all seven stages without touching a pane or moving a cursor.
- **Borrowed palettes get checked, not trusted.** Upstream colours are tuned for
  an editor, not for body text on a page: Dracula's comment is 3.0:1 on its own
  background, Tokyo Night's 2.8:1. Each is nudged along its own hue until it
  clears 4.5:1, and the comment above every variant says which token moved and
  from what. `spec/palettes.test.ts` re-derives every ratio — text on background,
  ink on background, whatever sits on the accent — so adding a palette means
  adding it and reading the failures. `pnpm shoot` then wears every palette in
  both modes and runs axe on the real page, which is what caught the one thing
  the token test could not see: `code` chips filled with `--dimmer` put text on a
  pair no test was checking, and it came in under 4.5:1 in three light palettes.
  Chips are bordered now, so their text sits on the page's own background.
- **Two themes, so two sets of contrast ratios.** `--accent` is the highlight
  fill, `--accent-ink` is the accent used as text or border (it darkens on white,
  since a yellow letter there is invisible), and `--on-accent` is what sits ON
  the fill — black in both modes. Writing `color: var(--bg)` on an accent
  background is the bug that keeps coming back: it reads black in dark mode and
  white-on-yellow in light. `pnpm shoot` presses the real toggle and runs axe a
  second time, which is how both light-mode failures were found rather than
  guessed at. Colours transition, so it waits for the fade before measuring —
  axe reads whatever is on screen at that instant, half-way colours included.
- **The dock floats at the edges but never over the content.** It is a slab inset
  on all four sides with a hard offset shadow — no blur, this page casts shadows
  like a woodblock or not at all. Floating is about the edges: `--dock`
  (`--dock-height` plus both gaps) still comes out of `body` padding and the
  sticky stage column, so the last caveat never ends up underneath it.
  `pnpm shoot` fails if the bar is flush with the bottom *or* more than a gap
  away from it, which is the check that says "floating" rather than "fixed".
- **At a seam, "here" is the section you have arrived in.** Two sections can be
  in the scroll-spy band at once; take the one whose top is furthest down, not
  the first in document order — the latter marks the section you are leaving.
  There is a check that jumps to a stage and fails if the dock names its
  neighbour.
  It holds the section jumps and the two page settings, and it is the only nav on
  the page — the top bar is just the `h1` now. On a phone it becomes two rows and
  `--dock` grows to match; in one row the settings ate the width and the jumps
  collapsed to nothing, which from a screenshot looked like a dock with no jumps.
  "Where you are" is inverted, not accented: the accent already means the step a
  stage is standing on.
- **Hide a label by clipping it, not by removing it.** The chips read "3" on a
  phone and "Parse" on a desktop; whichever is not showing is clipped, so it
  stays in the accessibility tree and every link has a name at every width.
  `display: none` on the words left nine links with no accessible name at all,
  and only the axe pass at 390px caught it. In `shoot`, click an anchor through
  `el.click()` rather than a coordinate — the dock is fixed and its chips scroll
  sideways, so a point click silently misses and the check quietly measures the
  wrong thing.
- **The bars are ours; the input underneath is still the platform's.** Every
  slider is a real `<input type="range">` made invisible on top of a track drawn
  in CSS — giving the input up would cost the keyboard, the arrow keys and the
  accessibility tree. Position is one custom property, `--progress` from 0 to 1,
  set in `setCursor` and `applySpeed`; the fill is a `scaleX` and the head a
  `translateX`, so a step costs no layout and the bar glides. The head is a
  full-width element translated by `calc(var(--progress) * (100% - var(--head)))`
  — the percentage resolves against its own width, which is how it lands exactly
  on the end without script measuring anything — so `.bar-track` must clip, or
  the overhang becomes a screenful of horizontal scroll. Suppress the browser's
  own focus ring on the input: the ring belongs on the track, or the bar wears
  two rectangles. And light mode is paper, not white — pure white behind this
  much rule and monospace glares.
- **`*` does not match pseudo-elements.** The `box-sizing` reset read `*` for
  months, so every `::before` was sizing content-box while the rest of the page
  was border-box. The bar's head, told `width: var(--head)`, was two border
  widths wider than that, and the extra hung past the clip — so a finished bar
  lost the right edge of its marker. The reset is `*, *::before, *::after` now,
  as the reduced-motion switch already was.
- **A clipped border is a question about pixels, not about geometry.** The box
  was in the right place either way, so no rect check could see it. `pnpm shoot`
  screenshots the end of a finished bar and reads one row across it — page,
  border, fill, border, page — and fails if the fill is not fenced on both
  sides. Allow a blended pixel at each edge; the screenshot is antialiased.
- **A headless page only advances a transition when something asks for a
  frame.** Reading a transform mid-glide in `shoot` measures wherever the bar
  happened to be, which is nowhere in particular. Emulate reduced motion for
  the measurement — the position worth checking is the settled one.
- **Let the page settle before measuring it.** axe reads whatever is painted at
  that instant, so sampling mid-transition reports contrast failures that do not
  exist a frame later. `pnpm shoot` waits before each scan. A flaky sensor gets
  ignored, and an ignored sensor is worse than none.
- **Preferences are the page's, not a stage's.** Play speed is one bar for all
  seven players and the theme is the whole document, so neither lives in
  `StagePlayer`. Both are remembered through `prefs.ts`, and remembering is
  best-effort: `localStorage` throws in a sandboxed frame, and a preference is
  never worth a page that will not start. Changing speed mid-play restarts the
  interval and leaves the cursor alone — the rate changed, not the position.
- **The theme is settled in the head, before first paint.** An inline script in
  `index.astro` applies the stored choice or the system preference; doing it from
  the bundle would flash the wrong theme on every load. That copy cannot import
  `prefs.ts`, so `spec/page.test.ts` pins the storage key in both places.
- **A default that is also a valid value needs its own guard.** `Number(null)`
  and `Number("")` are both 0, which is a real speed index, so the first visit
  quietly opened at ×0.5. Tests all passed; the screenshot is what caught it.
  Look at the page.
- **Colouring the source must not change the source.** `pieces()` cuts the text
  on both syntax boundaries and the marked span's edges, so a token straddling
  the highlight splits instead of one of them swallowing the other. The tests
  that matter assert the painted echo's `textContent` is still exactly the
  source, character for character.
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
- **Running is not one more rewrite, and the page must not imply it is.** The
  run section executes the IR from stage five — the listing already on screen —
  not the assembly, which would need a processor. It is numbered "AFTERWARDS"
  rather than "STAGE 8", `STAGES` holds seven (register allocation is in that
  list for the same reason semantics is: it gets a numbered section and a
  player, even though it annotates rather than rewrites), and `PLAYERS` is what
  the UI iterates. `spec/page.test.ts` checks exactly seven sections claim to be
  stages.
- **A type knows its size and only `ctypes.ts` decides it; a value knows its
  register and only `regalloc.ts` decides that.** Register allocation runs after
  lowering and before codegen, and it never rewrites the IR listing — it answers
  one question, which of the temporaries lowering invented can share a register,
  by colouring an interference graph built from liveness over the control-flow
  graph (a straight-line pass over the listing would get a loop wrong, since a
  value can be live across a backward jump). Two register-only constraints ride
  along as graph edges rather than living as special cases in codegen: anything
  live across a `call` cannot be in a caller-saved register, and anything live
  across `idiv` cannot be in `rax` or `rdx`. Twelve colours, not fourteen —
  `r10`/`r11` are held back as scratch so codegen can always get a spilled value
  into a register without asking the allocator for help, and named locals are
  never coloured at all, because `&x` needs an address and only memory has one.
  `spec/regalloc.test.ts` asserts the interference property directly (no two
  live-together temporaries ever share a colour) rather than trusting that a
  program happening to run correctly proves it; `spec/machine.test.ts`'s
  gcc/interpreter differential is what actually catches a wrong colouring
  turning into a wrong answer, since a bad register choice is still
  syntactically valid assembly.
- **Coalescing candidates come from the machine, not from a search for
  redundant copies.** This IR never emits a temp-to-temp `move` — the only
  place two temporaries are related is `dest`/operand of a `+`, `-`, `*` or
  unary `-`, because x86 computes those into one of its own operands and
  codegen already prefers the destination's register for exactly that reason.
  So `coalesceCandidatesOf` reads candidates straight off those instructions
  rather than pattern-matching for copies that do not exist here. Merging is
  never greedy: Briggs' conservative rule only allows it when the merged node
  would have fewer than twelve neighbours that are themselves near the colour
  limit, because that is the only guarantee that a merge cannot be the one
  thing that makes an otherwise-colourable graph stop being one. A refused
  merge keeps its `mov`; codegen never finds out a merge was even considered,
  since coalescing changes `colours`, not the IR or codegen. `spec/regalloc.test.ts`
  checks both directions on a program built to need each: an operand that dies
  at the merge point gets coalesced, one that survives past it does not, and the
  `mov` codegen would have needed for the accepted one is gone from the
  assembly — checked in the emitted instructions, not just the allocator's own
  bookkeeping.
- **The interpreter and codegen share `frames.ts`.** If they disagreed by a byte,
  `&x` would mean one thing in the run pane and another in the assembly pane, and
  the page would be quietly lying about the connection. There is a test pinning an
  address in both.
- **Three implementations, one answer.** `spec/machine.test.ts` compares our
  assembly built by gcc, gcc's own build, and the interpreter. Two agreeing could
  be a shared mistake; three is evidence. Add a program to `spec/programs/`
  whenever the compiler learns something — but never one that loops forever, since
  gcc will happily run it.
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
