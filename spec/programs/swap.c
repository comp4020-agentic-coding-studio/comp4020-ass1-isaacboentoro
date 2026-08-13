void swap(int *a, int *b) {
  int t = *a;
  *a = *b;
  *b = t;
}

int main() {
  int x = 7;
  int y = 100;
  swap(&x, &y);
  return y - x;
}
