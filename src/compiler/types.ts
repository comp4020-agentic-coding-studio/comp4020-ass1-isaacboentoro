/**
 * The shared vocabulary of the pipeline.
 *
 * Two rules hold across every stage and are what make the scrubber possible:
 *
 * 1. Every artefact has a stable `id` and a `span` pointing into the ORIGINAL
 *    source text — not into the preprocessed text, and not into some earlier
 *    intermediate. A highlight is therefore always drawable in the editor.
 * 2. Every stage emits `Step[]` alongside its artefacts. A step says what the
 *    compiler did and which artefact ids came into existence because of it, so
 *    the page can be rendered as a pure function of one integer cursor.
 */

/** A half-open range of character offsets into the original source. */
export type Span = { start: number; end: number };

export const SPAN_NONE: Span = { start: 0, end: 0 };

export function spanOver(a: Span, b: Span): Span {
  return { start: Math.min(a.start, b.start), end: Math.max(a.end, b.end) };
}

export type StageId = "preprocess" | "scan" | "parse" | "semantics" | "ir" | "codegen";

export const STAGES: readonly StageId[] = [
  "preprocess",
  "scan",
  "parse",
  "semantics",
  "ir",
  "codegen",
] as const;

export const STAGE_TITLES: Record<StageId, string> = {
  preprocess: "Preprocess",
  scan: "Scan",
  parse: "Parse",
  semantics: "Analyse",
  ir: "Lower to IR",
  codegen: "Emit assembly",
};

/**
 * One thing the compiler did. `produced` holds artefact ids revealed by this
 * step; a pane shows every artefact produced at or before the cursor.
 */
export type Step = {
  index: number;
  stage: StageId;
  title: string;
  explain: string;
  consumed: Span | null;
  produced: string[];
};

/** A stage refusing to continue. Stages return these; they never throw. */
export type Diagnostic = {
  stage: StageId;
  message: string;
  span: Span;
  hint?: string;
};

// ---------------------------------------------------------------- preprocess

/** One preprocessor edit: a region of original source replaced by new text. */
export type Expansion = {
  id: string;
  kind: "comment" | "define" | "expansion" | "unsupported";
  span: Span;
  replacement: string;
  note: string;
};

export type PreprocessResult = {
  /** The text the scanner reads. */
  text: string;
  /** `text` offset -> original source offset, one entry per character. */
  map: number[];
  expansions: Expansion[];
  steps: Step[];
  error?: Diagnostic;
};

// --------------------------------------------------------------------- scan

export type TokenKind =
  | "keyword"
  | "identifier"
  | "number"
  | "char"
  | "punct"
  | "eof";

export type Token = {
  id: string;
  kind: TokenKind;
  text: string;
  /** Numeric value for `number` and `char` literals. */
  value?: number;
  span: Span;
};

export type ScanResult = {
  tokens: Token[];
  steps: Step[];
  error?: Diagnostic;
};

// -------------------------------------------------------------------- parse

export type CType = "int" | "char" | "void";

type NodeBase = { id: string; span: Span };

export type Expr =
  | (NodeBase & { kind: "NumberLit"; value: number })
  | (NodeBase & { kind: "CharLit"; value: number; text: string })
  | (NodeBase & { kind: "Ident"; name: string })
  | (NodeBase & { kind: "Unary"; op: string; operand: Expr })
  | (NodeBase & { kind: "Binary"; op: string; left: Expr; right: Expr })
  | (NodeBase & { kind: "Assign"; name: string; nameSpan: Span; value: Expr })
  | (NodeBase & { kind: "Call"; callee: string; args: Expr[] });

export type Stmt =
  | (NodeBase & { kind: "VarDecl"; type: CType; name: string; init?: Expr })
  | (NodeBase & { kind: "ExprStmt"; expr: Expr })
  | (NodeBase & { kind: "Return"; value?: Expr })
  | (NodeBase & { kind: "If"; cond: Expr; then: Stmt; otherwise?: Stmt })
  | (NodeBase & { kind: "While"; cond: Expr; body: Stmt })
  | (NodeBase & {
      kind: "For";
      init?: Stmt;
      cond?: Expr;
      update?: Expr;
      body: Stmt;
    })
  | (NodeBase & { kind: "Block"; stmts: Stmt[] })
  | (NodeBase & { kind: "Break" })
  | (NodeBase & { kind: "Continue" });

export type Param = NodeBase & { kind: "Param"; type: CType; name: string };

export type FunctionDecl = NodeBase & {
  kind: "Function";
  returnType: CType;
  name: string;
  params: Param[];
  body: Stmt & { kind: "Block" };
};

export type Program = NodeBase & { kind: "Program"; functions: FunctionDecl[] };

