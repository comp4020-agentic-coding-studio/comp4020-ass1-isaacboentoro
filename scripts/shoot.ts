/**
 * Look at the page instead of assuming.
 *
 * Serves `dist/` and drives a real Chromium over it at both marking viewports:
 * 1920x1080 and 390x844. It fails loudly on any console error or page error,
 * exercises the one interaction that matters (move the scrubber, watch the panes
 * change), and writes a screenshot per viewport so the rendered result can be
 * checked by eye rather than by hope.
 *
 *   pnpm shoot            # screenshots into .screens/
 *   pnpm shoot --keep     # leave the browser open
 */

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
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

async function main(): Promise<void> {
  if (!existsSync(join(DIST, "index.html"))) {
    throw new Error("dist/index.html is missing — run `pnpm build` first.");
  }
  await mkdir(OUT, { recursive: true });

  const site = await serve();
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    args: ["--no-sandbox", "--font-render-hinting=none"],
  });

  const problems: string[] = [];
  const report: string[] = [];

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
