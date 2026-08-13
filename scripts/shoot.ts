/**
 * Look at the page instead of assuming.
 *
 * Serves `dist/` and drives a real Chromium over it at both marking viewports:
 * 1920x1080 and 390x844. It fails loudly on any console error or page error,
 * exercises the one interaction that matters (move the scrubber, watch the panes
 * change), and writes a screenshot per viewport so the rendered result can be
 * checked by eye rather than by hope.
 *
 *   pnpm shoot                     # against a local server over dist/
 *   pnpm shoot https://…/repo/     # against the deployed URL, sub-path and all
 *
 * The deployed form matters: an asset path that resolves locally can still 404
 * under a project sub-path, and only the live URL proves otherwise.
 */

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { gzipSync } from "node:zlib";
import { extname, join, normalize, resolve } from "node:path";
import { createRequire } from "node:module";
import puppeteer from "puppeteer-core";

const DIST = resolve("dist");
const OUT = resolve(".screens");
const CHROME = ["/usr/bin/chromium", "/usr/bin/google-chrome", "/usr/bin/chrome"];

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
      done({
        url: `http://127.0.0.1:${port}/`,
        close: () => server.close(),
      });
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

type Page = Awaited<ReturnType<Awaited<ReturnType<typeof puppeteer.launch>>["newPage"]>>;

async function readCursor(page: Page): Promise<number> {
  return page.$eval("#scrubber", (el) => Number((el as HTMLInputElement).value));
}

type Violation = { id: string; impact: string; help: string; nodes: number };

/**
 * Nothing in the course CI measures accessibility, so this is the sensor for it.
 * Only serious and critical violations fail the run — the lower tiers are worth
 * reading but not worth blocking a build over.
 */
async function axeScan(page: Page): Promise<Violation[]> {
  const axePath = createRequire(import.meta.url).resolve("axe-core");
  await page.addScriptTag({ path: axePath });
  return page.evaluate(async () => {
    const axe = (globalThis as unknown as { axe: { run: (o: unknown) => Promise<{ violations: { id: string; impact: string | null; help: string; nodes: unknown[] }[] }> } }).axe;
    const results = await axe.run({
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
    });
    return results.violations
      .filter((violation) => violation.impact === "serious" || violation.impact === "critical")
      .map((violation) => ({
        id: violation.id,
        impact: violation.impact ?? "unknown",
        help: violation.help,
        nodes: violation.nodes.length,
      }));
  });
}

/**
 * The compiler runs in the visitor's browser, so the whole thing has to arrive
 * over their connection. A budget keeps that honest: the moment this creeps up,
 * the "works on a slow connection" claim needs re-earning.
 */
const GZIP_BUDGET_BYTES = 60_000;

async function bundleWeight(): Promise<{ total: number; detail: string }> {
  const assets = join(DIST, "_astro");
  const files = existsSync(assets) ? await readdir(assets) : [];
  let total = 0;
  const parts: string[] = [];
  for (const name of files) {
    const bytes = await readFile(join(assets, name));
    const gzipped = gzipSync(bytes).length;
    total += gzipped;
    parts.push(`${extname(name).slice(1)} ${Math.round(gzipped / 100) / 10}kB`);
  }
  return { total, detail: parts.join(", ") };
}

