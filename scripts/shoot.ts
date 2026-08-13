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

const DIST = resolve("dist");
const OUT = resolve(".screens");
const CHROME = ["/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/chrome"];

/** Must match STAGES in src/compiler/types.ts. */
const STAGES = ["preprocess", "scan", "parse", "semantics", "ir", "codegen"];

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

type Violation = { id: string; impact: string; help: string; nodes: number };

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
              nodes: unknown[];
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
      }));
  });
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
    const page = await browser.newPage();
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
        ...document.querySelectorAll("[data-reveal], [data-grow], .preset, .player-play, a"),
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

    const violations = await axeScan(page);
    for (const violation of violations) {
      note(
        `axe ${violation.impact}: ${violation.id} on ${violation.nodes} node(s) — ${violation.help}`,
      );
    }

    const shot = join(OUT, `${viewport.name}.png`);
    await page.screenshot({ path: shot as `${string}.png`, fullPage: true });

    report.push(
      `${viewport.name} ${viewport.width}x${viewport.height}: ${sections.length} sections, ` +
        `revealed ${STAGES.map((s) => `${s}=${counts[s].start}->${counts[s].end}`).join(" ")}, ` +
        `tree grew ${grewFrom}->${grewMid}->${grewTo}px, ` +
        `reduced motion honoured, sections hold their height, ` +
        `independent, keyboard ok, cursors survive resize, ` +
        `${overflow <= 1 ? "no" : `${overflow}px`} overflow, ` +
        `${violations.length === 0 ? "no serious axe violations" : `${violations.length} axe violation(s)`}, ` +
        `diagnostic "${diagnostics[0] ?? "none"}" -> ${shot}`,
    );
    await page.close();
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
