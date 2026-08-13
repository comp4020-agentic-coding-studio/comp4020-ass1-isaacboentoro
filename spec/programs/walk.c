int sum(int *p, int n) {
  int total = 0;
  int *end = p + n;
  while (p < end) {
    total = total + *p;
    p = p + 1;
  }
  return total;
}

int main() {
  int a[4];
  a[0] = 10;
  a[1] = 20;
  a[2] = 30;
  a[3] = 40;
  return sum(a, 4);
}
