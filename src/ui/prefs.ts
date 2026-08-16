/**
 * The things the visitor gets to decide: how fast a stage plays, which palette
 * the page wears, and whether that palette is dark or light.
 *
 * Neither is compiler state, so neither belongs to a stage — one speed drives
 * all six players, and the theme is the whole page. Both are remembered, and
 * remembering is best-effort: `localStorage` throws outright in a sandboxed
 * frame or with site data blocked, and a preference is never worth a page that
 * does not start.
 */

export const THEME_KEY = "compiling-c:theme";
export const SPEED_KEY = "compiling-c:speed";
export const PALETTE_KEY = "compiling-c:palette";

export type Theme = "dark" | "light";

/**
 * Play rates, slowest first. The commentary is a sentence per step, so the slow
 * end has to leave time to read it and the fast end is for a second watch.
 * These are periods, not multipliers: `label` is the multiplier the page shows.
 */
export const SPEEDS = [
  { label: "0.5", ms: 1800 },
  { label: "0.75", ms: 1200 },
  { label: "1", ms: 900 },
  { label: "1.5", ms: 600 },
  { label: "2", ms: 450 },
  { label: "3", ms: 300 },
] as const;

/** 1× — the rate every step's commentary was written to be read at. */
export const DEFAULT_SPEED = 2;

export function readStored(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function store(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // A preference that cannot be saved is still a preference for this visit.
  }
}

/**
 * Anything unparseable — nothing stored, a hand-edited value, an old key —
 * falls back to 1×. The empty cases are checked first on purpose: `Number(null)`
 * and `Number("")` are both 0, which is a valid index, so leaving them to the
 * range check silently starts every first-time visitor at half speed.
 */
export function speedFrom(raw: string | null): number {
  if (raw === null || raw.trim() === "") return DEFAULT_SPEED;
  const index = Number(raw);
  if (!Number.isInteger(index) || index < 0 || index >= SPEEDS.length) {
    return DEFAULT_SPEED;
  }
  return index;
}

/**
 * A stored choice wins; otherwise the system preference does. The same rule runs
 * inline in the document head before first paint, which is what stops the page
 * flashing dark before turning light.
 */
export function themeFrom(raw: string | null, prefersLight: boolean): Theme {
  if (raw === "light" || raw === "dark") return raw;
  return prefersLight ? "light" : "dark";
}
