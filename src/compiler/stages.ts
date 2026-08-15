import type { StageId } from "./types";

/**
 * What each stage actually consumes and produces.
 *
 * This exists because the page was quietly misleading. Every stage shows your
 * source text beside its output, under a label that said "what it is reading" —
 * but only the preprocessor reads your source. The scanner reads preprocessed
 * text, the parser reads tokens, and lowering has never seen a character of C in
 * its life: it walks the syntax tree the parser built.
 *
 * The echo is provenance, not input. These strings are the input, and
 * `spec/compiler.test.ts` checks the chain hangs together: everything a stage
 * consumes has to be something an earlier stage produced.
 */

export const SOURCE = "the characters you typed";

export type StageIO = {
  /** Every artefact this stage reads. More than one is normal. */
  consumes: string[];
  produces: string;
};

export const STAGE_IO: Record<StageId, StageIO> = {
  preprocess: {
    consumes: [SOURCE],
    produces: "preprocessed text",
  },
  scan: {
    consumes: ["preprocessed text"],
    produces: "a token list",
  },
  parse: {
    consumes: ["a token list"],
    produces: "a syntax tree",
  },
  /**
   * The analyser does not replace the tree. It annotates it, which is why the
   * next stage lists both.
   */
  semantics: {
    consumes: ["a syntax tree"],
    produces: "a symbol table and types",
  },
  ir: {
    consumes: ["a syntax tree", "a symbol table and types"],
    produces: "three-address IR",
  },
  codegen: {
    consumes: ["three-address IR", "a symbol table and types"],
    produces: "x86-64 assembly",
  },
};
