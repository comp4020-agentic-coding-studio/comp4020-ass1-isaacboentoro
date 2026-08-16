/**
 * The colour palettes the page can wear.
 *
 * One of these is the whole page's colour, and every one of them ships both a
 * dark and a light variant, because the theme toggle is orthogonal to the choice
 * of palette. `brutalist` is this page's own; the rest are the published
 * palettes of open-source projects, used as they publish them EXCEPT where a
 * colour could not clear 4.5:1 against its own background. Those are nudged
 * along their own hue until they do, and the comment above each variant says
 * exactly which and by how much — a palette that reads well in an editor at 14px
 * on a small window is not automatically legible as body text, and a page that
 * quietly shipped 3:1 text because upstream did would be the page's fault, not
 * upstream's.
 *
 * The tokens are the ones `global.css` uses. `accent` is the highlight fill,
 * `accentInk` is the accent used as text or border, and `onAccent` is what sits
 * ON the fill — three roles the brutalist palette taught us not to conflate.
 * `dimmer` is borders only, which is why it is the one token with no contrast
 * floor.
 *
 * `spec/palettes.test.ts` re-derives every ratio here. Add a palette by adding
 * it below; if it fails, the test names the token and the number.
 */

export type PaletteTokens = {
  label: string;
  bg: string;
  fg: string;
  dim: string;
  dimmer: string;
  accent: string;
  accentInk: string;
  onAccent: string;
  bad: string;
  keyword: string;
  number: string;
  literal: string;
  comment: string;
  directive: string;
  punct: string;
};

export type Palette = {
  id: string;
  name: string;
  dark: PaletteTokens;
  light: PaletteTokens;
};

/** Everything but `dimmer`, which never carries text. */
export const TEXT_TOKENS = [
  "fg",
  "dim",
  "accentInk",
  "bad",
  "keyword",
  "number",
  "literal",
  "comment",
  "directive",
  "punct",
] as const;

export const DEFAULT_PALETTE = "brutalist";

