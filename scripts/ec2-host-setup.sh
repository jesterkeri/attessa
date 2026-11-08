#!/usr/bin/env bash
# Prepare a fresh Amazon Linux 2023 arm64 host (made by scripts/ec2-launch.sh) to run the Attessa seller.
# Run on the instance as ec2-user (not root; it calls sudo):  ./ec2-host-setup.sh <40-hex-commit-sha>
# Safe to run again. Starts no Attessa service and holds no key. After it: log out and back in (new groups),
# fill /etc/attessa as docs/EC2-RUNBOOK.md says. Not yet run on a real instance.
#
# Pinned: Node 22.23.2 (.nvmrc says 22), pnpm 10.32.1 (package.json packageManager, via corepack), Caddy 2.10.2,
#   the repo commit you pass, every JS dependency (pnpm-lock.yaml).
# NOT pinned: dnf packages (Amazon's repo for the AMI's release; nitro-cli is only checked against 1.5.2 and
#   warns), the Node and Caddy downloads (checked against the checksum file from the same site, not a hash
#   written here).
set -euo pipefail
SHA=${1:-}
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || { echo "usage: $0 <40-hex commit sha of https://github.com/jesterkeri/attessa>"; exit 2; }
[ "$(id -u)" != 0 ] || { echo "run as ec2-user, not root"; exit 2; }
[ "$(uname -m)" = aarch64 ] || { echo "run this on the arm64 host"; exit 2; }
NODE_VERSION=22.23.2
CADDY_VERSION=2.10.2
REPO=https://github.com/jesterkeri/attessa
APP=/opt/attessa
ME=$(id -un)
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT

echo "== packages"
sudo dnf install -y docker aws-nitro-enclaves-cli aws-nitro-enclaves-cli-devel socat jq git tar gzip xz gcc-c++ make python3
nitro-cli --version | grep -q 1.5.2 || echo "WARNING: nitro-cli is not 1.5.2 (ADR-008, SPEC §2); say so in DONE.md"

echo "== enclave allocator: 3 vCPU, 3072 MiB (SPEC §5)"
printf -- '---\nmemory_mib: 3072\ncpu_count: 3\n' | sudo tee /etc/nitro_enclaves/allocator.yaml >/dev/null
sudo systemctl enable docker nitro-enclaves-allocator
sudo systemctl restart docker nitro-enclaves-allocator
sudo usermod -aG docker,ne "$ME"

echo "== node $NODE_VERSION and pnpm via corepack"
if [ "$(/usr/local/bin/node -v 2>/dev/null)" != "v$NODE_VERSION" ]; then
  f=node-v$NODE_VERSION-linux-arm64.tar.xz
  curl -fsSLo "$TMP/$f" "https://nodejs.org/dist/v$NODE_VERSION/$f"
  curl -fsSLo "$TMP/SHASUMS256.txt" "https://nodejs.org/dist/v$NODE_VERSION/SHASUMS256.txt"
  (cd "$TMP" && grep " $f\$" SHASUMS256.txt | sha256sum -c -)
  sudo tar -xJf "$TMP/$f" -C /usr/local --strip-components=1 --no-same-owner
fi
sudo ln -sf /usr/local/bin/node /usr/bin/node   # the systemd units run /usr/bin/node
sudo /usr/local/bin/corepack enable
export PATH=/usr/local/bin:$PATH COREPACK_ENABLE_DOWNLOAD_PROMPT=0

echo "== caddy $CADDY_VERSION"
if ! /usr/local/bin/caddy version 2>/dev/null | grep -q "v$CADDY_VERSION"; then
  f=caddy_${CADDY_VERSION}_linux_arm64.tar.gz
  base=https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION
  curl -fsSLo "$TMP/$f" "$base/$f"
  curl -fsSLo "$TMP/checksums.txt" "$base/caddy_${CADDY_VERSION}_checksums.txt"
  (cd "$TMP" && grep " $f\$" checksums.txt | sha512sum -c -)   # Caddy publishes SHA-512
  sudo tar -xzf "$TMP/$f" -C /usr/local/bin caddy
fi

echo "== service users and /etc/attessa"
for u in attessa-gw attessa-seller attessa-op caddy; do
  id "$u" >/dev/null 2>&1 || sudo useradd --system --no-create-home --shell /sbin/nologin "$u"
done
# The task asked for mode 700. The units run node as attessa-gw / attessa-seller and read their json from
# here, so the directory is root:attessa-gw 0750 (seller-host has attessa-gw as a supplementary group).
# Secret files you add are 0600 or 0640 root:<service group>, never world-readable.
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
