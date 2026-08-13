int main() {
  int *p = 0;
  int x = 3;
  if (p) { return 99; }
  p = &x;
  if (!p) { return 98; }
  return *p * 14;
}
