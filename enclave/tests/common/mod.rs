#![allow(dead_code)]

use attessa_enclave::enclave::{Enclave, Nsm, NsmUnavailable};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use k256::ecdsa::{RecoveryId, Signature, VerifyingKey};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};

pub const CLOCK: u64 = 1_761_782_400;
pub const REGISTRY: &str = "0x1111111111111111111111111111111111111111";
pub const SEPOLIA_USDC: &str = "0x01c5c0122039549ad1493b8220cabedd739bc44e";
pub const PAY_TO: &str = "0x2222222222222222222222222222222222222222";

/// What the fake NSM was last asked to attest: (user_data, public_key).
pub type Attested = Arc<Mutex<Vec<(Vec<u8>, Vec<u8>)>>>;

/// Test double for `/dev/nsm`. `random` is served in order, then repeats its last chunk.
pub struct FakeNsm {
    pub random: Vec<Vec<u8>>,
    pub pcrs: [Vec<u8>; 3],
    pub attested: Attested,
    pub fail: bool,
}

impl FakeNsm {
    pub fn with_key(key: [u8; 32]) -> Self {
        FakeNsm {
            random: vec![key.to_vec()],
            pcrs: [vec![1; 48], vec![2; 48], vec![3; 48]],
            attested: Arc::default(),
            fail: false,
        }
    }
}

impl Nsm for FakeNsm {
    fn get_random(&mut self) -> Result<Vec<u8>, NsmUnavailable> {
        if self.fail {
            return Err(NsmUnavailable);
        }
        Ok(if self.random.len() > 1 {
            self.random.remove(0)
        } else {
            self.random[0].clone()
        })
    }

    fn describe_pcr(&mut self, index: u16) -> Result<Vec<u8>, NsmUnavailable> {
        Ok(self.pcrs[index as usize].clone())
    }

    fn attest(&mut self, user_data: &[u8], public_key: &[u8]) -> Result<Vec<u8>, NsmUnavailable> {
        if self.fail {
            return Err(NsmUnavailable);
        }
        self.attested
            .lock()
            .unwrap()
            .push((user_data.to_vec(), public_key.to_vec()));
        Ok([b"FAKE-COSE".as_slice(), user_data, public_key].concat())
    }
}

pub fn fixed_clock() -> u64 {
    CLOCK
}

pub fn key_one() -> [u8; 32] {
    let mut k = [0u8; 32];
    k[31] = 1;
    k
}

pub fn configure_msg(agent_id: &str) -> Value {
    json!({
        "type": "configure",
        "chainId": "11142220",
        "registry": REGISTRY,
        "agentId": agent_id,
        "origin": "https://Example.COM:443/path?q=1#frag",
        "rpcAllowedChains": ["11142220"],
    })
}

pub fn configured(key: [u8; 32]) -> (Enclave<FakeNsm>, Attested) {
    let nsm = FakeNsm::with_key(key);
    let attested = nsm.attested.clone();
    let mut e = Enclave::new(nsm, fixed_clock);
    let reply = call(&mut e, &configure_msg("7"));
    assert!(reply.get("signer").is_some(), "configure failed: {reply}");
    (e, attested)
}

pub fn call(e: &mut Enclave<FakeNsm>, msg: &Value) -> Value {
    call_raw(e, msg.to_string().as_bytes())
}

pub fn call_raw(e: &mut Enclave<FakeNsm>, frame: &[u8]) -> Value {
    let out = e.handle(frame).expect("NSM available");
    serde_json::from_slice(&out).unwrap()
}

pub fn body(chain_id: &str, pay_to: &str, asset: &str, amount: &str) -> Vec<u8> {
    json!({"chainId": chain_id, "payTo": pay_to, "asset": asset, "amount": amount})
        .to_string()
        .into_bytes()
}

pub fn inputs(address: &str, code: &str, nonce: &str) -> Value {
    json!({
        "block": {
            "number": "123",
            "hash": "0x1234567890123456789012345678901234567890123456789012345678901234",
            "timestamp": "1761782400",
        },
        "payTo": {"address": address, "code": code, "nonce": nonce, "balanceWei": "5"},
        "source": "forno",
    })
}

pub fn evaluate_msg(body: &[u8], inputs: Value) -> Value {
    json!({
        "type": "evaluate",
        "requestId": format!("0x{}", "aa".repeat(32)),
        "method": "POST",
        "path": "/v1/evaluate",
        "body": B64.encode(body),
        "paymentId": format!("0x{}", "dd".repeat(32)),
        "inputs": inputs,
    })
}

pub fn hex32(s: &str) -> [u8; 32] {
    attessa_enclave::formats::parse_bytes32(s).expect("bytes32")
}

/// ecrecover: the address that signed `digest`, rejecting v outside {27, 28}.
pub fn recover(digest: &[u8; 32], sig_hex: &str) -> String {
    let sig = attessa_enclave::formats::parse_hex(sig_hex, Some(65)).expect("65-byte signature");
    assert!(sig[64] == 27 || sig[64] == 28, "v must be 27 or 28");
    let signature = Signature::from_slice(&sig[..64]).unwrap();
    assert!(
        signature.normalize_s() == signature,
        "signature must be low-s"
    );
    let vk = VerifyingKey::recover_from_prehash(
        digest,
        &signature,
        RecoveryId::from_byte(sig[64] - 27).unwrap(),
    )
    .unwrap();
    let point = vk.to_sec1_point(false);
    let h = attessa_enclave::formats::keccak(&point.as_bytes()[1..]);
    attessa_enclave::formats::to_hex(&h[12..])
}
