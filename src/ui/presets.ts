/**
 * Starting programs. These are not decoration: typing C on a 390px phone is
 * miserable, so on a small screen the presets are the primary way in.
 *
 * Each one exists to make a different stage the interesting one, and the spec
 * suite compiles every single one — a preset that stops parsing is a broken
 * page, not a broken example.
 */

export type Preset = {
  name: string;
  /** What this program is here to show. */
  about: string;
  source: string;
};

export const PRESETS: Preset[] = [
  {
    name: "Macro",
    about: "the preprocessor edits text before the compiler sees it",
    source: `#define SIZE 4
#define DOUBLE(x) ((x) + (x))

int main() {
  // SIZE is gone before the scanner runs
  int n = DOUBLE(SIZE);
  return n;
}`,
  },
  {
    name: "Arithmetic",
    about: "precedence becomes tree shape, then temporaries",
    source: `int main() {
  int x = 2 + 3 * 4;
  return x;
}`,
  },
  {
    name: "Branch",
    about: "an if becomes one conditional jump",
    source: `int main() {
  int n = 7;
  if (n % 2 == 0) {
    return 0;
  } else {
    return 1;
  }
}`,
  },
  {
    name: "Loop",
    about: "a loop is a backward jump, nothing more",
    source: `int main() {
  int total = 0;
  for (int i = 1; i <= 5; i = i + 1) {
    total = total + i;
  }
  return total;
}`,
  },
  {
    name: "Recursion",
    about: "calls, frames, and one function calling itself",
    source: `int fact(int n) {
  if (n < 2) {
    return 1;
  }
  return n * fact(n - 1);
}

int main() {
  return fact(5);
}`,
  },
  {
    name: "Short circuit",
    about: "&& is not an operator by the time we reach the IR",
    source: `int slow(int n) {
  return n - n;
}

int main() {
  int a = 0;
  if (a && slow(9)) {
    return 1;
  }
  return 0;
}`,
  },
  {
    name: "A mistake",
    about: "which stage catches which kind of bug",
    source: `int main() {
  int count = 1;
  return cuont;
}`,
  },
];

/**
 * The page opens on the macro example on purpose: it is the only one where the
 * first stage has work to do, and a dead player at the top of the page reads as
 * a broken page rather than an honest one.
 */
export const DEFAULT_PRESET = PRESETS[0];
