const MESSAGE = 'attessa gateway is for people running a seller, and is not in the npm package. Install from the repository: https://github.com/jesterkeri/attessa';

export async function runGatewayCommand(args, out, err) {
  // Under --json every outcome is one JSON object on stdout, as in the real gateway command.
  if (args.includes('--json')) out(JSON.stringify({ ok: false, error: 'usage', message: MESSAGE }));
  else err(MESSAGE);
  return 2;
}
