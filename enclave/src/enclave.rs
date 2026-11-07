//! Message handling (SPEC §4.1, §4.2, §4.4). The key lives only in `Configured::key` (INV-15).

use crate::formats::parse_strict;
use crate::formats::{
    binding_user_data, domain_separator, jcs, keccak, normalize_origin, origin_hash, parse_address,
    parse_bytes32, parse_u256, release_id, request_hash, signer_address, to_hex, typed_digest,
    ExecutionProof, Liveness,
};
use crate::rules;
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use k256::ecdsa::SigningKey;
use serde::{Deserialize, Serialize};
use serde_json::value::RawValue;
use serde_json::{json, Value};
use std::io::{self, Read, Write};

pub const MAX_FRAME: usize = 65_536;
const PROOF_TTL: u64 = 600;
const KEY_ATTEMPTS: usize = 16;

/// The smallest seam over `/dev/nsm`: the real driver in `main.rs`, a fake in tests.
pub trait Nsm {
    fn get_random(&mut self) -> Result<Vec<u8>, NsmUnavailable>;
    fn describe_pcr(&mut self, index: u16) -> Result<Vec<u8>, NsmUnavailable>;
    fn attest(&mut self, user_data: &[u8], public_key: &[u8]) -> Result<Vec<u8>, NsmUnavailable>;
}

/// Any NSM failure. The process exits with code 3 (SPEC §4.1 step 4).
#[derive(Debug)]
pub struct NsmUnavailable;

struct Configured {
    key: SigningKey,
    public_key: [u8; 65],
    signer: [u8; 20],
    chain_id: String,
    agent_id: String,
    agent_id_word: [u8; 32],
    origin_hash: [u8; 32],
    release_id: [u8; 32],
    domain: [u8; 32],
    user_data: Vec<u8>,
}

