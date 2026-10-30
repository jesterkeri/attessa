//! INV-18: the shared `vectors/*.json` (written by T03, `@attessa/core`) run against the
//! Rust formats. The JSON fields each test reads are listed on it.

use attessa_enclave::formats::*;
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use serde_json::Value;
use std::path::PathBuf;

fn load(file: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../vectors")
        .join(file);
    let text = std::fs::read_to_string(&path).unwrap_or_else(|e| {
        panic!(
            "MISSING VECTORS: cannot read {} ({e}). The cross-language vectors come from T03 \
             (`pnpm --filter @attessa/core test` writes vectors/*.json); they must be present \
             before this test can pass.",
            path.display()
        )
    });
    serde_json::from_str(&text).unwrap_or_else(|e| panic!("{} is not JSON: {e}", path.display()))
}

fn list<'a>(v: &'a Value, key: &str) -> &'a Vec<Value> {
    let l = v[key]
        .as_array()
        .unwrap_or_else(|| panic!("vectors lack array {key:?}"));
    assert!(!l.is_empty(), "vectors array {key:?} is empty");
    l
}

fn field<'a>(c: &'a Value, k: &str) -> &'a str {
    c[k].as_str()
        .unwrap_or_else(|| panic!("case {} lacks string field {k:?}", c["name"]))
}

fn bytes(c: &Value, k: &str) -> Vec<u8> {
    parse_hex(field(c, k), None).unwrap_or_else(|| panic!("case {}: {k} is not 0x hex", c["name"]))
}

fn h32(c: &Value, k: &str) -> [u8; 32] {
    parse_bytes32(field(c, k)).unwrap_or_else(|| panic!("case {}: {k} is not bytes32", c["name"]))
}

fn u256(c: &Value, k: &str) -> [u8; 32] {
    parse_u256(field(c, k)).unwrap_or_else(|| panic!("case {}: {k} is not uint256", c["name"]))
}

fn u64f(c: &Value, k: &str) -> u64 {
    field(c, k)
        .parse()
        .unwrap_or_else(|_| panic!("case {}: {k} is not uint64", c["name"]))
}

/// origins.json: `valid[] {name, input, local, normalized, bytes, originHash}`,
/// `invalid[] {name, input, local, reason}`. The enclave has no `--network local`
/// mode, so `local: true` cases are skipped (the enclave only accepts https origins).
#[test]
fn vectors_origins() {
    let v = load("origins.json");
    let mut checked = 0;
    for c in list(&v, "valid") {
        if c["local"] == true {
            continue;
        }
        let want = field(c, "normalized");
        assert_eq!(
            normalize_origin(field(c, "input")).as_deref(),
            Some(want),
            "case {}",
            c["name"]
        );
        assert_eq!(
            want.len() as u64,
            c["bytes"].as_u64().unwrap(),
            "case {}",
            c["name"]
        );
        assert_eq!(
            to_hex(&origin_hash(want)),
            field(c, "originHash"),
            "case {}",
            c["name"]
        );
        checked += 1;
    }
    for c in list(&v, "invalid") {
        if c["local"] == true {
            continue;
        }
        assert_eq!(
            normalize_origin(field(c, "input")),
            None,
            "case {} ({})",
            c["name"],
            c["reason"]
        );
        checked += 1;
    }
    assert!(checked >= 20, "only {checked} non-local origin cases");
}