export type AstNode = Expr | Stmt | Param | FunctionDecl | Program;

export type ParseResult = {
  program: Program;
  steps: Step[];
  error?: Diagnostic;
};

/** Children in source order. Used by the tree pane and by any generic walk. */
export function childrenOf(node: AstNode): AstNode[] {
  switch (node.kind) {
    case "Program":
      return node.functions;
    case "Function":
      return [...node.params, node.body];
    case "Block":
      return node.stmts;
    case "VarDecl":
      return node.init ? [node.init] : [];
    case "ExprStmt":
      return [node.expr];
    case "Return":
      return node.value ? [node.value] : [];
    case "If":
      return node.otherwise
        ? [node.cond, node.then, node.otherwise]
        : [node.cond, node.then];
    case "While":
      return [node.cond, node.body];
    case "For": {
      const parts: AstNode[] = [];
      if (node.init) parts.push(node.init);
      if (node.cond) parts.push(node.cond);
      if (node.update) parts.push(node.update);
      parts.push(node.body);
      return parts;
    }
    case "Unary":
      return [node.operand];
    case "Binary":
      return [node.left, node.right];
    case "Assign":
      return [node.value];
    case "Call":
      return node.args;
    default:
      return [];
  }
}

/** The short text a tree node shows: the operator or name, not the kind. */
export function labelOf(node: AstNode): string {
  switch (node.kind) {
    case "Program":
      return "program";
    case "Function":
      return `${node.returnType} ${node.name}()`;
    case "Param":
      return `${node.type} ${node.name}`;
    case "VarDecl":
      return `${node.type} ${node.name}`;
    case "NumberLit":
      return String(node.value);
    case "CharLit":
      return node.text;
    case "Ident":
      return node.name;
    case "Unary":
      return node.op;
    case "Binary":
      return node.op;
    case "Assign":
      return `${node.name} =`;
    case "Call":
      return `${node.callee}(…)`;
    case "Block":
      return "{ }";
    case "If":
      return "if";
    case "While":
      return "while";
    case "For":
      return "for";
    case "Return":
      return "return";
    case "Break":
      return "break";
    case "Continue":
      return "continue";
    case "ExprStmt":
      return ";";
  }
}

// ---------------------------------------------------------------- semantics

export type SymbolInfo = {
  id: string;
  name: string;
  type: CType;
  /** Function parameters and locals live in a frame; functions don't. */
  role: "function" | "param" | "local";
  depth: number;
  span: Span;
  /** Byte offset from the frame pointer, assigned here and reused by codegen. */
  slot?: number;
  signature?: { params: CType[]; returns: CType };
};

export type SemanticsResult = {
  symbols: SymbolInfo[];
  /** AST node id -> resolved symbol id, for identifier uses. */
  resolved: Record<string, string>;
  /** AST node id -> its type, for expressions. */
  types: Record<string, CType>;
  /** Frame size in bytes per function name. */
  frames: Record<string, number>;
  steps: Step[];
  error?: Diagnostic;
};

// ------------------------------------------------------------------------ ir

export type IRValue =
  | { kind: "temp"; name: string }
  | { kind: "var"; name: string }
  | { kind: "const"; value: number };

export type IRInstr = { id: string; span: Span } & (
  | { op: "label"; name: string }
  | { op: "move"; dest: IRValue; src: IRValue }
  | { op: "binary"; dest: IRValue; operator: string; left: IRValue; right: IRValue }
  | { op: "unary"; dest: IRValue; operator: string; operand: IRValue }
  | { op: "jump"; target: string }
  | { op: "branchFalse"; cond: IRValue; target: string }
  | { op: "call"; dest?: IRValue; callee: string; args: IRValue[] }
  | { op: "return"; value?: IRValue }
  | { op: "enter"; func: string; frame: number }
);

export type IRResult = {
  instrs: IRInstr[];
  steps: Step[];
  error?: Diagnostic;
};

// ------------------------------------------------------------------- codegen

export type AsmLine = {
  id: string;
  kind: "directive" | "label" | "instr";
  text: string;
  comment?: string;
  span: Span;
  /** The IR instruction this line came from. */
  from?: string;
};

export type CodegenResult = {
  lines: AsmLine[];
  steps: Step[];
  error?: Diagnostic;
};

// ------------------------------------------------------------------ pipeline

export type Compilation = {
  source: string;
  steps: Step[];
  preprocess: PreprocessResult;
  scan: ScanResult;
  parse: ParseResult;
  semantics: SemanticsResult;
  ir: IRResult;
  codegen: CodegenResult;
  /** The first stage that refused, if any. Steps stop there. */
  error?: Diagnostic;
  /** Stages that ran to completion. */
  reached: StageId[];
};
