#!/usr/bin/env bash
# Recreates the two core mutants used by vitest.mutant.config.ts (copies, never the real src).
# Then, from packages/core: MUTANT=origin|headers [KILL=1] pnpm exec vitest run --config ../../scripts/adversary-t03-r3/vitest.mutant.config.ts
set -euo pipefail
cd "$(dirname "$0")"
ln -sfn ../../packages/core/node_modules node_modules
sed "s/ || url.password !== ''//" ../../packages/core/src/origin.ts > mut-origin-password.ts
sed "/Number.isSafeInteger(unixSeconds)/d; s#from './jcs.ts'#from '../../packages/core/src/jcs.ts'#; s#from './eip712.ts'#from '../../packages/core/src/eip712.ts'#" ../../packages/core/src/headers.ts > mut-headers-safeint.ts
