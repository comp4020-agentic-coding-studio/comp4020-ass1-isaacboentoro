void reverse(int *a, int n) {
  int i = 0;
  int j = n - 1;
  while (i < j) {
    int t = a[i];
    a[i] = a[j];
    a[j] = t;
    i = i + 1;
    j = j - 1;
  }
}

int main() {
  int a[5];
  for (int i = 0; i < 5; i = i + 1) { a[i] = i + 1; }
  reverse(a, 5);
  return a[0] * 10 + a[4];
}
