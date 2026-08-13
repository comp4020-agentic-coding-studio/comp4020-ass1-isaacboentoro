/**
 * C's type system, or the corner of it this explainer covers.
 *
 * Types stop being a label the moment pointers arrive: `p + 1` has to know how
 * big the thing pointed at is, `a[i]` has to know how far apart the elements
 * sit, and the frame layout has to know how much room a name needs and how it
 * must be aligned. All of that comes from here.
 *
 * Sizes are the x86-64 System V ones, because that is what codegen emits.
 */

export type CType =
  | { kind: "int" }
  | { kind: "char" }
  | { kind: "void" }
  | { kind: "pointer"; to: CType }
  | { kind: "array"; of: CType; length: number };

export const INT: CType = { kind: "int" };
export const CHAR: CType = { kind: "char" };
export const VOID: CType = { kind: "void" };

export function pointerTo(to: CType): CType {
  return { kind: "pointer", to };
}

export function arrayOf(of: CType, length: number): CType {
  return { kind: "array", of, length };
}

/** How the type is written in C, near enough for a label. */
export function typeName(type: CType): string {
  switch (type.kind) {
    case "pointer":
      return `${typeName(type.to)}*`;
    case "array":
      return `${typeName(type.of)}[${type.length}]`;
    default:
      return type.kind;
  }
}

/** Bytes. A pointer is 8 because this targets x86-64. */
export function sizeOf(type: CType): number {
  switch (type.kind) {
    case "char":
      return 1;
    case "int":
      return 4;
    case "pointer":
      return 8;
    case "array":
      return sizeOf(type.of) * type.length;
    case "void":
      return 0;
  }
}

/** An array is aligned like its element, not like its whole self. */
export function alignOf(type: CType): number {
  return type.kind === "array" ? alignOf(type.of) : Math.max(1, sizeOf(type));
}

export function sameType(a: CType, b: CType): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "pointer" && b.kind === "pointer") return sameType(a.to, b.to);
  if (a.kind === "array" && b.kind === "array") {
    return a.length === b.length && sameType(a.of, b.of);
  }
  return true;
}

/**
 * Array-to-pointer decay: the rule that makes `a` mean `&a[0]` almost
 * everywhere, and the reason an array parameter is really a pointer. The two
 * places it does NOT apply are `&a` and a declaration, so callers ask for it
 * rather than getting it automatically.
 */
export function decay(type: CType): CType {
  return type.kind === "array" ? pointerTo(type.of) : type;
}

export function isPointer(type: CType): boolean {
  return decay(type).kind === "pointer";
}

export function isArray(type: CType): boolean {
  return type.kind === "array";
}

/** What a pointer (or array, after decay) points at. */
export function pointee(type: CType): CType | null {
  const decayed = decay(type);
  return decayed.kind === "pointer" ? decayed.to : null;
}

/** int and char, the types arithmetic and conditions accept. */
export function isInteger(type: CType): boolean {
  return type.kind === "int" || type.kind === "char";
}

export function isVoid(type: CType): boolean {
  return type.kind === "void";
}
