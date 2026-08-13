int main() {
  int a[5];
  for (int i = 0; i < 5; i = i + 1) {
    a[i] = i * i;
  }
  int total = 0;
  for (int i = 0; i < 5; i = i + 1) {
    total = total + a[i];
  }
  return total;
}
