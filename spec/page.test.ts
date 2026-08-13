import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

/**
 * What has to be true of the SHIPPED page, over and above the invariants.
 *
 * These are the assignment spec's checkable lines turned into assertions: the
 * page is static and client-side, the core interaction's controls are really in
 * the HTML, and the caveats about what this compiler is not are on the page
 * rather than only in the source comments.
 */

const html = readFileSync(resolve("dist/index.html"), "utf8");
const { document } = new JSDOM(html).window;

describe("the shipped page", () => {
  it("names the idea in the title, not the assignment", () => {
    expect(document.title.toLowerCase()).not.toContain("assignment");
    expect(document.title.length).toBeGreaterThan(15);
  });

  it("has a description for anything that links to it", () => {
    const description = document
      .querySelector('meta[name="description"]')
      ?.getAttribute("content");
    expect(description?.length ?? 0).toBeGreaterThan(40);
  });

  it("asks for no favicon it does not ship", () => {
    const icon = document.querySelector('link[rel="icon"]')?.getAttribute("href");
    expect(icon).toBe("favicon.svg");
  });

  it("references assets relatively, so a project sub-path still resolves", () => {
    for (const element of document.querySelectorAll("script[src], link[href]")) {
      const url = element.getAttribute("src") ?? element.getAttribute("href") ?? "";
      if (url.startsWith("http") || url.startsWith("#")) continue;
      expect(url.startsWith("/"), `${url} is root-absolute`).toBe(false);
    }
  });

  it("ships no server call: every script is a local module", () => {
    for (const script of document.querySelectorAll("script[src]")) {
      expect(script.getAttribute("src")).toMatch(/^\.?\.?\/?_astro\//);
    }
  });
});

describe("the controls are really in the markup", () => {
  it("has a range input as the one control", () => {
    const scrubber = document.querySelector<HTMLInputElement>("#scrubber");
    expect(scrubber?.getAttribute("type")).toBe("range");
    // A native range is what gives arrows, Home and End for free.
    expect(scrubber?.getAttribute("aria-label")?.length ?? 0).toBeGreaterThan(3);
  });

  it("has a real button for playback, with a pressed state", () => {
    const play = document.querySelector("#play");
    expect(play?.tagName).toBe("BUTTON");
    expect(play?.getAttribute("aria-pressed")).toBe("false");
  });

  it("announces each step in a polite live region", () => {
    const live = document.querySelector('[aria-live="polite"]');
    expect(live).toBeTruthy();
    expect(live?.querySelector("#step-title")).toBeTruthy();
    expect(live?.querySelector("#step-explain")).toBeTruthy();
  });

  it("gives the position in words as well as a slider handle", () => {
    expect(document.querySelector("#position")?.textContent).toMatch(/step \d+ of \d+/);
  });

  it("labels the editor and hides the highlight mirror from screen readers", () => {
    const label = document.querySelector('label[for="source"]');
    expect(label?.textContent?.trim()).toBeTruthy();
    expect(document.querySelector("#mirror")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("has a container for every stage of the pipeline", () => {
    for (const stage of ["preprocess", "scan", "parse", "semantics", "ir", "codegen"]) {
      expect(document.querySelector(`#pane-${stage}`), stage).toBeTruthy();
    }
    expect(document.querySelectorAll(".pane")).toHaveLength(6);
  });

  it("titles every pane with a heading, in order", () => {
    const titles = [...document.querySelectorAll(".pane-name")].map((node) =>
      node.textContent?.trim(),
    );
    expect(titles).toEqual([
      "Preprocess",
      "Scan",
      "Parse",
      "Analyse",
      "Lower to IR",
      "Emit assembly",
    ]);
  });

  it("hides the decorative step number from screen readers", () => {
    // Without this the heading reads as "1Preprocess"; the DOM order already
    // carries the sequence.
    for (const number of document.querySelectorAll(".pane-number")) {
      expect(number.getAttribute("aria-hidden")).toBe("true");
    }
  });
});

describe("honesty about the subset", () => {
  const text = document.body.textContent ?? "";

  it("says on the page what is left out", () => {
    for (const missing of ["pointers", "linker", "register allocation"]) {
      expect(text.toLowerCase(), missing).toContain(missing);
    }
  });

  it("explains itself when JavaScript is off", () => {
    const noscript = document.querySelector("noscript")?.textContent ?? "";
    expect(noscript.length).toBeGreaterThan(80);
  });
});
