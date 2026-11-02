//! Shared formats from SPEC §2: hex, decimal, JCS, origins, hashes, user_data, EIP-712.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha3::{Digest, Keccak256};

/// The one JSON parse every message, body and inputs object goes through.
/// The typed parse refuses unknown and duplicate fields. Serde also accepts a JSON array
/// for any struct (its fields in order), so the typed value is serialised back and must
/// equal the input: only the exact object shape, at every nesting level, survives.
pub fn parse_strict<'a, T: Deserialize<'a> + Serialize>(json: &'a [u8]) -> Option<T> {
    let typed: T = serde_json::from_slice(json).ok()?;
    let original: Value = serde_json::from_slice(json).ok()?;
    (serde_json::to_value(&typed).ok()? == original).then_some(typed)
}

pub fn keccak(data: &[u8]) -> [u8; 32] {
    Keccak256::digest(data).into()
}

pub fn to_hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut s = String::with_capacity(2 + bytes.len() * 2);
    s.push_str("0x");
    for b in bytes {
        s.push(DIGITS[(b >> 4) as usize] as char);
        s.push(DIGITS[(b & 0xf) as usize] as char);
    }
    s
}

/// Parses `0x` followed by lowercase hex of even length. `len` is a byte count to enforce.
pub fn parse_hex(s: &str, len: Option<usize>) -> Option<Vec<u8>> {
    let digits = s.strip_prefix("0x")?.as_bytes();
    if digits.len() % 2 != 0 || len.is_some_and(|n| digits.len() != n * 2) {
        return None;
    }
    let nibble = |c: u8| match c {
        b'0'..=b'9' => Some(c - b'0'),
        b'a'..=b'f' => Some(c - b'a' + 10),
        _ => None,
    };
    digits
        .chunks(2)
        .map(|p| Some(nibble(p[0])? << 4 | nibble(p[1])?))
        .collect()
}

pub fn parse_bytes32(s: &str) -> Option<[u8; 32]> {
    parse_hex(s, Some(32))?.try_into().ok()
}

pub fn parse_address(s: &str) -> Option<[u8; 20]> {
    parse_hex(s, Some(20))?.try_into().ok()
}

/// Canonical decimal: `^(0|[1-9][0-9]{0,77})$`.
pub fn is_dec(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 78
        && b.iter().all(u8::is_ascii_digit)
        && (b[0] != b'0' || b.len() == 1)
}

/// Canonical decimal that fits in a uint256, as 32 big-endian bytes.
pub fn parse_u256(s: &str) -> Option<[u8; 32]> {
    if !is_dec(s) {
        return None;
    }
    let mut out = [0u8; 32];
    for d in s.bytes() {
        let mut carry = u16::from(d - b'0');
        for byte in out.iter_mut().rev() {
            let v = u16::from(*byte) * 10 + carry;
            *byte = v as u8;
            carry = v >> 8;
        }
        if carry != 0 {
            return None;
        }
    }
    Some(out)
}

pub fn u64_word(n: u64) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[24..].copy_from_slice(&n.to_be_bytes());
    w
}

fn address_word(a: &[u8; 20]) -> [u8; 32] {
    let mut w = [0u8; 32];
    w[12..].copy_from_slice(a);
    w
}

/// RFC 8785 canonical JSON. Numbers are refused: no format in SPEC §2 uses one.
pub fn jcs(v: &Value) -> Option<String> {
    let mut out = String::new();
    write_jcs(v, &mut out)?;
    Some(out)
}

fn write_jcs(v: &Value, out: &mut String) -> Option<()> {
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(_) => return None,
        Value::String(s) => write_jcs_string(s, out),
        Value::Array(items) => {
            out.push('[');
            for (i, item) in items.iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_jcs(item, out)?;
            }
            out.push(']');
        }
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by(|a, b| a.0.encode_utf16().cmp(b.0.encode_utf16()));
            out.push('{');
            for (i, (k, val)) in entries.into_iter().enumerate() {
                if i > 0 {
                    out.push(',');
                }
                write_jcs_string(k, out);
                out.push(':');
                write_jcs(val, out)?;
            }
            out.push('}');
        }
    }
    Some(())
}