/// hashes.json: `requestHash[] {method, pathAndQuery, body, expected}`,
/// `responseHash[] {body, expected}`, `inputsHash[] {inputs, jcs, expected}`,
/// `releaseId[] {pcr0, pcr1, pcr2, expected}`, `requestId[] {asset, payer, nonce, expected}`.
#[test]
fn vectors_hashes() {
    let v = load("hashes.json");
    for c in list(&v, "requestHash") {
        let got = request_hash(
            field(c, "method"),
            field(c, "pathAndQuery"),
            &bytes(c, "body"),
        );
        assert_eq!(
            to_hex(&got),
            field(c, "expected"),
            "requestHash {}",
            c["name"]
        );
    }
    for c in list(&v, "responseHash") {
        assert_eq!(
            to_hex(&keccak(&bytes(c, "body"))),
            field(c, "expected"),
            "responseHash {}",
            c["name"]
        );
    }
    // SPEC §4.3 (SPEC.md:355) makes every `inputs` leaf a string and the enclave answers
    // `bad_inputs` to a number (tests/enclave.rs `numbers_in_inputs_are_bad_inputs`), so the
    // enclave's JCS never meets one and refuses them. Only cases holding a number are skipped.
    fn has_number(v: &Value) -> bool {
        match v {
            Value::Number(_) => true,
            Value::Array(a) => a.iter().any(has_number),
            Value::Object(o) => o.values().any(has_number),
            _ => false,
        }
    }
    let (mut ran, mut skipped) = (0, 0);
    for c in list(&v, "inputsHash") {
        if has_number(&c["inputs"]) {
            assert_eq!(jcs(&c["inputs"]), None, "numbers must be refused");
            skipped += 1;
            continue;
        }
        ran += 1;
        let canonical = jcs(&c["inputs"]).expect("inputs canonicalise");
        assert_eq!(canonical, field(c, "jcs"), "inputsHash JCS {}", c["name"]);
        assert_eq!(
            to_hex(&keccak(canonical.as_bytes())),
            field(c, "expected"),
            "inputsHash {}",
            c["name"]
        );
    }
    assert!(
        ran > 0,
        "every inputsHash case was skipped ({skipped} hold numbers)"
    );
    for c in list(&v, "releaseId") {
        let got = release_id(&bytes(c, "pcr0"), &bytes(c, "pcr1"), &bytes(c, "pcr2"));
        assert_eq!(
            to_hex(&got),
            field(c, "expected"),
            "releaseId {}",
            c["name"]
        );
    }
    // Derived requestId = keccak256(asset ‖ payer ‖ nonce), each 32-byte left-padded (§2.2).
    let word = |b: Vec<u8>| {
        let mut w = [0u8; 32];
        w[32 - b.len()..].copy_from_slice(&b);
        w
    };
    for c in list(&v, "requestId") {
        let got = keccak(
            &[
                word(bytes(c, "asset")),
                word(bytes(c, "payer")),
                word(bytes(c, "nonce")),
            ]
            .concat(),
        );
        assert_eq!(
            to_hex(&got),
            field(c, "expected"),
            "requestId {}",
            c["name"]
        );
    }
}

/// binding.json: `typehashPreimage`, `typehash`,
/// `userData[] {chainId, registry, agentId, originHash, expected}`,
/// `signer[] {publicKey (65 bytes), expected (address)}`.
#[test]
fn vectors_binding() {
    let v = load("binding.json");
    assert_eq!(
        to_hex(&keccak(field(&v, "typehashPreimage").as_bytes())),
        field(&v, "typehash")
    );
    for c in list(&v, "userData") {
        let registry = parse_address(field(c, "registry")).expect("registry");
        let ud = binding_user_data(
            &u256(c, "chainId"),
            &registry,
            &u256(c, "agentId"),
            &h32(c, "originHash"),
        );
        assert_eq!(ud.len(), 160);
        assert_eq!(&ud[..32], &keccak(field(&v, "typehashPreimage").as_bytes()));
        assert_eq!(to_hex(&ud), field(c, "expected"), "userData {}", c["name"]);
    }
    for c in list(&v, "signer") {
        let pk: [u8; 65] = bytes(c, "publicKey")
            .try_into()
            .expect("65-byte public key");
        assert_eq!(
            to_hex(&signer_address(&pk)),
            field(c, "expected"),
            "signer {}",
            c["name"]
        );
    }
}

/// Test-side verifier with the SPEC §2.3 rules: 65 bytes, v ∈ {27, 28}, r and s non-zero,
/// s low. Returns the recovered address or the failure reason.
fn verify(digest: &[u8; 32], sig: &[u8]) -> Result<String, &'static str> {
    if sig.len() != 65 {
        return Err("bad_length");
    }
    if sig[64] != 27 && sig[64] != 28 {
        return Err("bad_v");
    }
    let signature = Signature::from_slice(&sig[..64]).map_err(|_| "zero_r_or_s")?;
    if signature.normalize_s() != signature {
        return Err("high_s");
    }
    let vk = VerifyingKey::recover_from_prehash(
        digest,
        &signature,
        RecoveryId::from_byte(sig[64] - 27).unwrap(),
    )
    .map_err(|_| "unrecoverable")?;
    let pk: [u8; 65] = vk.to_sec1_point(false).as_bytes().try_into().unwrap();
    Ok(to_hex(&signer_address(&pk)))
}

