import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { formatAsm } from "../src/compiler/codegen";
import { compile } from "../src/compiler/pipeline";

/**
 * The differential check: does the assembly actually DO what the C says?
 *
 * Every other test in this repo compares strings — a token stream, an IR
 * listing, an instruction. None of them would notice a `setl` that should have
 * been `setg`, a frame offset four bytes out, or an index scaled by the wrong
 * element size. Those are exactly the mistakes pointers and arrays invite.
 *
 * So this one assembles what the compiler emits with a real assembler, runs it,
 * and compares the exit status against a binary gcc built from the same source.
 * Two independent compilers agreeing on the answer is a much stronger claim than
 * any assertion about text.
 *
 * It needs gcc, which CI does not promise, so it skips there rather than
 * failing. Locally it runs on every `pnpm check`.
 */

const PROGRAMS = resolve("spec/programs");

function hasGcc(): boolean {
  try {
    execFileSync("gcc", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const gccAvailable = hasGcc();
const sources = readdirSync(PROGRAMS).filter((name) => name.endsWith(".c"));

describe.skipIf(!gccAvailable)("the emitted assembly, assembled and run", () => {
  const work = gccAvailable ? mkdtempSync(join(tmpdir(), "six-rewrites-")) : "";

  /** Build with a real toolchain and report the exit status. */
  function run(file: string, args: string[]): number {
    const built = join(work, `${file}.bin`);
    const build = spawnSync("gcc", [...args, "-no-pie", "-o", built], {
      encoding: "utf8",
    });
    expect(build.status, `gcc refused to build ${file}:\n${build.stderr}`).toBe(0);
    return spawnSync(built, [], { encoding: "utf8" }).status ?? -1;
  }

  it("has programs to check", () => {
    expect(sources.length).toBeGreaterThan(4);
  });

  for (const name of sources) {
    it(`${name} agrees with gcc`, () => {
      const source = readFileSync(join(PROGRAMS, name), "utf8");
      const result = compile(source);
      expect(
        result.error,
        `${name} did not compile: ${result.error?.message ?? ""}`,
      ).toBeUndefined();

      const assembly = result.codegen.lines.map(formatAsm).join("\n");
      const assemblyPath = join(work, `${name}.s`);
      writeFileSync(assemblyPath, `${assembly}\n`);

      const ours = run(`${name}-ours`, [assemblyPath]);
      const reference = run(`${name}-gcc`, [join(PROGRAMS, name)]);
      expect(ours, `${name}: ours returned ${ours}, gcc returned ${reference}`).toBe(
        reference,
      );

      // Three independent implementations, one answer: our assembly through a
      // real assembler, gcc's own build, and the interpreter that runs the IR on
      // the page. Any two agreeing could be a shared mistake; three is evidence.
      const interpreted = result.run?.value ?? 0;
      expect(
        (((interpreted % 256) + 256) % 256),
        `${name}: the interpreter returned ${interpreted}, the binaries returned ${reference}`,
      ).toBe(reference);
      expect(result.run?.error?.message).toBeUndefined();
    });
  }
});

describe.skipIf(gccAvailable)("the differential check", () => {
  it("is skipped without gcc, and says so", () => {
    // Deliberately visible: a check that cannot run is not a check that passed.
    expect(gccAvailable).toBe(false);
  });
});
