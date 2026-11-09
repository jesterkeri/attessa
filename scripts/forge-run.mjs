// Runs forge with stderr captured. forge 1.x writes megabytes of lint notes to stderr on a
// successful `forge build` (about 7.6 MB here), which overflows execFileSync's 1 MB default buffer:
// the child is killed with ENOBUFS and the build is reported as failed (T30). So the buffer is
// large. A non-zero exit, a signal or a buffer overflow still throws, and `failure()` formats it.
import { execFileSync } from 'node:child_process';

export const FORGE_MAX_BUFFER = 256 << 20;

export function runForge(args, opts = {}) {
  return execFileSync('forge', args, { stdio: ['ignore', 'ignore', 'pipe'], maxBuffer: FORGE_MAX_BUFFER, ...opts });
}

/** Why a runForge call threw: exit status, signal or error code, then the last 3 stderr lines. */
export function failure(e) {
  const how = e.status != null ? `exit ${e.status}` : e.signal ? `signal ${e.signal}` : e.code ? `error ${e.code}` : 'error';
  const tail = (e.stderr?.toString() || e.message).trim().split('\n').slice(-3).join(' | ');
  return `${how}: ${tail}`;
}
