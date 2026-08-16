/**
 * The x86-64 general-purpose registers, and the rules the System V ABI attaches
 * to them.
 *
 * This is the one place a register name is written down. Codegen asks for a
 * register at a width and the allocator asks which ones it is allowed to hand
 * out; neither spells `eax` itself, because the same register has four names and
 * picking the wrong one is a bug no string test can see.
 *
 * `rsp` and `rbp` are not here. The stack pointer is the machine's and the frame
 * pointer is what every local is addressed from, so neither is ever available to
 * hold a value.
 */

export type Reg =
  | "rax"
  | "rbx"
  | "rcx"
  | "rdx"
  | "rsi"
  | "rdi"
  | "r8"
  | "r9"
  | "r10"
  | "r11"
  | "r12"
  | "r13"
  | "r14"
  | "r15";

/** [8 bytes, 4 bytes, 2 bytes, 1 byte]. The legacy four are the irregular ones. */
const NAMES: Record<Reg, [string, string, string, string]> = {
  rax: ["rax", "eax", "ax", "al"],
  rbx: ["rbx", "ebx", "bx", "bl"],
  rcx: ["rcx", "ecx", "cx", "cl"],
  rdx: ["rdx", "edx", "dx", "dl"],
  rsi: ["rsi", "esi", "si", "sil"],
  rdi: ["rdi", "edi", "di", "dil"],
  r8: ["r8", "r8d", "r8w", "r8b"],
  r9: ["r9", "r9d", "r9w", "r9b"],
  r10: ["r10", "r10d", "r10w", "r10b"],
  r11: ["r11", "r11d", "r11w", "r11b"],
  r12: ["r12", "r12d", "r12w", "r12b"],
  r13: ["r13", "r13d", "r13w", "r13b"],
  r14: ["r14", "r14d", "r14w", "r14b"],
  r15: ["r15", "r15d", "r15w", "r15b"],
};

/** The name of one register at one width: `rax`, `eax`, `ax` or `al`. */
export function regName(reg: Reg, width: number): string {
  const names = NAMES[reg];
  if (width >= 8) return names[0];
  if (width >= 4) return names[1];
  if (width >= 2) return names[2];
  return names[3];
}

/**
 * Two registers the allocator never hands out, so that every instruction can
 * always borrow one.
 *
 * A spilled value has to be loaded before it can be added to anything, and
 * `add [rbp-8], [rbp-12]` is not an instruction on this machine — x86 allows one
 * memory operand, not two. Reserving two registers costs two colours and buys
 * the guarantee that codegen never has to ask the allocator for help.
 */
export const SCRATCH_A: Reg = "r10";
export const SCRATCH_B: Reg = "r11";

/**
 * The called function may destroy these. A value that has to survive a call
 * therefore cannot live in one, which is the single most visible thing the
 * interference graph learns.
 */
export const CALLER_SAVED: Reg[] = [
  "rax",
  "rcx",
  "rdx",
  "rsi",
  "rdi",
  "r8",
  "r9",
  "r10",
  "r11",
];

/** The callee has to give these back, so using one costs a save and a restore. */
export const CALLEE_SAVED: Reg[] = ["rbx", "r12", "r13", "r14", "r15"];

/** Integer and pointer arguments, in order. The seventh onwards would go on the stack. */
export const ARG_REGISTERS: Reg[] = ["rdi", "rsi", "rdx", "rcx", "r8", "r9"];

/** `idiv` reads and writes this pair whether you asked it to or not. */
export const DIV_CLOBBERS: Reg[] = ["rax", "rdx"];

/**
 * What the allocator may hand out, in the order it prefers.
 *
 * Caller-saved first: a register from that half is free, while a callee-saved one
 * costs two extra instructions in every function that touches it. A program with
 * no calls and few values therefore never saves anything, and one under real
 * pressure reaches into `rbx` and the high registers only when it has to.
 */
export const ALLOCATABLE: Reg[] = [
  "rax",
  "rcx",
  "rdx",
  "rsi",
  "rdi",
  "r8",
  "r9",
  "rbx",
  "r12",
  "r13",
  "r14",
  "r15",
];

/** How many colours the graph gets. Twelve: fourteen registers, less the two scratch. */
export const COLOURS = ALLOCATABLE.length;
