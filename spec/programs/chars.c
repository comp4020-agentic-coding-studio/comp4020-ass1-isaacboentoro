int main() {
  char s[4];
  s[0] = 'h';
  s[1] = 'i';
  s[2] = '!';
  s[3] = 0;
  int total = 0;
  for (int i = 0; i < 3; i = i + 1) {
    total = total + s[i];
  }
  return total % 200;
}
