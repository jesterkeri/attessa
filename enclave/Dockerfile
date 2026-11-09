# The enclave image (SPEC §4.1): one static binary in an otherwise empty image. Built on the arm64 EC2 host
# (AGENTS.md), with the repo root as context; only enclave/ is copied in. Reproducible PCRs are T14's job.
# rust:1.98.1-alpine, multi-arch index digest: musl targets link statically by default.
FROM rust:1.98.1-alpine@sha256:7cc1c22d77d9432f7fe012a70e6d3e555af54c2a6832700ed7d553f1769ae89f AS build
WORKDIR /src
COPY enclave/ ./
RUN cargo build --release --locked && cp target/release/attessa-enclave /attessa-enclave

FROM scratch
COPY --from=build /attessa-enclave /attessa-enclave
ENTRYPOINT ["/attessa-enclave"]
