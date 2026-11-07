//! Workload: payment check, rules v1 (SPEC §4.3).

use crate::formats::{is_dec, jcs, parse_address, parse_hex, parse_strict};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

pub const MAX_BODY_BYTES: usize = 2048;

/// The deny list shipped in the image (R2).
pub const DENYLIST_V1: &str = include_str!("../rules/denylist-v1.json");

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct RequestBody {
    pub chain_id: String,
    pub pay_to: String,
    pub asset: String,
    pub amount: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Inputs {
    pub block: Block,
    pub pay_to: PayTo,
    pub source: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Block {
    pub number: String,
    pub hash: String,
    pub timestamp: String,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct PayTo {
    pub address: String,
    pub code: String,
    pub nonce: String,
    pub balance_wei: String,
}

/// `^(0|[1-9][0-9]{0,77})$`
fn is_amount(s: &str) -> bool {
    is_dec(s)
}

/// Strict request grammar. `None` means `bad_request`.
pub fn parse_request(body: &[u8], configured_chain_id: &str) -> Option<RequestBody> {
    if body.len() > MAX_BODY_BYTES {
        return None;
    }
    let req: RequestBody = parse_strict(body)?;
    let ok = req.chain_id == configured_chain_id
        && parse_address(&req.pay_to).is_some()
        && parse_address(&req.asset).is_some()
        && is_amount(&req.amount);
    ok.then_some(req)
}

/// `forno` or `buy:<capability-id>`, the id being `[A-Za-z0-9._:/-]+` (no quotes, backslashes,
/// spaces or controls).
fn is_source(s: &str) -> bool {
    s == "forno"
        || s.strip_prefix("buy:").is_some_and(|id| {
            !id.is_empty()
                && id
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b".:_/-".contains(&b))
        })
}

/// Inputs grammar and the address check. `None` means `bad_inputs`.
pub fn parse_inputs(raw: &str, request: &RequestBody) -> Option<Inputs> {
    let i: Inputs = parse_strict(raw.as_bytes())?;
    let ok = is_dec(&i.block.number)
        && parse_hex(&i.block.hash, Some(32)).is_some()
        && is_dec(&i.block.timestamp)
        && parse_address(&i.pay_to.address).is_some()
        && parse_hex(&i.pay_to.code, None).is_some()
        && is_dec(&i.pay_to.nonce)
        && is_dec(&i.pay_to.balance_wei)
        && is_source(&i.source)
        && i.pay_to.address == request.pay_to;
    ok.then_some(i)
}

impl Inputs {
    pub fn to_json(&self) -> Value {
        json!({
            "block": {"number": self.block.number, "hash": self.block.hash, "timestamp": self.block.timestamp},
            "payTo": {
                "address": self.pay_to.address,
                "code": self.pay_to.code,
                "nonce": self.pay_to.nonce,
                "balanceWei": self.pay_to.balance_wei,
            },
            "source": self.source,
        })
    }
}

/// SPEC §2.6 pinned assets per chain id.
pub fn pinned_assets(chain_id: &str) -> &'static [&'static str] {
    match chain_id {
        "11142220" => &["0x01c5c0122039549ad1493b8220cabedd739bc44e"],
        "42220" => &[
            "0xceba9300f2b948710d2653dd7b07f33a8b32118c",
            "0xd2ab3c9a02dbbab236bfec45d1d755df4267f771",
        ],
        _ => &[],
    }
}

/// Decimal strings in canonical form: longer is larger, else lexicographic.
fn dec_gt(a: &str, b: &str) -> bool {
    (a.len(), a) > (b.len(), b)
}

/// Evaluates R1-R5 and returns the response body bytes (JCS).
pub fn evaluate(req: &RequestBody, inputs: &Inputs, denylist: &[String]) -> Vec<u8> {
    let mut deny = false;
    let mut review = false;
    let mut reasons = Vec::new();
    let mut hit = |cond: bool, is_deny: bool, code: &str| {
        if cond {
            reasons.push(code.to_string());
            deny |= is_deny;
            review |= !is_deny;
        }
    };
    let no_code = inputs.pay_to.code == "0x";
    hit(
        !pinned_assets(&req.chain_id).contains(&req.asset.as_str()),
        true,
        "unknown_asset",
    );
    hit(denylist.contains(&req.pay_to), true, "deny_listed");
    hit(!no_code, false, "pay_to_is_contract");
    hit(
        no_code && inputs.pay_to.nonce == "0",
        false,
        "pay_to_never_sent",
    );
    hit(dec_gt(&req.amount, "1000000000"), false, "large_amount");
    let verdict = if deny {
        "deny"
    } else if review {
        "review"
    } else {
        "allow"
    };
    let body = json!({
        "verdict": verdict,
        "reasons": reasons,
        "rulesVersion": "1",
        "inputs": inputs.to_json(),
    });
    jcs(&body)
        .expect("response body holds only strings")
        .into_bytes()
}

/// Parses the image's deny list: a JSON array of lowercase addresses.
pub fn load_denylist(text: &str) -> Option<Vec<String>> {
    let list: Vec<String> = serde_json::from_str(text).ok()?;
    list.iter()
        .all(|a| parse_address(a).is_some())
        .then_some(list)
}
