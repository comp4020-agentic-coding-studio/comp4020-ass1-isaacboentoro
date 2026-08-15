/**
 * The rules the scanner matches and the grammar the parser implements.
 *
 * This is documentation that the page displays and that a test keeps honest:
 * every step the scanner or parser emits names one of these ids, and
 * `spec/compiler.test.ts` fails if a step ever names a rule that is not here or
 * if a rule is never used. Without that, the grammar on the page would drift
 * away from the parser behind it within a week, and a wrong grammar is worse
 * than none.
 *
 * The parser is recursive descent: one function per rule, chosen by looking at
 * the next token. Expressions use precedence climbing, which is the one place
 * the rules are not one-to-one with functions — `binary` stands for every
 * precedence level at once.
 */

export type GrammarRule = {
  id: string;
  /** The production, in the EBNF-ish notation the page shows. */
  text: string;
  /** What the parser is doing when it uses this rule. */
  note: string;
};

/**
 * Lexical rules. Ids match `TokenKind`, so the scanner names its rule simply by
 * saying what it produced.
 */
export const SCAN_RULES: GrammarRule[] = [
  {
    id: "keyword",
    text: "keyword ::= int | char | void | return | if | else | while | for | break | continue",
    note: "Matched as an identifier first, then looked up. A keyword is only special because it is on a list.",
  },
  {
    id: "identifier",
    text: "identifier ::= [A-Za-z_] [A-Za-z0-9_]*",
    note: "Longest match. `intx` is one identifier, not `int` followed by `x`.",
  },
  {
    id: "number",
    text: "number ::= [0-9]+",
    note: "Digits only. A letter straight after a digit is an error, not a new token.",
  },
  {
    id: "char",
    text: "char ::= ' ( escape | any ) '",
    note: "Exactly one character, or one backslash escape.",
  },
  {
    id: "punct",
    text: "punct ::= == | != | <= | >= | && | || | + | - | * | / | % | < | > | = | ! | & | [ | ] | ( | ) | { | } | ; | ,",
    note: "Longest first, always: `<=` has to be tried before `<`, or every `<=` becomes two tokens.",
  },
  {
    id: "eof",
    text: "eof ::= end of input",
    note: "A real token, so the parser can tell a finished program from a truncated one.",
  },
];

/**
 * The grammar, written the way the parser implements it. Left recursion is
 * absent on purpose: `expr ::= expr '+' term` would send a top-down parser into
 * an infinite loop, so every repetition is written as iteration instead. An LR
 * parser would not need that rewrite; this is the price of being readable.
 */
export const PARSE_RULES: GrammarRule[] = [
  {
    id: "program",
    text: "program ::= function+",
    note: "The top level is function definitions and nothing else.",
  },
  {
    id: "function",
    text: "function ::= type '*'* ident '(' params? ')' block",
    note: "A type, a name and a parenthesis is enough to commit to a function.",
  },
  {
    id: "param",
    text: "param ::= type declarator",
    note: "An array parameter decays to a pointer here, as C requires.",
  },
  {
    id: "declarator",
    text: "declarator ::= '*'* ident ( '[' number ']' )?",
    note: "Stars before, brackets after. C reads declarations inside out; this subset only accepts the simple shapes.",
  },
  {
    id: "block",
    text: "block ::= '{' statement* '}'",
    note: "A new scope, and the only place a statement list appears.",
  },
  {
    id: "declaration",
    text: "declaration ::= type declarator ( '=' expression )? ';'",
    note: "Chosen because the statement began with a type keyword — one token of lookahead is enough.",
  },
  {
    id: "if",
    text: "if ::= 'if' '(' expression ')' statement ( 'else' statement )?",
    note: "The dangling `else` binds to the nearest `if`, because the recursive call takes it first.",
  },
  {
    id: "while",
    text: "while ::= 'while' '(' expression ')' statement",
    note: "One condition, one body.",
  },
  {
    id: "for",
    text: "for ::= 'for' '(' ( declaration | expression ';' | ';' ) expression? ';' expression? ')' statement",
    note: "Three optional parts, kept separate so lowering can reorder them.",
  },
  {
    id: "return",
    text: "return ::= 'return' expression? ';'",
    note: "The value is optional; whether it is allowed to be is the analyser's problem.",
  },
  {
    id: "jump",
    text: "jump ::= ( 'break' | 'continue' ) ';'",
    note: "No target in the syntax at all. Lowering works out where it goes.",
  },
  {
    id: "exprstmt",
    text: "exprstmt ::= expression ';'",
    note: "The fallback when no keyword matched. The semicolon is what makes an expression a statement.",
  },
  {
    id: "assignment",
    text: "assignment ::= binary ( '=' assignment )?",
    note: "Right-recursive, so `a = b = 1` groups to the right. The left side is parsed as an expression and then reinterpreted as a target.",
  },
  {
    id: "binary",
    text: "binary(n) ::= unary ( operator(prec >= n) binary(prec + 1) )*",
    note: "Precedence climbing: one function for all ten levels, carrying the minimum precedence it will accept. Written as iteration because the left-recursive form would never terminate.",
  },
  {
    id: "unary",
    text: "unary ::= ( '-' | '!' | '*' | '&' ) unary | postfix",
    note: "Recursive on itself, which is how `--x` and `**p` work without extra rules.",
  },
  {
    id: "postfix",
    text: "postfix ::= primary ( '[' expression ']' )*",
    note: "Binds tighter than any prefix operator, so `*a[i]` indexes first and dereferences second.",
  },
  {
    id: "primary",
    text: "primary ::= number | char | ident | call | '(' expression ')'",
    note: "The leaves. Parentheses leave no node behind — they only changed which reduction happened.",
  },
  {
    id: "call",
    text: "call ::= ident '(' ( expression ( ',' expression )* )? ')'",
    note: "Distinguished from a plain name by the parenthesis after it.",
  },
];

export const RULES_BY_STAGE: Record<string, GrammarRule[]> = {
  scan: SCAN_RULES,
  parse: PARSE_RULES,
};

/** The method note shown under each grammar listing. */
export const METHOD: Record<string, string> = {
  scan: "One pass, left to right, never backing up more than a character. That is the whole reason scanning is cheap: no rule here needs to know what any other rule matched.",
  parse:
    "Recursive descent: one function per rule, chosen by looking at the next token. An LR parser would work bottom-up from a generated table instead — faster, and able to handle left-recursive grammars unchanged, but the table is machine-made and cannot tell you why it did anything. This parser can, which is the only reason the steps beside it exist.",
};
