import { describe, expect, it } from "vitest";
import {
  DEFAULT_PALETTE,
  PALETTES,
  type PaletteTokens,
  TEXT_TOKENS,
  paletteCss,
  paletteFrom,
} from "../src/ui/palettes";

/**
 * A palette is a promise that the page is still readable in it, and this is the
 * sensor for that promise. Every palette on the page is checked, both variants,
 * every token — so adding one is a matter of adding it and reading the failures,
 * rather than eyeballing a screenshot and hoping.
 *
 * axe checks the same thing in a real browser, but only for the palette that is
 * actually on screen. This one covers all of them, in a millisecond.
 */

const AA = 4.5;

function luminance(hex: string): number {
  const channels = [1, 3, 5]
    .map((at) => Number.parseInt(hex.slice(at, at + 2), 16) / 255)
    .map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

const variants = PALETTES.flatMap((palette) => [
  { palette, mode: "dark" as const, tokens: palette.dark },
  { palette, mode: "light" as const, tokens: palette.light },
]);

describe("every palette", () => {
  it("is offered under a name, and each id appears once", () => {
    const ids = PALETTES.map((palette) => palette.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(DEFAULT_PALETTE);
    for (const palette of PALETTES) {
      expect(palette.name.length, palette.id).toBeGreaterThan(2);
      expect(palette.id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("ships a dark and a light variant, since the toggle is not the palette", () => {
    for (const { palette, mode, tokens } of variants) {
      expect(tokens.label.length, `${palette.id} ${mode}`).toBeGreaterThan(2);
    }
    // Dark really is darker: a "light" variant that is not would make the
    // toggle a lie even if every ratio passed.
    for (const palette of PALETTES) {
      expect(luminance(palette.dark.bg), palette.id).toBeLessThan(
        luminance(palette.light.bg),
      );
    }
  });

  it("clears 4.5:1 for every colour that carries text", () => {
    const failures: string[] = [];
    for (const { palette, mode, tokens } of variants) {
      for (const token of TEXT_TOKENS) {
        const ratio = contrast(tokens[token], tokens.bg);
        if (ratio < AA) {
          failures.push(
            `${palette.id} ${mode} ${token} ${tokens[token]} on ${tokens.bg} is ${ratio.toFixed(2)}:1`,
          );
        }
      }
    }
    expect(failures).toEqual([]);
  });

  it("keeps whatever sits on the accent legible on it", () => {
    // The accent is a fill, and something always sits on it — the marked source,
    // the current rule, a hovered link. `--bg` is not that thing: it is white in
    // a light palette, and white on yellow is the bug that keeps coming back.
    for (const { palette, mode, tokens } of variants) {
      const ratio = contrast(tokens.onAccent, tokens.accent);
      expect(ratio, `${palette.id} ${mode} on-accent`).toBeGreaterThanOrEqual(AA);
    }
  });

  it("gives the accent an ink that is not the fill in a light palette", () => {
    // Yellow letters on paper are invisible however good the fill looks.
    for (const { palette, mode, tokens } of variants) {
      expect(
        contrast(tokens.accentInk, tokens.bg),
        `${palette.id} ${mode} accent ink`,
      ).toBeGreaterThanOrEqual(AA);
    }
  });

  it("keeps its borders visible without pretending they carry text", () => {
    for (const { palette, mode, tokens } of variants) {
      const ratio = contrast(tokens.dimmer, tokens.bg);
      expect(ratio, `${palette.id} ${mode} dimmer`).toBeGreaterThan(1.15);
      // If it were text-legible it should have been `dim`; if it were invisible
      // the boxes would vanish. It is a border, and it stays one.
      expect(ratio, `${palette.id} ${mode} dimmer`).toBeLessThan(AA);
    }
  });

  it("leaves selected text readable on the selection fill", () => {
    // `--dimmer` is a border everywhere except the editor's selection, where it
    // sits behind real text. That is not a WCAG-graded pair — it is transient
    // and user-invoked — but text you cannot read while dragging over it is
    // still text you cannot read.
    for (const { palette, mode, tokens } of variants) {
      expect(
        contrast(tokens.fg, tokens.dimmer),
        `${palette.id} ${mode} selection`,
      ).toBeGreaterThan(3);
    }
  });

  it("tells its syntax kinds apart", () => {
    // A palette where keywords and numbers are the same colour is a palette
    // that has quietly stopped highlighting anything.
    const kinds = ["keyword", "number", "literal", "comment", "directive"] as const;
    for (const { palette, mode, tokens } of variants) {
      const used = new Set(kinds.map((kind) => tokens[kind]));
      expect(used.size, `${palette.id} ${mode}`).toBe(kinds.length);
    }
  });
});

describe("the palettes as CSS", () => {
  const css = paletteCss();

  it("writes a block per palette per mode, keyed by the attribute", () => {
    for (const palette of PALETTES) {
      expect(css).toContain(`:root[data-palette="${palette.id}"]{`);
      expect(css).toContain(`:root[data-palette="${palette.id}"][data-theme="light"]{`);
    }
  });

  it("names every custom property the stylesheet reads", () => {
    // Miss one and the page falls back to whatever the last palette set, which
    // looks like a colour bug and is really a missing line here.
    const properties = [
      "--bg",
      "--fg",
      "--dim",
      "--dimmer",
      "--accent",
      "--accent-ink",
      "--on-accent",
      "--bad",
      "--syntax-keyword",
      "--syntax-number",
      "--syntax-literal",
      "--syntax-comment",
      "--syntax-directive",
      "--syntax-punct",
    ];
    for (const property of properties) {
      const times = css.split(`${property}:`).length - 1;
      expect(times, property).toBe(PALETTES.length * 2);
    }
  });

  it("emits colours and nothing that could close the tag it lives in", () => {
    // It goes into the document head with `set:html`, so it has to be data.
    expect(css).not.toMatch(/[<>]/);
    for (const value of css.matchAll(/:(#[0-9a-f]{6}|dark|light);?/g)) {
      expect(value[1]).toBeTruthy();
    }
  });
});

describe("choosing a palette", () => {
  const known = PALETTES.map((palette) => palette.id);

  it("takes a stored id and ignores anything else", () => {
    expect(paletteFrom("nord", known)).toBe("nord");
    expect(paletteFrom(null, known)).toBe(DEFAULT_PALETTE);
    expect(paletteFrom("", known)).toBe(DEFAULT_PALETTE);
    // A palette that was removed, or a hand-edited key.
    expect(paletteFrom("solarised-neon", known)).toBe(DEFAULT_PALETTE);
  });
});

describe("the tokens themselves", () => {
  it("are all six-digit hex, so the contrast maths above means anything", () => {
    const every: (keyof PaletteTokens)[] = [
      "bg",
      "fg",
      "dim",
      "dimmer",
      "accent",
      "accentInk",
      "onAccent",
      "bad",
      "keyword",
      "number",
      "literal",
      "comment",
      "directive",
      "punct",
    ];
    for (const { palette, mode, tokens } of variants) {
      for (const token of every) {
        expect(tokens[token], `${palette.id} ${mode} ${token}`).toMatch(
          /^#[0-9a-f]{6}$/,
        );
      }
    }
  });
});
