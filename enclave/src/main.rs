//! Enclave entry point: vsock port 5000, real NSM device (SPEC §4.1, ADR-007).

use attessa_enclave::enclave::{serve_connection, Enclave, Nsm, NsmUnavailable};
use aws_nitro_enclaves_nsm_api::api::{Request, Response};
use aws_nitro_enclaves_nsm_api::driver::{nsm_init, nsm_process_request};
use serde_bytes::ByteBuf;
use std::fs::File;
use std::os::fd::{FromRawFd, RawFd};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

const VSOCK_PORT: u32 = 5000;
const VMADDR_CID_ANY: u32 = u32::MAX;
const EXIT_NSM_UNAVAILABLE: i32 = 3;

struct DevNsm(i32);

impl Nsm for DevNsm {
    fn get_random(&mut self) -> Result<Vec<u8>, NsmUnavailable> {
        match nsm_process_request(self.0, Request::GetRandom) {
            Response::GetRandom { random } => Ok(random),
            _ => Err(NsmUnavailable),
        }
    }

    fn describe_pcr(&mut self, index: u16) -> Result<Vec<u8>, NsmUnavailable> {
        match nsm_process_request(self.0, Request::DescribePCR { index }) {
            Response::DescribePCR { data, .. } => Ok(data),
            _ => Err(NsmUnavailable),
        }
    }

    fn attest(&mut self, user_data: &[u8], public_key: &[u8]) -> Result<Vec<u8>, NsmUnavailable> {
        let request = Request::Attestation {
            user_data: Some(ByteBuf::from(user_data)),
            nonce: None,
            public_key: Some(ByteBuf::from(public_key)),
        };
        match nsm_process_request(self.0, request) {
            Response::Attestation { document } => Ok(document),
            _ => Err(NsmUnavailable),
        }
    }
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

fn vsock_listen(port: u32) -> std::io::Result<RawFd> {
    // SAFETY: plain socket syscalls on a zeroed sockaddr_vm; the fd is checked before use.
    unsafe {
        let fd = libc::socket(libc::AF_VSOCK, libc::SOCK_STREAM | libc::SOCK_CLOEXEC, 0);
        if fd < 0 {
            return Err(std::io::Error::last_os_error());
        }
        let mut addr: libc::sockaddr_vm = std::mem::zeroed();
        addr.svm_family = libc::AF_VSOCK as libc::sa_family_t;
        addr.svm_port = port;
        addr.svm_cid = VMADDR_CID_ANY;
        let len = std::mem::size_of::<libc::sockaddr_vm>() as libc::socklen_t;
        if libc::bind(fd, &addr as *const _ as *const libc::sockaddr, len) < 0
            || libc::listen(fd, 16) < 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(fd)
    }
}

fn main() {
    let fd = nsm_init();
    if fd < 0 {
        std::process::exit(EXIT_NSM_UNAVAILABLE);
    }
    let enclave = Arc::new(Mutex::new(Enclave::new(DevNsm(fd), now)));
    let listener = match vsock_listen(VSOCK_PORT) {
        Ok(l) => l,
        Err(_) => std::process::exit(1),
    };
    loop {
        // SAFETY: accept on our listening fd; a negative result is skipped.
        let conn = unsafe { libc::accept(listener, std::ptr::null_mut(), std::ptr::null_mut()) };
        if conn < 0 {
            continue;
        }
        // SAFETY: `conn` is a fresh fd owned only by this File.
        let mut stream = unsafe { File::from_raw_fd(conn) };
        let enclave = Arc::clone(&enclave);
        std::thread::spawn(move || {
            if serve_connection(&enclave, &mut stream).is_err() {
                std::process::exit(EXIT_NSM_UNAVAILABLE);
            }
        });
    }
}
