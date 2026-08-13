int fact(int n) {
  if (n < 2) { return 1; }
  return n * fact(n - 1);
}

int main() {
  int total = 0;
  for (int i = 1; i <= 5; i = i + 1) {
    total = total + fact(i);
  }
  return total % 100;
}
