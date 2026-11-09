export async function runGatewayCommand(_args, _out, err) {
  err('attessa gateway is for people running a seller, and is not in the npm package. Install from the repository: https://github.com/jesterkeri/attessa');
  return 2;
}
