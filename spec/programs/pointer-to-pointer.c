int main() {
  int x = 5;
  int *p = &x;
  int **q = &p;
  **q = **q * 8;
  return x + 2;
}
