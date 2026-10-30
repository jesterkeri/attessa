import { CliError, ERR, RENEW } from './copy.ts';
import type { Revert } from './tx.ts';

/** What a command knows when a simulated or sent transaction reverts, to fill the FLOWS §8 slots. */
export interface RevertContext {
  agent: string;
  from: string;
  owner?: string | undefined;
  origin?: string | undefined;
  releaseId?: string | undefined;
  signer?: string | undefined;
  /** For `AttestationStale`: minutes since the AWS-signed timestamp. */
  ageMinutes?: number | undefined;
  /** For `BindingMismatch`: words for what the attestation was made for, per field. */
  bindingWords?: ((field: number) => string) | undefined;
  renewing?: boolean | undefined;
}

/** Maps a registry or CertManager revert to its FLOWS §8 line. Unknown reverts keep their name. */
export function revertToError(r: Revert | null, message: string, c: RevertContext): CliError {
  const origin = c.origin ?? 'this origin';
  // `signer renew` shares registerSigner's checks; its refusals read "Not renewed" (FLOWS §8 R: renew refused).
  const E = c.renewing ? RENEW : ERR;
  switch (r?.name) {
    case 'NotOwner':
      return ERR.notOwner(c.agent, c.owner ?? 'unknown', c.from);
    case 'ReleaseExists':
      return ERR.releaseExists(c.agent, c.releaseId ?? '');
    case 'InvalidPcr':
      return ERR.invalidBuildFile('the build output');
    case 'InvalidOrigin':
      return ERR.invalidOrigin();
    case 'OriginTaken':
      return ERR.originTaken(origin, 'another agent');
    case 'EndpointInactive':
    case 'EndpointMismatch':
      return E.endpointInactive(origin, c.agent);
    case 'NotOperator':
      return E.notOperator(c.from, origin);
    case 'AttestationFromFuture':
      return E.attestationFromFuture();
    case 'AttestationStale':
      // The age was measured when planning; reverting proves it is now past 30 minutes.
      return c.renewing ? RENEW.attestationStale() : ERR.attestationStale(Math.max(c.ageMinutes ?? 31, 31));
    case 'DebugPcrs':
      return E.debugMode();
    case 'ReleaseNotApproved':
      return E.wrongBuild(c.agent, c.releaseId ?? '');
    case 'BindingMismatch': {
      const field = Number(r.args[0] ?? 0);
      return E.bindingMismatch(c.bindingWords ? c.bindingWords(field) : 'a different binding', String(field));
    }
    case 'SignerExists':
      return ERR.signerExists(c.signer ?? '');
    case 'SignerNotActive':
      return ERR.renewRefused('signer_not_active', 'the signer already expired', true);
    case 'SignerMismatch':
      return ERR.renewRefused('signer_mismatch', 'this report is from a different key', false);
    case 'ReleaseMismatch':
      return ERR.renewRefused('release_mismatch', 'this report is from a different build', false);
    case 'Error':
      if (String(r.args[0]).includes('cert expired')) return E.certExpired();
      return new CliError('reverted', `The transaction would revert: ${String(r.args[0])}. Nothing was sent.`);
    default:
      return new CliError('reverted', `The transaction would revert${r ? ` (${r.name})` : ''}: ${message}. Nothing was sent.`);
  }
}
