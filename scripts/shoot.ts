/**
 * Look at the page instead of assuming.
 *
 * Serves `dist/` and drives a real Chromium over it at both marking viewports:
 * 1920x1080 and 390x844. It fails loudly on console errors, on a stage player
 * that does not change what its stage shows, on one stage leaking into another,
 * on a keyboard that cannot drive it, on a resize that loses the cursors, on
 * horizontal overflow, on any serious axe violation, and on a bundle over budget.
 *
 *   pnpm shoot                     # against a local server over dist/
 *   pnpm shoot https://…/repo/     # against the deployed URL, sub-path and all
 *
 * The deployed form matters: an asset path that resolves locally can still 404
 * under a project sub-path, and only the live URL proves otherwise.
 */

import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { extname, join, normalize, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import puppeteer from "puppeteer-core";
import sharp from "sharp";

const DIST = resolve("dist");
const OUT = resolve(".screens");
const CHROME = ["/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/chrome"];

/** Must match PLAYERS in src/compiler/types.ts — the six rewrites, then running. */
const STAGES = ["preprocess", "scan", "parse", "semantics", "ir", "codegen", "run"];

/** The whole compiler ships to the visitor, so its weight is a real constraint. */
const GZIP_BUDGET_BYTES = 60_000;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".json": "application/json",
};

const VIEWPORTS = [
  { name: "desktop", width: 1920, height: 1080 },
  { name: "phone", width: 390, height: 844 },
];

type Page = Awaited<
  ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>
>;

function serve(): Promise<{ url: string; close: () => void }> {
  const server = createServer(async (request, response) => {
    const path = new URL(request.url ?? "/", "http://localhost").pathname;
    const relative = normalize(path === "/" ? "index.html" : path.slice(1));
    const file = join(DIST, relative);
    if (!file.startsWith(DIST) || !existsSync(file)) {
      response.writeHead(404).end("not found");
      return;
    }
    response.writeHead(200, {
      "content-type": MIME[extname(file)] ?? "application/octet-stream",
    });
    response.end(await readFile(file));
  });

  return new Promise((done) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      done({ url: `http://127.0.0.1:${port}/`, close: () => server.close() });
    });
  });
}

function findChrome(): string {
  const found = CHROME.find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `no Chromium found. Looked in: ${CHROME.join(", ")}. Set one up or edit scripts/shoot.ts.`,
    );
  }
  return found;
}

async function bundleWeight(): Promise<{ total: number; detail: string }> {
  const assets = join(DIST, "_astro");
  const files = existsSync(assets) ? await readdir(assets) : [];
  let total = 0;
  const parts: string[] = [];
  for (const name of files) {
    const gzipped = gzipSync(await readFile(join(assets, name))).length;
    total += gzipped;
    parts.push(`${extname(name).slice(1)} ${Math.round(gzipped / 100) / 10}kB`);
  }
  return { total, detail: parts.join(", ") };
}

type Violation = {
  id: string;
  impact: string;
  help: string;
  nodes: number;
  where: string;
};

/**
 * Nothing in the course CI measures accessibility, so this is the sensor for it.
 * Only serious and critical violations fail the run.
 */
async function axeScan(page: Page): Promise<Violation[]> {
  await page.addScriptTag({
    path: createRequire(import.meta.url).resolve("axe-core"),
  });
  return page.evaluate(async () => {
    const axe = (
      globalThis as unknown as {
        axe: {
          run: (options: unknown) => Promise<{
            violations: {
              id: string;
              impact: string | null;
              help: string;
              nodes: { target: string[]; failureSummary?: string }[];
            }[];
          }>;
        };
      }
    ).axe;
    const results = await axe.run({
      runOnly: {
        type: "tag",
        values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"],
      },
    });
    return results.violations
      .filter((v) => v.impact === "serious" || v.impact === "critical")
      .map((v) => ({
        id: v.id,
        impact: v.impact ?? "unknown",
        help: v.help,
        nodes: v.nodes.length,
        where: v.nodes
          .slice(0, 3)
          .map((node) => node.target.join(" "))
          .join(", "),
      }));
  });
}

