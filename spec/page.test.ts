import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { STAGE_IO } from "../src/compiler/stages";
import { PLAYERS, STAGES, STAGE_TITLES } from "../src/compiler/types";
import { PALETTES } from "../src/ui/palettes";
import { PALETTE_KEY, SPEEDS, THEME_KEY } from "../src/ui/prefs";

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

  it("numbers the rewrites, and does not count running as one", () => {
    const indexes = [...document.querySelectorAll(".stage .section-index")];
    expect(indexes).toHaveLength(PLAYERS.length);
    for (const node of indexes) expect(node.getAttribute("aria-hidden")).toBe("true");

    // The count in the label is the length of STAGES, not a number typed into the
    // markup: adding a stage and forgetting to renumber is exactly the drift this
    // catches.
    const label = new RegExp(`STAGE \\d+ / ${STAGES.length}$`);
    const numbered = indexes.filter((node) => label.test(node.textContent?.trim() ?? ""));
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

      it("offers a real button to copy what it produces, named for the stage", () => {
        const copy = section?.querySelector(`#copy-${stage}`);
        expect(copy?.tagName).toBe("BUTTON");
        expect(copy?.getAttribute("type")).toBe("button");
        expect(copy?.getAttribute("aria-label")).toContain(STAGE_TITLES[stage]);
      });
    });
  }
});

describe("the dock", () => {
  const dock = document.getElementById("dock");

  it("is one bar holding the jumps and all three settings", () => {
    expect(dock).toBeTruthy();
    expect(dock?.querySelector("nav")).toBeTruthy();
    expect(dock?.querySelector("#speed")).toBeTruthy();
    expect(dock?.querySelector("#palette")).toBeTruthy();
    expect(dock?.querySelector("#theme")).toBeTruthy();
  });

  it("can reach every section, and every link lands somewhere real", () => {
    const jumps = [...(dock?.querySelectorAll<HTMLAnchorElement>("[data-jump]") ?? [])];
    const targets = jumps.map((jump) => jump.dataset.jump);
    for (const stage of PLAYERS) expect(targets).toContain(`stage-${stage}`);
    expect(targets).toContain("source-section");
    expect(targets).toContain("limits");

    for (const jump of jumps) {
      // A dead anchor is a dead end the links check would not catch, since it
      // never leaves the page.
      expect(document.getElementById(jump.dataset.jump ?? ""), jump.href).toBeTruthy();
      expect(jump.getAttribute("href")).toBe(`#${jump.dataset.jump}`);
    }
  });

  it("names each jump for a screen reader, whichever label is showing", () => {
    // A chip reads "3" on a phone, so the word has to stay in the tree beside
    // it: CSS clips whichever label is not showing, and neither is ever removed
    // or hidden with aria. Nine unnamed links is what the other way looked like.
    for (const jump of dock?.querySelectorAll("[data-jump]") ?? []) {
      const short = jump.querySelector(".jump-short");
      const long = jump.querySelector(".jump-long");
      expect(short?.hasAttribute("aria-hidden")).toBe(false);
      expect(long?.hasAttribute("aria-hidden")).toBe(false);
      expect(long?.textContent?.trim().length).toBeGreaterThan(2);
      expect(jump.textContent?.trim().length).toBeGreaterThan(2);
    }
  });

  it("leaves nothing behind in the old top bar", () => {
    const topbar = document.querySelector(".topbar");
    expect(topbar?.querySelector("nav")).toBeNull();
    expect(topbar?.querySelector("#speed")).toBeNull();
    // One nav landmark, in one place, so "Sections" means one list.
    expect(document.querySelectorAll("nav")).toHaveLength(1);
  });
});

describe("the page's own settings", () => {
  it("has one speed control for all six players, not one each", () => {
    const speed = document.querySelector("#speed");
    expect(speed?.getAttribute("type")).toBe("range");
    expect(document.querySelector('label[for="speed"]')?.textContent).toBeTruthy();
    // The range's stops are the rates in prefs.ts; a mismatch would let the
    // slider ask for a speed that does not exist.
    expect(speed?.getAttribute("min")).toBe("0");
    expect(speed?.getAttribute("max")).toBe(String(SPEEDS.length - 1));
    expect(document.querySelectorAll('input[type="range"][id^="speed"]')).toHaveLength(1);
  });

  it("has a theme toggle that says what pressing it will do", () => {
    const toggle = document.querySelector("#theme");
    expect(toggle?.tagName).toBe("BUTTON");
    expect(toggle?.getAttribute("type")).toBe("button");
    expect(toggle?.textContent?.trim()).toMatch(/MODE$/);
  });

  it("offers every palette, by name, in a real select", () => {
    const select = document.querySelector<HTMLSelectElement>("#palette");
    expect(select?.tagName).toBe("SELECT");
    expect(document.querySelector('label[for="palette"]')?.textContent).toBeTruthy();
    const options = [...(select?.querySelectorAll("option") ?? [])];
    expect(options.map((option) => option.getAttribute("value"))).toEqual(
      PALETTES.map((palette) => palette.id),
    );
    expect(options.map((option) => option.textContent?.trim())).toEqual(
      PALETTES.map((palette) => palette.name),
    );
  });

  it("ships every palette's colours in the document itself", () => {
    // Inline in the head, so the first paint is already the right colours — a
    // stylesheet request later would be a flash of the wrong palette.
    const head = /<head[\s\S]*?<\/head>/.exec(html)?.[0] ?? "";
    for (const palette of PALETTES) {
      expect(head).toContain(`:root[data-palette="${palette.id}"]{`);
      expect(head).toContain(palette.dark.bg);
      expect(head).toContain(palette.light.bg);
    }
    // And nothing outside the head is allowed to define them, or two sources of
    // truth start disagreeing.
    expect(html.split(':root[data-palette="brutalist"]{').length - 1).toBe(1);
  });

  it("settles the theme in the head, before the page paints", () => {
    // Reading it in the deferred bundle instead would show the wrong theme for
    // a frame on every load, which is the whole reason this script is inline.
    const head = /<head[\s\S]*?<\/head>/.exec(html)?.[0] ?? "";
    expect(head).toContain(THEME_KEY);
    expect(head).toContain("prefers-color-scheme: light");
    // The palette is settled there too, from the same storage.
    expect(head).toContain(PALETTE_KEY);
    // That inline copy cannot import prefs.ts, so the key it uses is pinned
    // here: drift would silently split the stored preference in two.
    expect(html.split(THEME_KEY).length - 1).toBeGreaterThan(0);
  });
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
    for (const missing of [
      "structs",
      "linker",
      "register allocation",
      "coalescing",
      "bounds",
    ]) {
      expect(text.toLowerCase(), missing).toContain(missing);
    }
  });

  it("explains itself when JavaScript is off", () => {
    const noscript = document.querySelector("noscript")?.textContent ?? "";
    expect(noscript.length).toBeGreaterThan(80);
  });
});
