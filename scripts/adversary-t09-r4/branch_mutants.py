"""Adversary T09: is 100% branch coverage backed by assertions? Applies one line-exact mutant at a
time to src/EnclaveRegistry.sol in a scratch copy of contracts/ (argv[1]), runs forge test, and prints
KILLED/SURVIVED. Never touches the tracked tree. Optional argv[2:]: mutant names to run."""
import os, pathlib, subprocess, sys

W = pathlib.Path(sys.argv[1])
SRC = W / "src" / "EnclaveRegistry.sol"
ORIG = SRC.read_text()

M = {
    "refLen257": ("if (refLength == 0 || refLength > 256)", "if (refLength == 0 || refLength > 257)"),
    "originMin8": ("if (origin.length < 9 || origin.length > 267)", "if (origin.length < 8 || origin.length > 267)"),
    "originMax268": ("if (origin.length < 9 || origin.length > 267)", "if (origin.length < 9 || origin.length > 268)"),
    "prefixNoLenGuard": ("return s.length >= prefix.length && keccak256", "return true && keccak256"),
    "sigLenAtLeast": ("if (signature.length != 65) return address(0);", "if (signature.length < 65) return address(0);"),
    "allZeroSkipsByte0": ("if (b[i] != 0) return false;", "if (b[i] != 0 && i > 0) return false;"),
    "allZeroSkipsLast": ("if (b[i] != 0) return false;", "if (b[i] != 0 && i + 1 < b.length) return false;"),
    "futureGe": ("if (ts > block.timestamp + MAX_FUTURE_SKEW)", "if (ts >= block.timestamp + MAX_FUTURE_SKEW)"),
    "staleGe": ("if (age > MAX_ATTESTATION_AGE)", "if (age >= MAX_ATTESTATION_AGE)"),
    "checkExpiryGt": ("if (block.timestamp >= s.expiresAt) return (Check.SIGNER_EXPIRED", "if (block.timestamp > s.expiresAt) return (Check.SIGNER_EXPIRED"),
    "proofExpiredGe": ("if (block.timestamp > p.expiresAt)", "if (block.timestamp >= p.expiresAt)"),
    "skewGe": ("if (skew > MAX_PROOF_SKEW)", "if (skew >= MAX_PROOF_SKEW)"),
    "renewExpiryGt": ("block.timestamp >= s.expiresAt) revert SignerNotActive();", "block.timestamp > s.expiresAt) revert SignerNotActive();"),
    "renewNoSignerOperator": ("if (msg.sender != e.operator || e.operator != s.operator)", "if (msg.sender != e.operator || false)"),
    "userDataLonger": ("ptr.length() != USER_DATA_LENGTH", "ptr.length() < USER_DATA_LENGTH"),
    "pubKeyLonger": ("ptr.length() != PUBLIC_KEY_LENGTH", "ptr.length() < PUBLIC_KEY_LENGTH"),
    "pubKeyPrefix": ("if (publicKey[0] != 0x04)", "if (publicKey[0] == 0x05)"),
    "bindingSkipsField5": ("field <= 5; field++", "field < 5; field++"),
    "deprecatedNotToRevoked": ("(to == ReleaseStatus.Approved || to == ReleaseStatus.Revoked)", "(to == ReleaseStatus.Approved)"),
    "freshIgnored": ("try self.isProofFresh(selfAgentId) returns (bool ok) {\n            if (!ok)", "try self.isProofFresh(selfAgentId) returns (bool ok) {\n            if (false && !ok)"),
    "validPcrLonger": ("pcr.length == PCR_LENGTH && !_allZero(pcr)", "pcr.length >= PCR_LENGTH && !_allZero(pcr)"),
    "originTakenRetired": ("if (e.status == EndpointStatus.Active) revert OriginTaken();", "if (e.status != EndpointStatus.None) revert OriginTaken();"),
    "releaseIdNoPcr2": ("return keccak256(abi.encodePacked(pcr0, pcr1, pcr2));", "return keccak256(abi.encodePacked(pcr0, pcr1, pcr1));"),
    "renewKeepsHash": ("s.attestationHash = a.attestationHash;\n        emit SignerRenewed", "s.attestationHash = s.attestationHash;\n        emit SignerRenewed"),
}

env = dict(os.environ, FOUNDRY_INVARIANT_RUNS=os.environ.get("RUNS", "32"), FOUNDRY_INVARIANT_DEPTH=os.environ.get("DEPTH", "50"))
LOCK = ["flock", "-w", "1800", "/home/hr/.cache/attessa-heavy.lock"]
names = sys.argv[2:] or list(M)
try:
    for name in names:
        old, new = M[name]
        assert ORIG.count(old) == 1, name
        SRC.write_text(ORIG.replace(old, new))
        b = subprocess.run(LOCK + ["forge", "build"], cwd=W, capture_output=True, text=True, env=env)
        if b.returncode != 0:
            print(f"BROKEN {name}", flush=True)
            continue
        t = subprocess.run(LOCK + ["forge", "test", "--fail-fast"], cwd=W, capture_output=True, text=True, env=env)
        print(("KILLED " if t.returncode != 0 else "SURVIVED ") + name, flush=True)
finally:
    SRC.write_text(ORIG)
