/*
 * The register-allocation demo preset, mirrored here so the gcc differential
 * checks it too — coalescing changes which register a value ends up in, and
 * that is exactly the kind of mistake a string comparison would miss but a
 * wrong exit status would not.
 */
int six(int a, int b, int c, int d, int e, int f) {
  return a + b + c + d + e + f;
}

int id(int n) {
  return n;
}

int main() {
  int a = 3;
  int b = 4;
  int chain = (a + b) + (a + b);

  return six(id(1), id(2), id(3), id(4), id(5), id(6))
       + six(id(7), id(8), id(9), id(10), id(11), id(12))
       + chain;
}