export const PALETTES: Palette[] = [
  {
    id: "brutalist",
    name: "Brutalist",
    // The page's own: two tones and one accent, black and white by default and
    // ink on paper in light mode. Everything else here is a guest.
    dark: {
      label: "Black",
      bg: "#000000",
      fg: "#ffffff",
      dim: "#8a8a8a",
      dimmer: "#3a3a3a",
      accent: "#f2ff00",
      accentInk: "#f2ff00",
      onAccent: "#000000",
      bad: "#ff3b3b",
      keyword: "#8ecdf5",
      number: "#f5a3c7",
      literal: "#a8e08a",
      comment: "#8f9f9f",
      directive: "#cbb2ff",
      punct: "#9aa0a6",
    },
    light: {
      label: "Paper",
      bg: "#ebe8e1",
      fg: "#14130f",
      dim: "#565148",
      dimmer: "#c3bfb4",
      accent: "#f2ff00",
      accentInk: "#5f5c00",
      onAccent: "#000000",
      bad: "#b01010",
      keyword: "#0b4f8a",
      number: "#8f1552",
      literal: "#1f5f18",
      comment: "#525f59",
      directive: "#512aa4",
      punct: "#4e524f",
    },
  },
  {
    id: "catppuccin",
    name: "Catppuccin",
    /* dark: nudged for contrast — comment #6c7086->#84889c (3.36) */
    dark: {
      label: "Mocha",
      bg: "#1e1e2e",
      fg: "#cdd6f4",
      dim: "#a6adc8",
      dimmer: "#45475a",
      accent: "#f9e2af",
      accentInk: "#f9e2af",
      onAccent: "#11111b",
      bad: "#f38ba8",
      keyword: "#cba6f7",
      number: "#fab387",
      literal: "#a6e3a1",
      comment: "#84889c",
      directive: "#f5c2e7",
      punct: "#89b4fa",
    },
    /* light: nudged for contrast — dim #6c6f85->#676a7f (4.37); number #fe640b->#bc4501 (2.64); literal #40a02b->#307820 (2.96); comment #8c8fa1->#676b7e (2.83); directive #ea76cb->#c31e97 (2.34); accentInk #df8e1d->#976014 */
    light: {
      label: "Latte",
      bg: "#eff1f5",
      fg: "#4c4f69",
      dim: "#676a7f",
      dimmer: "#bcc0cc",
      accent: "#df8e1d",
      accentInk: "#976014",
      onAccent: "#11111b",
      bad: "#d20f39",
      keyword: "#8839ef",
      number: "#bc4501",
      literal: "#307820",
      comment: "#676b7e",
      directive: "#c31e97",
      punct: "#1e66d5",
    },
  },
  {
    id: "nord",
    name: "Nord",
    /* dark: nudged for contrast — bad #bf616a->#d18d93 (3.05); number #b48ead->#b894b1 (4.41); comment #4c566a->#96a0b4 (1.69) */
    dark: {
      label: "Polar Night",
      bg: "#2e3440",
      fg: "#eceff4",
      dim: "#d8dee9",
      dimmer: "#4c566a",
      accent: "#ebcb8b",
      accentInk: "#ebcb8b",
      onAccent: "#11111b",
      bad: "#d18d93",
      keyword: "#81a1c1",
      number: "#b894b1",
      literal: "#a3be8c",
      comment: "#96a0b4",
      directive: "#88c0d0",
      punct: "#8fbcbb",
    },
    /* light: nudged for contrast — bad #bf616a->#b04751 (3.55); keyword #5e81ac->#4d6d95 (3.50); number #b48ead->#8a5c82 (2.46); literal #a3be8c->#577140 (1.77); directive #88c0d0->#357385 (1.74); punct #8fbcbb->#457372 (1.81); accentInk #ebcb8b->#886318 */
    light: {
      label: "Snow Storm",
      bg: "#eceff4",
      fg: "#2e3440",
      dim: "#4c566a",
      dimmer: "#d8dee9",
      accent: "#ebcb8b",
      accentInk: "#886318",
      onAccent: "#11111b",
      bad: "#b04751",
      keyword: "#4d6d95",
      number: "#8a5c82",
      literal: "#577140",
      comment: "#4c566a",
      directive: "#357385",
      punct: "#457372",
    },
  },
  {
    id: "gruvbox",
    name: "Gruvbox",
    /* dark: nudged for contrast — bad #fb4934->#fb5b48 (4.29); comment #928374->#9d9082 (4.02) */
    dark: {
      label: "Dark",
      bg: "#282828",
      fg: "#ebdbb2",
      dim: "#bdae93",
      dimmer: "#504945",
      accent: "#fabd2f",
      accentInk: "#fabd2f",
      onAccent: "#11111b",
      bad: "#fb5b48",
      keyword: "#d3869b",
      number: "#fe8019",
      literal: "#b8bb26",
      comment: "#9d9082",
      directive: "#8ec07c",
      punct: "#83a598",
    },
    /* light: nudged for contrast — literal #79740e->#706b0d (4.29); comment #7c6f64->#766a5f (4.29); directive #427b58->#3e7453 (4.40); accentInk #d79921->#8c6415 */
    light: {
      label: "Light",
      bg: "#fbf1c7",
      fg: "#3c3836",
      dim: "#665c54",
      dimmer: "#d5c4a1",
      accent: "#d79921",
      accentInk: "#8c6415",
      onAccent: "#11111b",
      bad: "#9d0006",
      keyword: "#8f3f71",
      number: "#af3a03",
      literal: "#706b0d",
      comment: "#766a5f",
      directive: "#3e7453",
      punct: "#076678",
    },
  },
  {
    id: "solarized",
    name: "Solarized",
    /* dark: nudged for contrast — bad #dc322f->#e66a68 (3.25); keyword #268bd2->#3295da (4.08); number #d33682->#de68a1 (3.30); comment #586e75->#7a939b (2.79); directive #6c71c4->#858ace (3.43) */
    dark: {
      label: "Dark",
      bg: "#002b36",
      fg: "#93a1a1",
      dim: "#839496",
      dimmer: "#073642",
      accent: "#b58900",
      accentInk: "#b58900",
      onAccent: "#11111b",
      bad: "#e66a68",
      keyword: "#3295da",
      number: "#de68a1",
      literal: "#859900",
      comment: "#7a939b",
      directive: "#858ace",
      punct: "#2aa198",
    },
    /* light: nudged for contrast — dim #657b83->#5e737a (4.13); bad #dc322f->#d72724 (4.29); keyword #268bd2->#2074af (3.41); number #d33682->#c92c78 (4.21); literal #859900->#667500 (2.97); comment #93a1a1->#627171 (2.48); directive #6c71c4->#6166c0 (4.06); punct #2aa198->#1f7972 (2.93); accentInk #b58900->#8c6a00 */
    /* light: base2 #eee8d5 is 1.14:1 on base3 — invisible as a border on a page
       made of borders — so the frames use a darker step of the same hue. */
    light: {
      label: "Light",
      bg: "#fdf6e3",
      fg: "#586e75",
      dim: "#5e737a",
      dimmer: "#d3cbb4",
      accent: "#b58900",
      accentInk: "#8c6a00",
      onAccent: "#11111b",
      bad: "#d72724",
      keyword: "#2074af",
      number: "#c92c78",
      literal: "#667500",
      comment: "#627171",
      directive: "#6166c0",
      punct: "#1f7972",
    },
  },
  {
    id: "dracula",
    name: "Dracula",
    /* dark: nudged for contrast — bad #ff5555->#ff5a5a (4.53); comment #6272a4->#8692b9 (3.03) */
    dark: {
      label: "Dracula",
      bg: "#282a36",
      fg: "#f8f8f2",
      dim: "#bdc0d0",
      dimmer: "#44475a",
      accent: "#f1fa8c",
      accentInk: "#f1fa8c",
      onAccent: "#11111b",
      bad: "#ff5a5a",
      keyword: "#ff79c6",
      number: "#bd93f9",
      literal: "#50fa7b",
      comment: "#8692b9",
      directive: "#8be9fd",
      punct: "#ffb86c",
    },
    light: {
      label: "Alucard",
      bg: "#fffbeb",
      fg: "#1f1f1f",
      dim: "#6c664b",
      dimmer: "#cfcfc2",
      accent: "#846e15",
      accentInk: "#846e15",
      onAccent: "#ffffff",
      bad: "#cb3a2a",
      keyword: "#a3144d",
      number: "#644ac9",
      literal: "#14710a",
      comment: "#6c664b",
      directive: "#036a96",
      punct: "#a34d14",
    },
  },
  {
    id: "tokyonight",
    name: "Tokyo Night",
    /* dark: nudged for contrast — comment #565f89->#7b83ac (2.76) */
    dark: {
      label: "Night",
      bg: "#1a1b26",
      fg: "#c0caf5",
      dim: "#a9b1d6",
      dimmer: "#414868",
      accent: "#e0af68",
      accentInk: "#e0af68",
      onAccent: "#11111b",
      bad: "#f7768e",
      keyword: "#bb9af7",
      number: "#ff9e64",
      literal: "#9ece6a",
      comment: "#7b83ac",
      directive: "#7dcfff",
      punct: "#7aa2f7",
    },
    /* light: nudged for contrast — fg #3760bf->#365ebb (4.52); dim #6172b0->#4f609e (3.57); bad #f52a65->#c40940 (3.01); keyword #9854f1->#7e2aee (3.33); number #b15c00->#984f00 (3.69); literal #587539->#506b34 (4.04); comment #848cb5->#576090 (2.54); directive #007197->#00698d (4.26); punct #2e7de9->#155fc5 (3.11); accentInk #8c6c3e->#7a5e36 */
    light: {
      label: "Day",
      bg: "#e1e2e7",
      fg: "#365ebb",
      dim: "#4f609e",
      dimmer: "#b6bfe2",
      accent: "#8c6c3e",
      accentInk: "#7a5e36",
      onAccent: "#ffffff",
      bad: "#c40940",
      keyword: "#7e2aee",
      number: "#984f00",
      literal: "#506b34",
      comment: "#576090",
      directive: "#00698d",
      punct: "#155fc5",
    },
  },
];