/**
 * Is the head of a finished bar drawn in full?
 *
 * Its right border is one rule wide and lands exactly on the end of the track,
 * which is clipped — so this is a question about pixels, and geometry cannot
 * answer it: the box is in the right place either way. Screenshot the end of the
 * bar and walk one row: background, border, accent fill, border, background. A
 * missing last border is the bug this exists for.
 */
async function headIsWhole(
  page: Page,
  stage: string,
): Promise<{ ok: boolean; row: string }> {
  /*
   * Transitions are compositor-driven, and a headless page only advances them
   * when something asks for a frame — so a bar caught mid-glide would be
   * measured wherever it happened to be. Turn motion off for the measurement:
   * the position we care about is the settled one.
   */
  await page.emulateMediaFeatures([
    { name: "prefers-reduced-motion", value: "reduce" },
  ]);
  await page.evaluate(
    () =>
      new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
  );

  const geometry = await page.$eval(`#bar-${stage}`, (node) => {
    const track = node.querySelector(".bar-track");
    const head = node.querySelector(".bar-head");
    if (!track || !head) return null;
    const box = track.getBoundingClientRect();
    return {
      right: box.right,
      top: box.top,
      height: box.height,
      square: Number.parseFloat(getComputedStyle(head, "::before").width),
    };
  });
  if (!geometry) return { ok: false, row: "no bar" };
  const restore = async () =>
    page.emulateMediaFeatures([
      { name: "prefers-reduced-motion", value: "no-preference" },
    ]);

  const pad = 6;
  const width = Math.ceil(geometry.square + pad * 2);
  const shot = await page.screenshot({
    clip: {
      x: Math.max(0, Math.floor(geometry.right - geometry.square - pad)),
      y: Math.floor(geometry.top),
      width,
      height: Math.ceil(geometry.height),
    },
  });

  await restore();

  const { data, info } = await sharp(Buffer.from(shot))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const middle = Math.floor(info.height / 2);
  const pixels: string[] = [];
  for (let x = 0; x < info.width; x += 1) {
    const at = (middle * info.width + x) * info.channels;
    const [r, g, b] = [data[at], data[at + 1], data[at + 2]];
    // Three things can be here: the yellow fill, the border, or the page.
    const kind = g > 200 && b < 120 ? "accent" : r > 200 && g > 200 && b > 200 ? "rule" : "page";
    pixels.push(kind);
  }
  // "page rule accent rule page", with runs collapsed, is what a whole head
  // looks like from the side.
  const row = pixels
    .map((kind) => kind[0])
    .join("")
    .replace(/(.)\1+/g, "$1");
  // The fill must be fenced by the border on both sides.
  const accentStart = pixels.indexOf("accent");
  const accentEnd = pixels.lastIndexOf("accent");
  // Edges are antialiased, so a blended pixel can sit between the fill and its
  // border: look at the next couple rather than demanding the very next one.
  const fenced = (from: number, step: number) =>
    [1, 2, 3].some((away) => pixels[from + away * step] === "rule");
  const ok =
    accentStart > 0 && accentEnd > 0 && fenced(accentStart, -1) && fenced(accentEnd, 1);
  return { ok, row };
}

/** How many of a stage's artefacts are currently revealed. */
function shownIn(page: Page, stage: string): Promise<number> {
  return page.$$eval(
    `#pane-${stage} [data-reveal].is-shown`,
    (nodes) => nodes.length,
  );
}

function cursorOf(page: Page, stage: string): Promise<number> {
  return page.$eval(`#scrub-${stage}`, (el) =>
    Number((el as HTMLInputElement).value),
  );
}

