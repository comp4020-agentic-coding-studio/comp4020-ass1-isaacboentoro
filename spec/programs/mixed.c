int main() {
  char c = 'A';
  int wide = c + 1;
  int a[3];
  a[0] = wide;
  a[1] = a[0] / 2;
  a[2] = a[0] % 7;
  int *p = a;
  return *(p + 1) + p[2];
}