pub struct Enclave<N: Nsm> {
    nsm: N,
    clock: fn() -> u64,
    denylist: Vec<String>,
    state: Option<Configured>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct ConfigureMsg {
    #[serde(rename = "type")]
    _kind: String,
    chain_id: String,
    registry: String,
    agent_id: String,
    origin: String,
    rpc_allowed_chains: Vec<String>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct AttestMsg {
    #[serde(rename = "type")]
    _kind: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LivenessMsg {
    #[serde(rename = "type")]
    _kind: String,
    challenge: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct EvaluateMsg<'a> {
    #[serde(rename = "type")]
    _kind: String,
    request_id: String,
    method: String,
    path: String,
    body: String,
    payment_id: String,
    #[serde(borrow)]
    inputs: &'a RawValue,
}

fn error(code: &str) -> Value {
    json!({ "error": code })
}

impl<N: Nsm> Enclave<N> {
    pub fn new(nsm: N, clock: fn() -> u64) -> Self {
        let denylist = rules::load_denylist(rules::DENYLIST_V1).expect("denylist-v1.json is valid");
        Enclave {
            nsm,
            clock,
            denylist,
            state: None,
        }
    }

    /// Handles one frame payload and returns the response payload (JCS JSON).
    pub fn handle(&mut self, frame: &[u8]) -> Result<Vec<u8>, NsmUnavailable> {
        // Dispatch only: each handler then parses its message with `parse_strict`.
        let kind = serde_json::from_slice::<Value>(frame)
            .ok()
            .and_then(|v| v.get("type").and_then(Value::as_str).map(str::to_owned));
        let reply = match kind {
            None => error("bad_frame"),
            Some(kind) => match (kind.as_str(), self.state.is_some()) {
                ("configure", false) => self.configure(frame)?,
                ("configure", true) => error("bad_frame"),
                ("attest" | "liveness" | "evaluate", false) => error("not_configured"),
                ("attest", true) => self.attest(frame)?,
                ("liveness", true) => self.liveness(frame),
                ("evaluate", true) => self.evaluate(frame),
                _ => error("bad_frame"),
            },
        };
        Ok(jcs(&reply).expect("replies hold only strings").into_bytes())
    }

    fn configure(&mut self, frame: &[u8]) -> Result<Value, NsmUnavailable> {
        let Some(msg) = parse_strict::<ConfigureMsg>(frame) else {
            return Ok(error("bad_frame"));
        };
        let (Some(chain_word), Some(registry), Some(agent_word), Some(origin)) = (
            parse_u256(&msg.chain_id),
            parse_address(&msg.registry),
            parse_u256(&msg.agent_id),
            normalize_origin(&msg.origin),
        ) else {
            return Ok(error("bad_frame"));
        };
        if !msg
            .rpc_allowed_chains
            .iter()
            .all(|c| parse_u256(c).is_some())
        {
            return Ok(error("bad_frame"));
        }
        let key = self.generate_key()?;
        let public_key: [u8; 65] = key
            .verifying_key()
            .to_sec1_point(false)
            .as_bytes()
            .try_into()
            .expect("uncompressed point is 65 bytes");
        let pcrs = [
            self.nsm.describe_pcr(0)?,
            self.nsm.describe_pcr(1)?,
            self.nsm.describe_pcr(2)?,
        ];
        let origin_hash = origin_hash(&origin);
        let state = Configured {
            signer: signer_address(&public_key),
            public_key,
            key,
            chain_id: msg.chain_id,
            agent_id: msg.agent_id,
            agent_id_word: agent_word,
            origin_hash,
            release_id: release_id(&pcrs[0], &pcrs[1], &pcrs[2]),
            domain: domain_separator(&chain_word, &registry),
            user_data: binding_user_data(&chain_word, &registry, &agent_word, &origin_hash),
        };
        let reply = Self::attestation(&mut self.nsm, &state)?;
        self.state = Some(state);
        Ok(reply)
    }

    /// NSM `GetRandom` until 32 bytes form a valid secp256k1 scalar.
    fn generate_key(&mut self) -> Result<SigningKey, NsmUnavailable> {
        for _ in 0..KEY_ATTEMPTS {
            let mut bytes = Vec::new();
            while bytes.len() < 32 {
                let chunk = self.nsm.get_random()?;
                if chunk.is_empty() {
                    return Err(NsmUnavailable);
                }
                bytes.extend_from_slice(&chunk);
            }
            if let Ok(key) = SigningKey::from_slice(&bytes[..32]) {
                return Ok(key);
            }
        }
        Err(NsmUnavailable)
    }

    fn attestation(nsm: &mut N, s: &Configured) -> Result<Value, NsmUnavailable> {
        let doc = nsm.attest(&s.user_data, &s.public_key)?;
        Ok(json!({ "attestation": B64.encode(doc), "signer": to_hex(&s.signer) }))
    }

    fn attest(&mut self, frame: &[u8]) -> Result<Value, NsmUnavailable> {
        if parse_strict::<AttestMsg>(frame).is_none() {
            return Ok(error("bad_frame"));
        }
        let s = self.state.as_ref().expect("configured");
        Self::attestation(&mut self.nsm, s)
    }

    fn liveness(&self, frame: &[u8]) -> Value {
        let s = self.state.as_ref().expect("configured");
        let Some(challenge) =
            parse_strict::<LivenessMsg>(frame).and_then(|m| parse_bytes32(&m.challenge))
        else {
            return error("bad_frame");
        };
        let l = Liveness {
            agent_id: s.agent_id_word,
            release_id: s.release_id,
            origin_hash: s.origin_hash,
            challenge,
            issued_at: (self.clock)(),
        };
        let signature = sign(&s.key, &typed_digest(&s.domain, &l.struct_hash()));
        json!({
            "liveness": {
                "agentId": s.agent_id,
                "releaseId": to_hex(&l.release_id),
                "originHash": to_hex(&l.origin_hash),
                "challenge": to_hex(&l.challenge),
                "issuedAt": l.issued_at.to_string(),
            },
            "signature": to_hex(&signature),
        })
    }

    fn evaluate(&self, frame: &[u8]) -> Value {
        let s = self.state.as_ref().expect("configured");
        let Some(msg) = parse_strict::<EvaluateMsg>(frame) else {
            return error("bad_frame");
        };
        let method_ok =
            !msg.method.is_empty() && msg.method.bytes().all(|b| b.is_ascii_uppercase());
        let path_ok = msg.path.starts_with('/') && !msg.path.contains('\0');
        let (Some(request_id), Some(payment_id), Ok(body), true, true) = (
            parse_bytes32(&msg.request_id),
            parse_bytes32(&msg.payment_id).filter(|p| *p != [0u8; 32]),
            B64.decode(&msg.body),
            method_ok,
            path_ok,
        ) else {
            return error("bad_frame");
        };
        let Some(request) = rules::parse_request(&body, &s.chain_id) else {
            return error("bad_request");
        };
        let Some(inputs) = rules::parse_inputs(msg.inputs.get(), &request) else {
            return error("bad_inputs");
        };
        let response = rules::evaluate(&request, &inputs, &self.denylist);
        let inputs_jcs = jcs(&inputs.to_json()).expect("inputs hold only strings");
        let issued_at = (self.clock)();
        let proof = ExecutionProof {
            agent_id: s.agent_id_word,
            release_id: s.release_id,
            request_id,
            request_hash: request_hash(&msg.method, &msg.path, &body),
            response_hash: keccak(&response),
            inputs_hash: keccak(inputs_jcs.as_bytes()),
            payment_id,
            issued_at,
            expires_at: issued_at + PROOF_TTL,
        };
        let signature = sign(&s.key, &typed_digest(&s.domain, &proof.struct_hash()));
        json!({
            "response": B64.encode(&response),
            "proof": {
                "agentId": s.agent_id,
                "releaseId": to_hex(&proof.release_id),
                "requestId": to_hex(&proof.request_id),
                "requestHash": to_hex(&proof.request_hash),
                "responseHash": to_hex(&proof.response_hash),
                "inputsHash": to_hex(&proof.inputs_hash),
                "paymentId": to_hex(&proof.payment_id),
                "issuedAt": proof.issued_at.to_string(),
                "expiresAt": proof.expires_at.to_string(),
            },
            "signature": to_hex(&signature),
        })
    }
}

/// 65-byte `r ‖ s ‖ v`, low-s (k256 normalises), v ∈ {27, 28}.
pub fn sign(key: &SigningKey, digest: &[u8; 32]) -> [u8; 65] {
    let (sig, recid) = key.sign_prehash_recoverable(digest);
    let mut out = [0u8; 65];
    out[..64].copy_from_slice(&sig.to_bytes());
    out[64] = 27 + u8::from(recid.is_y_odd());
    out
}

/// Reads one frame: 4-byte big-endian length, then that many bytes.
/// `Ok(None)` on a clean EOF; `Err` with `InvalidData` on a length of 0 or above 65,536.
pub fn read_frame(r: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        other => other?,
    }
    let len = u32::from_be_bytes(len) as usize;
    if len == 0 || len > MAX_FRAME {
        return Err(io::ErrorKind::InvalidData.into());
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    Ok(Some(buf))
}

pub fn write_frame(w: &mut impl Write, payload: &[u8]) -> io::Result<()> {
    let len = u32::try_from(payload.len()).map_err(|_| io::ErrorKind::InvalidData)?;
    w.write_all(&len.to_be_bytes())?;
    w.write_all(payload)?;
    w.flush()
}

/// Serves frames on one connection until EOF. A bad length gets `bad_frame` and closes it.
pub fn serve_connection<N: Nsm>(
    enclave: &std::sync::Mutex<Enclave<N>>,
    stream: &mut (impl Read + Write),
) -> Result<(), NsmUnavailable> {
    loop {
        let reply = match read_frame(stream) {
            Ok(None) => return Ok(()),
            Ok(Some(frame)) => enclave
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .handle(&frame)?,
            Err(e) if e.kind() == io::ErrorKind::InvalidData => {
                let _ = write_frame(stream, br#"{"error":"bad_frame"}"#);
                return Ok(());
            }
            Err(_) => return Ok(()),
        };
        if write_frame(stream, &reply).is_err() {
            return Ok(());
        }
    }
}
