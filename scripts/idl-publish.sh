#!/usr/bin/env bash
#
# KIRITE Protocol — IDL Publishing Script
#
# Publishes the Anchor IDL to an on-chain account so that clients (explorers,
# SDKs, wallets) can discover the program's interface without bundling the IDL.
#
# Usage:
#   ./scripts/idl-publish.sh [devnet|testnet|mainnet-beta]
#
# Environment variables:
#   ANCHOR_WALLET   — Path to authority keypair (must be the program's upgrade authority)
#   IDL_PATH        — Override path to IDL JSON (default: target/idl/kirite.json)

set -euo pipefail

# --------------------------------------------------------------------------- #
# Constants
# --------------------------------------------------------------------------- #

PROGRAM_NAME="kirite"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

log_info()  { echo -e "${CYAN}[INFO]${NC}  $*"; }
log_ok()    { echo -e "${GREEN}[OK]${NC}    $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*"; }
log_error() { echo -e "${RED}[ERROR]${NC} $*"; }
die() { log_error "$*"; exit 1; }

require_cmd() {
    command -v "$1" &>/dev/null || die "'$1' is not installed."
}

# --------------------------------------------------------------------------- #
# Pre-flight
# --------------------------------------------------------------------------- #

require_cmd solana
require_cmd anchor

CLUSTER="${1:-devnet}"

case "$CLUSTER" in
    devnet|testnet|mainnet-beta) ;;
    *) die "Invalid cluster: $CLUSTER" ;;
esac

WALLET="${ANCHOR_WALLET:-$HOME/.config/solana/id.json}"
[[ -f "$WALLET" ]] || die "Wallet not found at $WALLET"

IDL_FILE="${IDL_PATH:-target/idl/${PROGRAM_NAME}.json}"
[[ -f "$IDL_FILE" ]] || die "IDL file not found at $IDL_FILE. Run 'anchor build' first."

# Resolve program ID from keypair
KEYPAIR_FILE="target/deploy/${PROGRAM_NAME}-keypair.json"
if [[ -f "$KEYPAIR_FILE" ]]; then
    PROGRAM_ID=$(solana-keygen pubkey "$KEYPAIR_FILE")
else
    die "Program keypair not found at $KEYPAIR_FILE"
fi

AUTHORITY=$(solana-keygen pubkey "$WALLET")

echo ""
echo "=========================================="
echo "  KIRITE Protocol — IDL Publisher"
echo "=========================================="
echo "  Cluster:    $CLUSTER"
echo "  Program ID: $PROGRAM_ID"
echo "  Authority:  $AUTHORITY"
echo "  IDL File:   $IDL_FILE"
echo "=========================================="
echo ""

# --------------------------------------------------------------------------- #
# Validate IDL file
# --------------------------------------------------------------------------- #

log_info "Validating IDL file..."

# Check JSON is valid
if ! python3 -c "import json; json.load(open('$IDL_FILE'))" 2>/dev/null && \
   ! node -e "JSON.parse(require('fs').readFileSync('$IDL_FILE','utf8'))" 2>/dev/null; then
    die "IDL file is not valid JSON: $IDL_FILE"
fi

IDL_SIZE=$(wc -c < "$IDL_FILE" | tr -d ' ')
log_info "IDL file size: ${IDL_SIZE} bytes"

# Check IDL has expected program name
IDL_NAME=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$IDL_FILE','utf8')).name || '')" 2>/dev/null || echo "")
if [[ -n "$IDL_NAME" && "$IDL_NAME" != "$PROGRAM_NAME" ]]; then
    log_warn "IDL name '$IDL_NAME' does not match expected '$PROGRAM_NAME'"
fi

log_ok "IDL file validated"

# --------------------------------------------------------------------------- #
# Check for existing IDL
# --------------------------------------------------------------------------- #

log_info "Checking for existing on-chain IDL..."

EXISTING_IDL=$(anchor idl fetch --provider.cluster "$CLUSTER" "$PROGRAM_ID" 2>/dev/null) && {
    log_warn "IDL already exists on-chain. Will upgrade instead of init."
    IDL_ACTION="upgrade"
} || {
    log_info "No existing IDL found. Will initialize new IDL account."
    IDL_ACTION="init"
}

# --------------------------------------------------------------------------- #
# Estimate cost
# --------------------------------------------------------------------------- #

# IDL account size is roughly 2x the IDL file size (base64 encoding overhead + account header)
ESTIMATED_LAMPORTS=$(( (IDL_SIZE * 3) * 7 ))  # rough rent estimate
ESTIMATED_SOL=$(echo "scale=4; $ESTIMATED_LAMPORTS / 1000000000" | bc 2>/dev/null || echo "~0.01")