async function scrubTo(page: Page, stage: string, value: number): Promise<void> {
  await page.$eval(
    `#scrub-${stage}`,
    (el, next) => {
      const input = el as HTMLInputElement;
      input.value = String(next);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    value,
  );
}

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

async function main(): Promise<void> {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("dist/index.html is missing — run `pnpm build` first.");
  }
  await mkdir(OUT, { recursive: true });

  // A URL argument checks the deployed site instead of a local copy of dist/.
  const target = process.argv[2];
  const site = target ? { url: target, close: () => {} } : await serve();
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    args: ["--no-sandbox", "--font-render-hinting=none"],
  });

  const problems: string[] = [];
  const report: string[] = [`target: ${site.url}`];

  const weight = await bundleWeight();
  report.push(
    `bundle: ${Math.round(weight.total / 100) / 10}kB gzipped (${weight.detail}), budget ${GZIP_BUDGET_BYTES / 1000}kB`,
  );
  if (weight.total > GZIP_BUDGET_BYTES) {
    problems.push(
      `bundle is ${weight.total} bytes gzipped, over the ${GZIP_BUDGET_BYTES} budget`,
    );
  }

  for (const viewport of VIEWPORTS) {
    // Its own browser context, so the remembered theme from the last viewport
    // does not decide what this one loads with.
    const context = await browser.createBrowserContext();
    const page = await context.newPage();
    const note = (message: string) => problems.push(`[${viewport.name}] ${message}`);
    await page.setViewport({ width: viewport.width, height: viewport.height });

    page.on("console", (message) => {
      if (message.type() === "error") note(`console: ${message.text()}`);
    });
    page.on("pageerror", (error) => note(`pageerror: ${error.message}`));

    await page.goto(site.url, { waitUntil: "networkidle0" });

    // Every stage is a section of its own, and every section is on screen.
    const sections = await page.$$eval(".stage", (nodes) =>
      nodes
        .filter((node) => (node as HTMLElement).offsetParent !== null)
        .map((node) => node.id),
    );
    if (sections.length !== STAGES.length) {
      note(`${sections.length} stage sections visible, expected ${STAGES.length}`);
    }

    // The core interaction, per stage: its player changes what IT shows.
    const counts: Record<string, { start: number; end: number }> = {};
    for (const stage of STAGES) {
      const end = await shownIn(page, stage);
      await scrubTo(page, stage, 0);
      const start = await shownIn(page, stage);
      counts[stage] = { start, end };
      if (end > 0 && start >= end) {
        note(
          `${stage}: playing it changed nothing (${start} at step 1, ${end} at the end)`,
        );
      }
      const max = await page.$eval(`#scrub-${stage}`, (el) =>
        Number((el as HTMLInputElement).max),
      );
      // The program the page opens with should give every stage something to
      // play — a dead player is a bad first impression even when it is honest.
      if (max < 2) note(`${stage}: only ${max + 1} step(s) to play`);

      // Somewhere in a stage's run it must point at source text. Not at every
      // step: a step about the whole file (a prologue, a frame layout) drops the
      // highlight on purpose rather than painting every line.
      let everMarked = false;
      for (let cursor = 0; cursor <= max; cursor += 1) {
        await scrubTo(page, stage, cursor);
        const marked = await page.$$eval(`#echo-${stage} mark`, (n) => n.length);
        if (marked > 0) everMarked = true;
      }
      if (!everMarked) note(`${stage}: never highlights source in its own echo`);
      await scrubTo(page, stage, 0);
    }

    /*
     * A finished bar has to look finished: the head sits at the end of the
     * track, and its outer border is the first thing a clip eats.
     */
    const scanMax = await page.$eval("#scrub-scan", (el) =>
      Number((el as HTMLInputElement).max),
    );
    await scrubTo(page, "scan", scanMax);
    await wait(400);
    const whole = await headIsWhole(page, "scan");
    if (!whole.ok) {
      note(`the head of a finished bar is cut off (row reads ${whole.row})`);
    }
    await scrubTo(page, "scan", 0);

    // "The tree grows" is a claim about layout, not about classes: the parse pane
    // must get taller as it plays, which only holds if unbuilt structure takes no
    // space at all.
    const parseMax = await page.$eval("#scrub-parse", (el) =>
      Number((el as HTMLInputElement).max),
    );
    const heightAt = async (cursor: number) => {
      await scrubTo(page, "parse", cursor);
      return page.$eval("#pane-parse .tree", (el) => (el as HTMLElement).scrollHeight);
    };
    const grewFrom = await heightAt(0);
    const grewMid = await heightAt(Math.floor(parseMax / 2));
    const grewTo = await heightAt(parseMax);
    if (!(grewFrom < grewMid && grewMid < grewTo)) {
      note(
        `the parse tree did not grow: ${grewFrom}px at step 1, ${grewMid}px mid, ${grewTo}px at the end`,
      );
    }

    // Nothing below a playing stage may move. Reserved heights make each pane a
    // fixed box that content grows inside; without them the page slid down a step
    // at a time and felt like jitter.
    // Compare a section's height at its FIRST step against its last: comparing
    // two fully-revealed states measures nothing, which an earlier version of
    // this check did while passing happily.
    const sectionHeight = (stage: string) =>
      page.$eval(`#stage-${stage}`, (node) =>
        Math.round(node.getBoundingClientRect().height),
      );
    const jitter: string[] = [];
    for (const stage of STAGES) {
      const max = await page.$eval(`#scrub-${stage}`, (el) =>
        Number((el as HTMLInputElement).max),
      );
      const seen = new Set<number>();
      for (const cursor of [0, Math.floor(max / 2), max]) {
        await scrubTo(page, stage, cursor);
        seen.add(await sectionHeight(stage));
      }
      if (seen.size > 1) jitter.push(`${stage} ${[...seen].join("/")}px`);
    }
    if (jitter.length > 0) {
      note(`sections resized while playing: ${jitter.join(", ")}`);
    }

    // The grammar listing marks the rule the current step applied, and that
    // marker has to move with the cursor rather than sitting on one rule.
    const rulesSeen = new Set<string>();
    const parseSteps = await page.$eval("#scrub-parse", (el) =>
      Number((el as HTMLInputElement).max),
    );
    for (let cursor = 0; cursor <= parseSteps; cursor += 1) {
      await scrubTo(page, "parse", cursor);
      const active = await page.$$eval("#rules-parse .rule.is-rule", (nodes) =>
        nodes.map((node) => (node as HTMLElement).dataset.rule ?? ""),
      );
      if (active.length > 1) note(`${active.length} grammar rules marked at once`);
      for (const id of active) rulesSeen.add(id);
    }
    if (rulesSeen.size < 4) {
      note(`only ${rulesSeen.size} grammar rule(s) ever marked while parsing`);
    }

    // The complaint this was built for: while a stage plays, the rule it is
    // applying has to be on screen. The grammar is taller than the viewport, so
    // that needs both the sticky column and the scroll-into-view to be working.
    await page.$eval("#stage-parse", (node) => {
      node.scrollIntoView({ block: "start" });
    });
    let offScreen = 0;
    for (let cursor = 0; cursor <= parseSteps; cursor += 1) {
      await scrubTo(page, "parse", cursor);
      const visible = await page.$eval("#rules-parse", (container) => {
        const marked = container.querySelector(".rule.is-rule");
        if (!marked) return true;
        const rule = marked.getBoundingClientRect();
        const list = marked.parentElement?.getBoundingClientRect();
        if (!list) return false;
        // Inside its own scrolling box, and that box inside the viewport.
        const inList = rule.top >= list.top - 1 && rule.bottom <= list.bottom + 1;
        const onScreen = list.top < window.innerHeight && list.bottom > 0;
        return inList && onScreen;
      });
      if (!visible) offScreen += 1;
    }
    if (offScreen > 0) {
      note(`the marked grammar rule was out of view at ${offScreen} step(s)`);
    }

    // Independence: moving one stage must not move any other.
    for (const stage of STAGES) await scrubTo(page, stage, 1);
    const before = await Promise.all(STAGES.map((stage) => shownIn(page, stage)));
    await scrubTo(page, "parse", 0);
    const after = await Promise.all(STAGES.map((stage) => shownIn(page, stage)));
    STAGES.forEach((stage, index) => {
      if (stage === "parse") return;
      if (before[index] !== after[index]) {
        note(
          `scrubbing parse changed ${stage} (${before[index]} -> ${after[index]})`,
        );
      }
    });

    // The keyboard is a first-class way in: a native range gives arrows and Home.
    await page.focus("#scrub-scan");
    const from = await cursorOf(page, "scan");
    await page.keyboard.press("ArrowRight");
    const right = await cursorOf(page, "scan");
    await page.keyboard.press("Home");
    const home = await cursorOf(page, "scan");
    if (right !== from + 1) note(`ArrowRight moved scan ${from} -> ${right}`);
    if (home !== 0) note("Home did not return scan to its first step");

    // The marker resizes mid-interaction. Every cursor must survive it. Targets
    // are picked inside each stage's own range — a clamped cursor is correct
    // behaviour, and asserting past the end tests the sensor, not the page.
    const targets: Record<string, number> = {};
    for (const stage of ["ir", "codegen"]) {
      const max = await page.$eval(`#scrub-${stage}`, (el) =>
        Number((el as HTMLInputElement).max),
      );
      targets[stage] = Math.min(3, max);
      await scrubTo(page, stage, targets[stage]);
    }
    await page.setViewport({ width: 700, height: 900 });
    await page.setViewport({ width: viewport.width, height: viewport.height });
    for (const stage of ["ir", "codegen"]) {
      const after = await cursorOf(page, stage);
      if (after !== targets[stage]) {
        note(`resizing lost ${stage}: ${after}, want ${targets[stage]}`);
      }
    }

    // Wide rules and monospace are easy to overflow. Nothing may scroll sideways.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    if (overflow > 1) note(`${overflow}px of horizontal overflow`);

    /*
     * The dock is fixed, so it is the one thing on the page that can cover
     * something. It must stay on screen wherever you scroll, it must mark the
     * section you are in, and the page must have reserved its height rather than
     * leaving the last caveat underneath it.
     */
    const dockAt = () =>
      page.$eval("#dock", (node) => {
        const box = node.getBoundingClientRect();
        return { top: box.top, bottom: box.bottom, height: box.height };
      });
    // It floats, so it does not touch the bottom — but it is fixed, so it must
    // stay within a gap of it however far the page scrolls.
    const FLOAT_GAP_MAX = 40;
    const offBottom = (box: { bottom: number }) => viewport.height - box.bottom;
    const dockTop = await dockAt();
    if (offBottom(dockTop) < 1 || offBottom(dockTop) > FLOAT_GAP_MAX) {
      note(`the dock is not floating above the bottom (${offBottom(dockTop)}px off)`);
    }

    await page.evaluate(() =>
      window.scrollTo({ top: document.body.scrollHeight, behavior: "instant" }),
    );
    await wait(300);
    const dockEnd = await dockAt();
    if (offBottom(dockEnd) < 1 || offBottom(dockEnd) > FLOAT_GAP_MAX) {
      note(`the dock scrolled away with the page (${offBottom(dockEnd)}px off the bottom)`);
    }
    const covered = await page.evaluate(() => {
      const last = document.querySelector("#limits li:last-child");
      const dock = document.getElementById("dock");
      if (!last || !dock) return -1;
      // Against the top of the bar itself, not a height: the bar floats, so the
      // space it needs is its own top edge.
      return Math.round(
        last.getBoundingClientRect().bottom - dock.getBoundingClientRect().top,
      );
    });
    if (covered > 0) note(`the dock covers the last caveat by ${covered}px`);

    // Jumping is what it is for, and the chip has to follow — including at the
    // seam, where the section above is still in the band.
    // Click the anchor itself rather than a point on screen: the dock is fixed
    // and its chips scroll sideways, so a coordinate click can miss.
    for (const stage of ["scan", "codegen"]) {
      await page.$eval(`[data-jump="stage-${stage}"]`, (el) => (el as HTMLElement).click());
      await wait(400);
      const marked = await page.$$eval(".jump.is-here", (nodes) =>
        nodes.map((node) => (node as HTMLElement).dataset.jump ?? ""),
      );
      if (marked.length !== 1 || marked[0] !== `stage-${stage}`) {
        note(`jumped to stage-${stage} but the dock says ${marked.join(", ") || "nothing"}`);
      }
    }
    await page.$eval('[data-jump="stage-ir"]', (el) => (el as HTMLElement).click());
    await wait(400);
    const here = await page.$$eval(".jump.is-here", (nodes) =>
      nodes.map((node) => (node as HTMLElement).dataset.jump ?? ""),
    );
    if (here.length !== 1) {
      note(`${here.length} dock chips claim to be where you are, expected 1`);
    } else if (here[0] !== "stage-ir") {
      note(`jumped to stage-ir but the dock says ${here[0]}`);
    }
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: "instant" }));
    await wait(200);

    // A program that does not compile has to explain itself, not go blank.
    await page.$$eval("#presets .preset", (buttons) => {
      const broken = buttons.find((b) => b.textContent?.includes("A mistake"));
      (broken as HTMLButtonElement | undefined)?.click();
    });
    await wait(300);
    const diagnostics = await page.$$eval(".diagnostic-message", (nodes) =>
      nodes.map((node) => node.textContent ?? ""),
    );
    const stopped = await page.$eval(
      "#play-codegen",
      (el) => (el as HTMLButtonElement).disabled,
    );
    if (diagnostics.length === 0) note("a failing program showed no diagnostic");
    if (!stopped) note("a stage that never ran still offered a play button");

    // Put a working program back before the accessibility scan and screenshot,
    // with two stages mid-play so the shot shows the mechanic rather than the end.
    // The array example, because pointer arithmetic is the thing worth looking at.
    await page.$$eval("#presets .preset", (buttons) => {
      const arrays = buttons.find((b) => b.textContent?.includes("Arrays"));
      (arrays as HTMLButtonElement | undefined)?.click();
    });
    await wait(300);
    await scrubTo(page, "parse", 8);
    await scrubTo(page, "codegen", 3);

    // Reduced motion is the easiest promise to break by accident: a transition
    // added later escapes it unless the switch is wholesale. Ask the browser.
    await page.emulateMediaFeatures([
      { name: "prefers-reduced-motion", value: "reduce" },
    ]);
    const stillMoving = await page.evaluate(() => {
      const samples = [
        ...document.querySelectorAll("[data-reveal], [data-grow], .preset, .player-play, .bar-fill, .bar-head, a"),
      ].slice(0, 60);
      return samples
        .map((node) => {
          const style = getComputedStyle(node);
          const longest = [style.transitionDuration, style.animationDuration]
            .flatMap((value) => value.split(","))
            .map((value) => Number.parseFloat(value) || 0);
          return Math.max(0, ...longest);
        })
        .filter((seconds) => seconds > 0.05).length;
    });
    if (stillMoving > 0) {
      note(`${stillMoving} element(s) still animate under prefers-reduced-motion`);
    }
    await page.emulateMediaFeatures([
      { name: "prefers-reduced-motion", value: "no-preference" },
    ]);

    // Colour transitions and the highlight's own fade are mid-flight right after
    // the drive above, and axe measures whatever is painted at that instant — a
    // half-way colour reads as a contrast failure that does not exist once it
    // lands. Let the page settle before judging it.
    await wait(400);
    const violations = await axeScan(page);
    for (const violation of violations) {
      note(
        `axe ${violation.impact}: ${violation.id} on ${violation.nodes} node(s) at ${violation.where} — ${violation.help}`,
      );
    }

    const shot = join(OUT, `${viewport.name}.png`);
    await page.screenshot({ path: shot as `${string}.png`, fullPage: true });

    /*
     * Light mode is a second palette, so it is a second set of contrast ratios —
     * and a dark-mode axe pass says nothing about them. Press the real toggle
     * rather than setting the attribute, since that also proves the button is
     * wired, and scan again.
     */
    const themed = await page.evaluate(() => {
      const button = document.getElementById("theme") as HTMLButtonElement | null;
      const before = document.documentElement.dataset.theme;
      button?.click();
      const after = document.documentElement.dataset.theme;
      return { before, after, label: button?.textContent?.trim() ?? "" };
    });
    await wait(400);
    if (themed.after === themed.before || themed.after !== "light") {
      note(
        `the theme toggle did not switch to light (${themed.before} -> ${themed.after})`,
      );
    }
    if (!/DARK MODE/.test(themed.label)) {
      note(`the theme toggle does not offer the way back (says "${themed.label}")`);
    }
    const lightViolations = await axeScan(page);
    for (const violation of lightViolations) {
      note(
        `axe [light] ${violation.impact}: ${violation.id} on ${violation.nodes} node(s) at ${violation.where} — ${violation.help}`,
      );
    }
    const lightShot = join(OUT, `${viewport.name}-light.png`);
    await page.screenshot({ path: lightShot as `${string}.png`, fullPage: true });

    /*
     * Every palette is a second set of contrast ratios, and the palette test
     * checks the tokens in the abstract — what it cannot see is a token used
     * against the wrong background somewhere in the stylesheet. So: wear each
     * one, in both modes, and let axe read the real page.
     */
    const palettes = await page.$$eval("#palette option", (options) =>
      options.map((option) => (option as HTMLOptionElement).value),
    );
    if (palettes.length < 2) note(`only ${palettes.length} palette(s) offered`);
    const paletteFaults: string[] = [];
    for (const id of palettes) {
      for (const mode of ["dark", "light"]) {
        const worn = await page.evaluate(
          (next: string, wanted: string) => {
            const select = document.getElementById("palette") as HTMLSelectElement;
            select.value = next;
            select.dispatchEvent(new Event("change", { bubbles: true }));
            const toggle = document.getElementById("theme") as HTMLButtonElement;
            if (document.documentElement.dataset.theme !== wanted) toggle.click();
            return {
              palette: document.documentElement.dataset.palette,
              theme: document.documentElement.dataset.theme,
              bg: getComputedStyle(document.body).backgroundColor,
            };
          },
          id,
          mode,
        );
        if (worn.palette !== id || worn.theme !== mode) {
          note(`asked for ${id}/${mode}, got ${worn.palette}/${worn.theme}`);
        }
        await wait(400);
        for (const violation of await axeScan(page)) {
          paletteFaults.push(
            `axe [${id}/${mode}] ${violation.impact}: ${violation.id} on ${violation.nodes} node(s) at ${violation.where}`,
          );
        }
      }
    }
    for (const fault of paletteFaults) note(fault);

    /*
     * The speed control is one bar for all six players, so what it must change
     * is the interval, not the cursor. Compare how far one stage gets in a fixed
     * wall-clock window at the slow end against the fast end.
     */
    const played = async (speed: number, windowMs: number) => {
      await scrubTo(page, "scan", 0);
      await page.$eval(
        "#speed",
        (el, value) => {
          const range = el as HTMLInputElement;
          range.value = String(value);
          range.dispatchEvent(new Event("input", { bubbles: true }));
        },
        speed,
      );
      await page.click("#play-scan");
      await wait(windowMs);
      await page.click("#play-scan");
      return page.$eval("#scrub-scan", (el) => Number((el as HTMLInputElement).value));
    };
    const slow = await played(0, 1400);
    const fast = await played(5, 1400);
    if (!(fast > slow)) {
      note(`the speed control changed nothing: ${slow} steps slow, ${fast} fast`);
    }
    await scrubTo(page, "scan", 0);

    report.push(
      `${viewport.name} ${viewport.width}x${viewport.height}: ${sections.length} sections, ` +
        `revealed ${STAGES.map((s) => `${s}=${counts[s].start}->${counts[s].end}`).join(" ")}, ` +
        `tree grew ${grewFrom}->${grewMid}->${grewTo}px, ` +
        `${rulesSeen.size} grammar rules marked and always in view, ` +
        `reduced motion honoured, sections hold their height, ` +
        `independent, keyboard ok, cursors survive resize, ` +
        `${overflow <= 1 ? "no" : `${overflow}px`} overflow, ` +
        `dock fixed and marking ${here[0] ?? "nothing"}, ` +
        `finished bar head whole, ` +
        `${violations.length + lightViolations.length + paletteFaults.length === 0 ? `no serious axe violations across ${palettes.length} palettes, dark and light` : `${violations.length + lightViolations.length + paletteFaults.length} axe violation(s)`}, ` +
        `speed ${slow}->${fast} steps in 1.4s, ` +
        `diagnostic "${diagnostics[0] ?? "none"}" -> ${shot}, ${lightShot}`,
    );
    await page.close();
    await context.close();
  }

  await browser.close();
  site.close();

  await writeFile(join(OUT, "report.txt"), `${report.join("\n")}\n`);
  console.log(report.join("\n"));

  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s):`);
    for (const problem of problems) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log("\nall clear at both viewports");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
