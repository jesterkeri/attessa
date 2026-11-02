# Sourced by the adversary T09 probes. mkrepo <dir>: a throwaway git superproject at <dir> holding this
# repo's .gitmodules, scripts/ (adversary probes left out) and contracts/ (no out/ or cache/), with
# lib/nitro-validator cloned from the local submodule at its committed gitlink and forge-std inside it
# at its recorded commit, then committed. The gitlink and .gitmodules are real, as a CI checkout has
# them, so the CI guard step (including scripts/check-nitro-pin.sh) can run on it. Leaves cwd at <dir>.
# Needs ROOT (the repository root) set by the caller.
mkrepo() {
  local R=$1 NV="$ROOT/contracts/lib/nitro-validator" PIN
  PIN=$(git -C "$ROOT" ls-files -s contracts/lib/nitro-validator | awk '$1 == "160000" {print $2}')
  [ -n "$PIN" ] || return 2
  mkdir -p "$R" && cd "$R" && git init -q || return 2
  cp "$ROOT/.gitmodules" .gitmodules
  rsync -a --exclude 'adversary-*' "$ROOT/scripts/" scripts/
  rsync -a --exclude /out --exclude /cache --exclude /lib/nitro-validator "$ROOT/contracts/" contracts/
  git clone -q --no-checkout "$NV" contracts/lib/nitro-validator || return 2
  git -C contracts/lib/nitro-validator checkout -q --detach "$PIN" || return 2
  git -C contracts/lib/nitro-validator -c protocol.file.allow=always \
    -c "url.$NV/lib/forge-std.insteadOf=https://github.com/foundry-rs/forge-std" \
    submodule update -q --init --recursive || return 2
  git -c user.name=adv -c user.email=adv@invalid -c advice.addEmbeddedRepo=false add -A >/dev/null &&
    git -c user.name=adv -c user.email=adv@invalid commit -qm base || return 2
}