log_info "Estimated cost: ~${ESTIMATED_SOL} SOL"

# Check balance
BALANCE=$(solana balance --url "$(solana config get | grep 'RPC URL' | awk '{print $3}')" "$AUTHORITY" 2>/dev/null | awk '{print $1}' || echo "unknown")
log_info "Authority balance: $BALANCE SOL"

# --------------------------------------------------------------------------- #
# Mainnet confirmation
# --------------------------------------------------------------------------- #

if [[ "$CLUSTER" == "mainnet-beta" ]]; then
    echo ""
    echo -e "${YELLOW}Publishing IDL to mainnet. This costs SOL for rent.${NC}"
    read -rp "Continue? (yes/no): " CONFIRM
    [[ "$CONFIRM" == "yes" ]] || die "Aborted."
fi

# --------------------------------------------------------------------------- #
# Publish IDL
# --------------------------------------------------------------------------- #

if [[ "$IDL_ACTION" == "init" ]]; then
    log_info "Initializing IDL account..."

    anchor idl init \
        --provider.cluster "$CLUSTER" \
        --provider.wallet "$WALLET" \
        --filepath "$IDL_FILE" \
        "$PROGRAM_ID" 2>&1 || die "Failed to initialize IDL"

    log_ok "IDL initialized on-chain"
else
    log_info "Upgrading existing IDL..."

    anchor idl upgrade \
        --provider.cluster "$CLUSTER" \
        --provider.wallet "$WALLET" \
        --filepath "$IDL_FILE" \
        "$PROGRAM_ID" 2>&1 || die "Failed to upgrade IDL"

    log_ok "IDL upgraded on-chain"
fi

# --------------------------------------------------------------------------- #
# Verify
# --------------------------------------------------------------------------- #

log_info "Verifying IDL upload..."

FETCHED_IDL=$(anchor idl fetch --provider.cluster "$CLUSTER" "$PROGRAM_ID" 2>/dev/null) || {
    die "Failed to fetch IDL after upload. Verification failed."
}

# Compare instruction count as a quick sanity check
LOCAL_IX_COUNT=$(node -e "
  const idl = JSON.parse(require('fs').readFileSync('$IDL_FILE', 'utf8'));
  console.log((idl.instructions || []).length);
" 2>/dev/null || echo "0")

REMOTE_IX_COUNT=$(echo "$FETCHED_IDL" | node -e "
  let data = '';
  process.stdin.on('data', c => data += c);
  process.stdin.on('end', () => {
    try {
      const idl = JSON.parse(data);
      console.log((idl.instructions || []).length);
    } catch { console.log(0); }
  });
" 2>/dev/null || echo "0")

if [[ "$LOCAL_IX_COUNT" == "$REMOTE_IX_COUNT" && "$LOCAL_IX_COUNT" != "0" ]]; then
    log_ok "IDL verification passed (${LOCAL_IX_COUNT} instructions match)"
else
    log_warn "Instruction count mismatch: local=${LOCAL_IX_COUNT}, remote=${REMOTE_IX_COUNT}"
    log_warn "Manual verification recommended: anchor idl fetch $PROGRAM_ID"
fi

# --------------------------------------------------------------------------- #
# IDL Authority
# --------------------------------------------------------------------------- #

log_info "Checking IDL authority..."

IDL_AUTHORITY=$(anchor idl authority --provider.cluster "$CLUSTER" "$PROGRAM_ID" 2>/dev/null || echo "unknown")
log_info "IDL authority: $IDL_AUTHORITY"

if [[ "$IDL_AUTHORITY" != "$AUTHORITY" && "$IDL_AUTHORITY" != "unknown" ]]; then
    log_warn "IDL authority ($IDL_AUTHORITY) differs from wallet authority ($AUTHORITY)"
fi

# --------------------------------------------------------------------------- #
# Summary
# --------------------------------------------------------------------------- #

echo ""
echo -e "${GREEN}=========================================${NC}"
echo -e "${GREEN}  IDL Published Successfully${NC}"
echo -e "${GREEN}=========================================${NC}"
echo "  Cluster:    $CLUSTER"
echo "  Program:    $PROGRAM_ID"
echo "  Action:     $IDL_ACTION"
echo "  Authority:  $AUTHORITY"
echo "  File:       $IDL_FILE"
echo "  Size:       $IDL_SIZE bytes"
echo -e "${GREEN}=========================================${NC}"
echo ""

log_info "Clients can now fetch the IDL with:"
echo "  anchor idl fetch $PROGRAM_ID --provider.cluster $CLUSTER"
echo ""
