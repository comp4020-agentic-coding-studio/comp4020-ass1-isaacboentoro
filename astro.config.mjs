import { readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "astro/config";

// The deployed site lives under a path (username.github.io/<repo>/), so every
// root-absolute asset URL Astro emits — /_astro/* — resolves against the org
// root and 404s live while looking fine locally.
//
// `base` is the documented fix, but it breaks the CI links check, which runs
// `linkinator ./dist` and serves dist/ as the root. `build.assetsPrefix` is
// ignored by astro:assets, so it can't cover the Image component. This rewrites
// the emitted files instead: each reference becomes relative to the file that
// holds it, which is correct under any path prefix and for both checks. CSS is
// rewritten too, since @font-face url()s resolve against the stylesheet rather
// than the page.
function relativeAssetUrls() {
  return {
    name: "relative-asset-urls",
    hooks: {
      "astro:build:done": async ({ dir, logger }) => {
        const root = fileURLToPath(dir);
        const entries = await readdir(root, { recursive: true, withFileTypes: true });
        let rewritten = 0;

        for (const entry of entries) {
          if (!entry.isFile() || !/\.(html|css)$/.test(entry.name)) continue;

          const file = join(entry.parentPath, entry.name);
          const source = await readFile(file, "utf8");
          // how to climb from this file's directory back to dist/
          const prefix = relative(dirname(file), root).split(sep).join("/") || ".";
          const output = source.replace(/(?<!\.)\/_astro\//g, `${prefix}/_astro/`);

          if (output !== source) {
            await writeFile(file, output);
            rewritten += 1;
          }
        }

        logger.info(`rewrote asset URLs in ${rewritten} file(s) to be path-relative`);
      },
    },
  };
}

export default defineConfig({
  site: "https://comp4020-agentic-coding-studio.github.io/comp4020-ass1-isaacboentoro",
  integrations: [relativeAssetUrls()],
  image: {
    layout: "constrained",
    responsiveStyles: true,
    breakpoints: [480, 768, 1024, 1280],
  },
});