async function main(): Promise<void> {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("dist/index.html is missing — run `pnpm build` first.");
  }
  await mkdir(OUT, { recursive: true });

  // A URL argument checks the deployed site instead of a local copy of dist/.
  const target = process.argv[2];
  const site = target
    ? { url: target, close: () => {} }
    : await serve();
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    args: ["--no-sandbox", "--font-render-hinting=none"],
  });

  const problems: string[] = [];
  const report: string[] = [];

  report.push(`target: ${site.url}`);

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
    await page.setViewport({ width: viewport.width, height: viewport.height });

    page.on("console", (message) => {
      if (message.type() === "error") {
        problems.push(`[${viewport.name}] console: ${message.text()}`);
      }
    });
    page.on("pageerror", (error) => {
      problems.push(`[${viewport.name}] pageerror: ${error.message}`);
    });

    await page.goto(site.url, { waitUntil: "networkidle0" });

    // The core interaction: the scrubber changes what is visible.
    const atEnd = await page.$eval("#scrubber", (el) => {
      const input = el as HTMLInputElement;
      return { value: Number(input.value), max: Number(input.max) };
    });
    const shownAtEnd = await page.$$eval("[data-reveal].is-shown", (n) => n.length);

    await page.$eval("#scrubber", (el) => {
      const input = el as HTMLInputElement;
      input.value = "0";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const shownAtStart = await page.$$eval("[data-reveal].is-shown", (n) => n.length);
    const firstTitle = await page.$eval("#step-title", (el) => el.textContent ?? "");

    if (atEnd.max < 10) problems.push(`[${viewport.name}] only ${atEnd.max + 1} steps`);
    if (shownAtStart >= shownAtEnd) {
      problems.push(
        `[${viewport.name}] scrubbing changed nothing: ${shownAtStart} shown at step 1, ${shownAtEnd} at the end`,
      );
    }

    // Halfway, where a screenshot actually shows the mechanic working.
    await page.$eval("#scrubber", (el) => {
      const input = el as HTMLInputElement;
      input.value = String(Math.floor(Number(input.max) / 2));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const midTitle = await page.$eval("#step-title", (el) => el.textContent ?? "");
    const marked = await page.$$eval(".editor-mirror mark", (n) => n.length);
    if (marked === 0) {
      problems.push(`[${viewport.name}] no source highlight at the halfway step`);
    }

    // The keyboard is a first-class way in, not an afterthought: a native range
    // gives arrows and Home/End, and this is the check that it stayed native.
    await page.focus("#scrubber");
    const before = await readCursor(page);
    await page.keyboard.press("ArrowRight");
    const afterRight = await readCursor(page);
    await page.keyboard.press("Home");
    const afterHome = await readCursor(page);
    if (afterRight !== before + 1) {
      problems.push(
        `[${viewport.name}] ArrowRight moved the cursor ${before} -> ${afterRight}`,
      );
    }
    if (afterHome !== 0) {
      problems.push(`[${viewport.name}] Home did not go to the first step`);
    }

    // The marker resizes mid-interaction. The cursor must survive it, because
    // the layout is CSS and the state is not.
    await page.$eval("#scrubber", (el) => {
      const input = el as HTMLInputElement;
      input.value = "17";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await page.setViewport({ width: 700, height: 900 });
    await page.setViewport({ width: viewport.width, height: viewport.height });
    const afterResize = await readCursor(page);
    if (afterResize !== 17) {
      problems.push(
        `[${viewport.name}] resizing reset the cursor from 17 to ${afterResize}`,
      );
    }

    // Exactly one pane visible on a phone, all six on a desktop.
    const visiblePanes = await page.$$eval(".pane", (panes) =>
      panes.filter((pane) => (pane as HTMLElement).offsetParent !== null).length,
    );
    const expectedPanes = viewport.width < 960 ? 1 : 6;
    if (visiblePanes !== expectedPanes) {
      problems.push(
        `[${viewport.name}] ${visiblePanes} panes visible, expected ${expectedPanes}`,
      );
    }

    // A program that does not compile has to explain itself, not go blank.
    await page.$$eval("#presets .preset", (buttons) => {
      const broken = buttons.find((b) => b.textContent?.includes("A mistake"));
      (broken as HTMLButtonElement | undefined)?.click();
    });
    await new Promise((done) => setTimeout(done, 250));
    const diagnostics = await page.$$eval(".diagnostic-message", (nodes) =>
      nodes.map((node) => node.textContent ?? ""),
    );
    const neverReached = await page.$$eval(".pane-note", (nodes) =>
      nodes.filter((node) => node.textContent?.includes("Never reached")).length,
    );
    if (diagnostics.length === 0) {
      problems.push(`[${viewport.name}] a failing program showed no diagnostic`);
    }
    if (neverReached === 0) {
      problems.push(`[${viewport.name}] no stage reported itself as never reached`);
    }

    // Put the good program back before the accessibility scan and screenshot.
    await page.$$eval("#presets .preset", (buttons) => {
      (buttons[0] as HTMLButtonElement).click();
    });
    await new Promise((done) => setTimeout(done, 250));

    const violations = await axeScan(page);
    for (const violation of violations) {
      problems.push(
        `[${viewport.name}] axe ${violation.impact}: ${violation.id} on ${violation.nodes} node(s) — ${violation.help}`,
      );
    }
    report.push(
      `${viewport.name} accessibility: ${violations.length === 0 ? "no serious or critical axe violations" : `${violations.length} violation(s)`}` +
        `, keyboard: arrows and Home work, cursor survives a resize, diagnostics: "${diagnostics[0] ?? "none"}"`,
    );

    const shot = join(OUT, `${viewport.name}.png`);
    await page.screenshot({ path: shot as `${string}.png`, fullPage: true });

    report.push(
      `${viewport.name} ${viewport.width}x${viewport.height}: ${atEnd.max + 1} steps, ` +
        `${shownAtStart} -> ${shownAtEnd} artefacts revealed, ` +
        `first "${firstTitle.trim()}", middle "${midTitle.trim()}" -> ${shot}`,
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
  console.log("\nno console errors, no page errors, interaction works at both viewports");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
