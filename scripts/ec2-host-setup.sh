#!/usr/bin/env bash
# Prepare a fresh Amazon Linux 2023 arm64 host (made by scripts/ec2-launch.sh) to run the Attessa seller.
# Run on the instance as ec2-user (not root; it calls sudo):  ./ec2-host-setup.sh <40-hex-commit-sha>
# Safe to run again. Starts no Attessa service and holds no key. After it: log out and back in (new groups),
# fill /etc/attessa as docs/EC2-RUNBOOK.md says. Ran on the real host on 2026-11-08 (DONE.md, T12).
#
# Pinned: Node 22.23.2 (.nvmrc says 22), pnpm 10.32.1 (package.json packageManager, via corepack), Caddy 2.10.2,
#   the repo commit you pass, every JS dependency (pnpm-lock.yaml), and the SHA-256 of the Node archive and the
#   SHA-512 of the Caddy archive (constants below, downloaded and checked first of all, before any sudo; a mismatch stops the script with nothing installed).
#   Node and Caddy are re-downloaded, verified and installed on every run, so a binary put there by an older
#   version of this script is replaced by a verified one.
# NOT pinned: dnf packages (Amazon's repo for the AMI's release, whatever it serves at run time; nitro-cli is only
#   checked against 1.5.2 and warns), and the pnpm release that corepack downloads (its version is pinned, its hash
#   is not checked here).
set -euo pipefail
SHA=${1:-}
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || { echo "usage: $0 <40-hex commit sha of https://github.com/jesterkeri/attessa>"; exit 2; }
[ "$(id -u)" != 0 ] || { echo "run as ec2-user, not root"; exit 2; }
[ "$(uname -m)" = aarch64 ] || { echo "run this on the arm64 host"; exit 2; }
NODE_VERSION=22.23.2
CADDY_VERSION=2.10.2
# Expected digests, taken on 2026-11-08 from a download hashed locally and equal to the digests the two projects publish.
NODE_SHA256=fff4078c5def658577f92c88db7db3bc0072924bfb93fe52c1e744a54e94abb8   # node-v22.23.2-linux-arm64.tar.xz
CADDY_SHA512=6ce061a690312ab38367df3c5d5f89a2e4a263e7300d300d87356211bb81e79b15933e6d6203e03fbf26f15cc0311f264805f336147dbdd24938d84b57a4421c   # caddy_2.10.2_linux_arm64.tar.gz
REPO=https://github.com/jesterkeri/attessa
APP=/opt/attessa
ME=$(id -un)

# Nothing below may change the host until both archives have been downloaded and have matched their pinned digests.
# The tools for that come with the base AMI (curl-minimal and coreutils on Amazon Linux 2023), so they are checked,
# not installed: installing anything first would change the host before the check.
for c in curl sha256sum sha512sum cut mktemp; do
  command -v "$c" >/dev/null || { echo "missing: $c. Nothing was installed. Install it yourself, then run this again."; exit 2; }
done
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

# fetch_verified <url> <file in $TMP> <sha256|sha512> <expected hex digest>: download, compare with the constant, else fail.
fetch_verified() {
  local got
  curl -fsSLo "$TMP/$2" "$1" || { echo "DOWNLOAD FAILED for $2 ($1). Nothing was installed."; return 1; }
  got=$("$3sum" "$TMP/$2" | cut -d' ' -f1)
  [ "$got" = "$4" ] || { echo "DIGEST MISMATCH for $2: expected $4, got $got. Nothing was installed."; return 1; }
}

NODE_FILE=node-v$NODE_VERSION-linux-arm64.tar.xz
CADDY_FILE=caddy_${CADDY_VERSION}_linux_arm64.tar.gz
echo "== download and verify node $NODE_VERSION and caddy $CADDY_VERSION (before any change to the host)"
fetch_verified "https://nodejs.org/dist/v$NODE_VERSION/$NODE_FILE" "$NODE_FILE" sha256 "$NODE_SHA256" || exit 1
fetch_verified "https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION/$CADDY_FILE" "$CADDY_FILE" sha512 "$CADDY_SHA512" || exit 1

echo "== packages"
sudo dnf install -y docker aws-nitro-enclaves-cli aws-nitro-enclaves-cli-devel socat jq git tar gzip xz gcc-c++ make python3
nitro-cli --version | grep -q 1.5.2 || echo "WARNING: nitro-cli is not 1.5.2 (ADR-008, SPEC §2); say so in DONE.md"

echo "== enclave allocator: 3 vCPU, 3072 MiB (SPEC §5)"
printf -- '---\nmemory_mib: 3072\ncpu_count: 3\n' | sudo tee /etc/nitro_enclaves/allocator.yaml >/dev/null
sudo systemctl enable docker nitro-enclaves-allocator
sudo systemctl restart docker nitro-enclaves-allocator
sudo usermod -aG docker,ne "$ME"

echo "== node $NODE_VERSION and pnpm via corepack"
sudo tar -xJf "$TMP/$NODE_FILE" -C /usr/local --strip-components=1 --no-same-owner
sudo ln -sf /usr/local/bin/node /usr/bin/node   # the systemd units run /usr/bin/node
sudo /usr/local/bin/corepack enable
export PATH=/usr/local/bin:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0

echo "== caddy $CADDY_VERSION"
sudo tar -xzf "$TMP/$CADDY_FILE" -C /usr/local/bin caddy

echo "== service users and /etc/attessa"
for u in attessa-gw attessa-seller attessa-op caddy; do
  id "$u" >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /sbin/nologin "$u"
done
# The task asked for mode 700. The units run node as attessa-gw / attessa-seller and read their json from
# here, so the directory is root:attessa-gw 0750 (seller-host has attessa-gw as a supplementary group).
# Secret files you add (seller-<n>.secret, gateway-<n>.secret) are 0600 root:root: systemd reads EnvironmentFile as
# PID 1 before it drops to the service user, so no service group needs read access.
sudo install -d -m 0750 -o root -g attessa-gw /etc/attessa

echo "== repo at $SHA"
if [ ! -d "$APP/.git" ]; then
  sudo install -d -o "$ME" -g "$ME" -m 0755 "$APP"
  git clone "$REPO" "$APP"
fi
cd "$APP"
[ -z "$(git status --porcelain)" ] || { echo "$APP has local changes; fix or remove it first"; exit 1; }
git fetch origin
git checkout --detach "$SHA"
# Contracts and Solidity submodules are not needed on the host, so no submodule update and no forge.
pnpm install --frozen-lockfile
pnpm -r build

echo "== systemd units (installed, not started)"
sudo install -m 0644 packages/seller-host/systemd/*.service /etc/systemd/system/
sudo install -m 0644 packages/seller-host/caddy/caddy.service /etc/systemd/system/
sudo install -m 0640 -o root -g attessa-gw packages/seller-host/systemd/*.env /etc/attessa/
sudo install -d -m 0755 /etc/caddy
sudo install -m 0644 packages/seller-host/caddy/Caddyfile /etc/caddy/Caddyfile
if [ ! -e /etc/attessa/caddy.env ]; then   # names only; you fill the values
  printf 'ATTESSA_ORIGIN_MAINNET=\nATTESSA_ORIGIN_SEPOLIA=\n' | sudo tee /etc/attessa/caddy.env >/dev/null
  sudo chmod 0640 /etc/attessa/caddy.env
fi
sudo systemctl daemon-reload

echo "done. node $(node -v), pnpm $(pnpm -v), $(caddy version | cut -d' ' -f1), repo $(git rev-parse --short HEAD)."
echo "Log out and back in so the docker and ne groups apply."
