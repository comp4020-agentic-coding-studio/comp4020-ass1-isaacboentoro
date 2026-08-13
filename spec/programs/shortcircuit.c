int bump(int *counter) {
  *counter = *counter + 1;
  return 1;
}

int main() {
  int calls = 0;
  int zero = 0;
  if (zero && bump(&calls)) {
    return 99;
  }
  if (zero || bump(&calls)) {
    return calls;
  }
  return 99;
}
