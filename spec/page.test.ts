import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { STAGE_IO } from "../src/compiler/stages";
import { PLAYERS, STAGES, STAGE_TITLES } from "../src/compiler/types";

/**
 * What has to be true of the SHIPPED page, over and above the invariants.
 *
 * These are the assignment spec's checkable lines turned into assertions: the
 * page is static and client-side, every stage's controls are really in the HTML,
 * and the caveats about what this compiler is not are on the page rather than
 * only in source comments.
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
    expect(document.querySelector('link[rel="icon"]')?.getAttribute("href")).toBe(
      "favicon.svg",
    );
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

describe("one section per stage", () => {
  it("gives each stage a section of its own, in pipeline order", () => {
    const sections = [...document.querySelectorAll(".stage")].map((node) => node.id);
    expect(sections).toEqual(PLAYERS.map((stage) => `stage-${stage}`));
  });

  it("titles each section with a heading", () => {
    const names = [...document.querySelectorAll(".stage .section-name")].map(
      (node) => node.textContent?.trim(),
    );
    expect(names).toEqual(PLAYERS.map((stage) => STAGE_TITLES[stage]));
  });

  it("numbers the six rewrites, and does not count running as one", () => {
    const indexes = [...document.querySelectorAll(".stage .section-index")];
    expect(indexes).toHaveLength(PLAYERS.length);
    for (const node of indexes) expect(node.getAttribute("aria-hidden")).toBe("true");

    const numbered = indexes.filter((node) => /STAGE \d+ \/ 6/.test(node.textContent ?? ""));
    expect(numbered).toHaveLength(STAGES.length);
    // Running is a section with a player, but it is not a rewrite and must not
    // claim to be one.
    expect(indexes.at(-1)?.textContent?.trim()).toBe("AFTERWARDS");
  });

  it("states what each stage consumes and produces", () => {
    // The page used to label your source as every stage's input, which is only
    // true of the preprocessor.
    for (const stage of PLAYERS) {
      const io = document
        .getElementById(`stage-${stage}`)
        ?.querySelector(".section-io")?.textContent;
      expect(io, stage).toContain(STAGE_IO[stage].produces);
      for (const input of STAGE_IO[stage].consumes) {
        expect(io, `${stage} should name its input`).toContain(input);
      }
    }
  });

  it("does not call the source echo an input", () => {
    const labels = [...document.querySelectorAll(".stage-column .field-label")].map(
      (node) => node.textContent?.trim(),
    );
    expect(labels).not.toContain("What it is reading");
  });

  it("has no single global player left over", () => {
    expect(document.querySelector("#scrubber")).toBeNull();
    expect(document.querySelector("#play")).toBeNull();
  });
});

describe("every stage's controls are really in the markup", () => {
  for (const stage of PLAYERS) {
    describe(stage, () => {
      const section = document.getElementById(`stage-${stage}`);

      it("has its own range input, labelled with the stage", () => {
        const scrubber = section?.querySelector(`#scrub-${stage}`);
        expect(scrubber?.getAttribute("type")).toBe("range");
        // A native range is what gives arrows, Home and End for free.
        expect(scrubber?.getAttribute("aria-label")).toContain(STAGE_TITLES[stage]);
      });

      it("has its own real toggle button", () => {
        const play = section?.querySelector(`#play-${stage}`);
        expect(play?.tagName).toBe("BUTTON");
        expect(play?.getAttribute("aria-pressed")).toBe("false");
      });

      it("announces its own steps in its own live region", () => {
        const live = section?.querySelector('[aria-live="polite"]');
        expect(live?.querySelector(`#title-${stage}`)).toBeTruthy();
        expect(live?.querySelector(`#explain-${stage}`)).toBeTruthy();
      });

      it("states its position in words as well as a slider handle", () => {
        expect(section?.querySelector(`#pos-${stage}`)?.textContent).toMatch(
          /STEP \d+ \/ \d+/,
        );
      });

      it("shows what it reads beside what it produces", () => {
        const echo = section?.querySelector(`#echo-${stage}`);
        const body = section?.querySelector(`#pane-${stage}`);
        expect(echo).toBeTruthy();
        expect(body).toBeTruthy();
        // The editor is the accessible copy; six more would be six repetitions.
        expect(echo?.getAttribute("aria-hidden")).toBe("true");
        // The output scrolls, so a keyboard has to be able to reach it.
        expect(body?.getAttribute("tabindex")).toBe("0");
      });
    });
  }
});

describe("the editor", () => {
  it("is labelled, with the highlight mirror hidden from screen readers", () => {
    expect(document.querySelector('label[for="source"]')?.textContent?.trim())
      .toBeTruthy();
    expect(document.querySelector("#mirror")?.getAttribute("aria-hidden")).toBe(
      "true",
    );
  });

  it("has a labelled group for the examples", () => {
    const presets = document.querySelector("#presets");
    expect(presets?.getAttribute("role")).toBe("group");
    expect(presets?.getAttribute("aria-labelledby")).toBeTruthy();
  });
});

describe("honesty about the subset", () => {
  const text = document.body.textContent ?? "";

  it("says on the page what is left out", () => {
    for (const missing of ["structs", "linker", "register allocation", "bounds"]) {
      expect(text.toLowerCase(), missing).toContain(missing);
    }
  });

  it("explains itself when JavaScript is off", () => {
    const noscript = document.querySelector("noscript")?.textContent ?? "";
    expect(noscript.length).toBeGreaterThan(80);
  });
});