fn write_jcs_string(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{08}' => out.push_str("\\b"),
            '\t' => out.push_str("\\t"),
            '\n' => out.push_str("\\n"),
            '\u{0c}' => out.push_str("\\f"),
            '\r' => out.push_str("\\r"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// SPEC §2.1 for a deployed (non-local) network: `https://host[:port]`, 9-267 bytes.
pub fn normalize_origin(input: &str) -> Option<String> {
    let url = url::Url::parse(input).ok()?;
    if url.scheme() != "https" || !url.username().is_empty() || url.password().is_some() {
        return None;
    }
    let host = match url.host()? {
        url::Host::Domain(d) => d,
        url::Host::Ipv4(_) | url::Host::Ipv6(_) => return None,
    };
    if host.is_empty() || host.ends_with('.') {
        return None;
    }
    let origin = match url.port() {
        Some(p) => format!("https://{host}:{p}"),
        None => format!("https://{host}"),
    };
    (9..=267).contains(&origin.len()).then_some(origin)
}

pub fn origin_hash(normalized: &str) -> [u8; 32] {
    keccak(normalized.as_bytes())
}

/// signer = last 20 bytes of `keccak256(X ‖ Y)` for `public_key = 0x04 ‖ X ‖ Y` (SPEC §2.4).
pub fn signer_address(public_key: &[u8; 65]) -> [u8; 20] {
    let h = keccak(&public_key[1..]);
    h[12..].try_into().expect("20 bytes")
}

/// `keccak256(METHOD ‖ 0x00 ‖ pathAndQuery ‖ 0x00 ‖ body)`, METHOD uppercased.
pub fn request_hash(method: &str, path_and_query: &str, body: &[u8]) -> [u8; 32] {
    let mut buf = Vec::with_capacity(method.len() + path_and_query.len() + body.len() + 2);
    buf.extend_from_slice(method.to_ascii_uppercase().as_bytes());
    buf.push(0);
    buf.extend_from_slice(path_and_query.as_bytes());
    buf.push(0);
    buf.extend_from_slice(body);
    keccak(&buf)
}

pub fn release_id(pcr0: &[u8], pcr1: &[u8], pcr2: &[u8]) -> [u8; 32] {
    keccak(&[pcr0, pcr1, pcr2].concat())
}

/// `abi.encode(BINDING_TYPEHASH, chainId, registry, agentId, originHash)`, 160 bytes.
pub fn binding_user_data(
    chain_id: &[u8; 32],
    registry: &[u8; 20],
    agent_id: &[u8; 32],
    origin_hash: &[u8; 32],
) -> Vec<u8> {
    [
        keccak(b"AttestedExecution.SignerBinding.v1"),
        *chain_id,
        address_word(registry),
        *agent_id,
        *origin_hash,
    ]
    .concat()
}

pub fn domain_separator(chain_id: &[u8; 32], registry: &[u8; 20]) -> [u8; 32] {
    keccak(
        &[
            keccak(b"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
            keccak(b"AttestedExecution"),
            keccak(b"1"),
            *chain_id,
            address_word(registry),
        ]
        .concat(),
    )
}

pub fn typed_digest(domain_separator: &[u8; 32], struct_hash: &[u8; 32]) -> [u8; 32] {
    keccak(&[&[0x19, 0x01][..], domain_separator, struct_hash].concat())
}

pub struct ExecutionProof {
    pub agent_id: [u8; 32],
    pub release_id: [u8; 32],
    pub request_id: [u8; 32],
    pub request_hash: [u8; 32],
    pub response_hash: [u8; 32],
    pub inputs_hash: [u8; 32],
    pub payment_id: [u8; 32],
    pub issued_at: u64,
    pub expires_at: u64,
}

impl ExecutionProof {
    pub fn struct_hash(&self) -> [u8; 32] {
        keccak(
            &[
                keccak(b"ExecutionProof(uint256 agentId,bytes32 releaseId,bytes32 requestId,bytes32 requestHash,bytes32 responseHash,bytes32 inputsHash,bytes32 paymentId,uint64 issuedAt,uint64 expiresAt)"),
                self.agent_id,
                self.release_id,
                self.request_id,
                self.request_hash,
                self.response_hash,
                self.inputs_hash,
                self.payment_id,
                u64_word(self.issued_at),
                u64_word(self.expires_at),
            ]
            .concat(),
        )
    }
}

pub struct Liveness {
    pub agent_id: [u8; 32],
    pub release_id: [u8; 32],
    pub origin_hash: [u8; 32],
    pub challenge: [u8; 32],
    pub issued_at: u64,
}

impl Liveness {
    pub fn struct_hash(&self) -> [u8; 32] {
        keccak(
            &[
                keccak(b"Liveness(uint256 agentId,bytes32 releaseId,bytes32 originHash,bytes32 challenge,uint64 issuedAt)"),
                self.agent_id,
                self.release_id,
                self.origin_hash,
                self.challenge,
                u64_word(self.issued_at),
            ]
            .concat(),
        )
    }
}