/// eip712.json: `domain {name, version}`, `typeStrings`, `typehashes`,
/// `proof[] {chainId, verifyingContract, domainSeparator, agentId, releaseId, requestId,
/// requestHash, responseHash, inputsHash, paymentId, issuedAt, expiresAt, structHash, digest}`,
/// `liveness[] {chainId, verifyingContract, domainSeparator, agentId, releaseId, originHash,
/// challenge, issuedAt, structHash, digest}`,
/// `signatures[] {digest, signature, valid, signer, reason}`.
#[test]
fn vectors_eip712() {
    let v = load("eip712.json");
    assert_eq!(v["domain"]["name"], "AttestedExecution");
    assert_eq!(v["domain"]["version"], "1");
    for t in ["ExecutionProof", "Liveness"] {
        assert_eq!(
            to_hex(&keccak(field(&v["typeStrings"], t).as_bytes())),
            field(&v["typehashes"], t),
            "typehash {t}"
        );
    }
    let check = |c: &Value, struct_hash: [u8; 32]| {
        let ds = domain_separator(
            &u256(c, "chainId"),
            &parse_address(field(c, "verifyingContract")).expect("verifyingContract"),
        );
        assert_eq!(
            to_hex(&ds),
            field(c, "domainSeparator"),
            "domainSeparator {}",
            c["name"]
        );
        assert_eq!(
            to_hex(&struct_hash),
            field(c, "structHash"),
            "structHash {}",
            c["name"]
        );
        assert_eq!(
            to_hex(&typed_digest(&ds, &struct_hash)),
            field(c, "digest"),
            "digest {}",
            c["name"]
        );
    };
    for c in list(&v, "proof") {
        let p = ExecutionProof {
            agent_id: u256(c, "agentId"),
            release_id: h32(c, "releaseId"),
            request_id: h32(c, "requestId"),
            request_hash: h32(c, "requestHash"),
            response_hash: h32(c, "responseHash"),
            inputs_hash: h32(c, "inputsHash"),
            payment_id: h32(c, "paymentId"),
            issued_at: u64f(c, "issuedAt"),
            expires_at: u64f(c, "expiresAt"),
        };
        check(c, p.struct_hash());
    }
    for c in list(&v, "liveness") {
        let l = Liveness {
            agent_id: u256(c, "agentId"),
            release_id: h32(c, "releaseId"),
            origin_hash: h32(c, "originHash"),
            challenge: h32(c, "challenge"),
            issued_at: u64f(c, "issuedAt"),
        };
        check(c, l.struct_hash());
    }
    for c in list(&v, "signatures") {
        let got = verify(&h32(c, "digest"), &bytes(c, "signature"));
        if c["valid"] == true {
            assert_eq!(
                got.as_deref(),
                Ok(field(c, "signer")),
                "signature {}",
                c["name"]
            );
        } else {
            assert!(
                got.is_err(),
                "signature {} must be refused ({})",
                c["name"],
                c["reason"]
            );
        }
    }
}

/// headers.json: `bytes32 {valid[] {name, value}, invalid[] {name, value}}`. The enclave
/// parses only this grammar (requestId, paymentId, challenge). `retryAfter`, `payerSig` and
/// `attestedProof` are gateway/SDK headers the enclave never reads, so they are not run here.
#[test]
fn vectors_headers() {
    let v = load("headers.json");
    for c in list(&v["bytes32"], "valid") {
        assert!(
            parse_bytes32(field(c, "value")).is_some(),
            "bytes32 {}",
            c["name"]
        );
    }
    for c in list(&v["bytes32"], "invalid") {
        assert!(
            parse_bytes32(field(c, "value")).is_none(),
            "bytes32 {}",
            c["name"]
        );
    }
}
