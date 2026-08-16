/*
 * More live values than there are registers to hold them.
 *
 * Every one of these results has to survive the calls that come after it, and a
 * call destroys the caller-saved half of the register file — so all twelve of
 * them are competing for the five registers a callee has to give back. The
 * allocator runs out, and one value goes to the stack.
 *
 * That makes this the program that checks the parts nothing else reaches: a
 * callee-saved register saved in the prologue and handed back in the epilogue, a
 * spilled temporary reloaded from its slot, and the argument shuffle at a call
 * whose arguments are already sitting in argument registers.
 */
int six(int a, int b, int c, int d, int e, int f) {
  return a + b + c + d + e + f;
}

int id(int n) { return n; }

int main() {
  return six(id(1), id(2), id(3), id(4), id(5), id(6))
       + six(id(7), id(8), id(9), id(10), id(11), id(12));
}