/**
 * The palettes as CSS, emitted into the document head at build time so that the
 * page is already wearing the right colours on its first paint. This is the only
 * place the tokens become CSS: `global.css` names them, never values.
 */
export function paletteCss(): string {
  const block = (
    selector: string,
    tokens: PaletteTokens,
    scheme: "dark" | "light",
  ): string =>
    [
      `${selector}{`,
      // Form controls and scrollbars come from the platform, and this is what
      // tells it which way round this palette runs.
      `color-scheme:${scheme};`,
      `--bg:${tokens.bg};`,
      `--fg:${tokens.fg};`,
      `--dim:${tokens.dim};`,
      `--dimmer:${tokens.dimmer};`,
      `--accent:${tokens.accent};`,
      `--accent-ink:${tokens.accentInk};`,
      `--on-accent:${tokens.onAccent};`,
      `--bad:${tokens.bad};`,
      `--syntax-keyword:${tokens.keyword};`,
      `--syntax-number:${tokens.number};`,
      `--syntax-literal:${tokens.literal};`,
      `--syntax-comment:${tokens.comment};`,
      `--syntax-directive:${tokens.directive};`,
      `--syntax-punct:${tokens.punct};`,
      "}",
    ].join("");

  const rules: string[] = [];
  for (const palette of PALETTES) {
    const at = `:root[data-palette="${palette.id}"]`;
    // The dark block also answers for a page whose theme has not been settled
    // yet; the light one carries an extra attribute, so it always wins over it.
    rules.push(block(at, palette.dark, "dark"));
    rules.push(block(`${at}[data-theme="light"]`, palette.light, "light"));
  }
  return rules.join("\n");
}

/** A stored or typed palette id, or the default if it names nothing we have. */
export function paletteFrom(raw: string | null, known: string[]): string {
  return raw !== null && known.includes(raw) ? raw : DEFAULT_PALETTE;
}
