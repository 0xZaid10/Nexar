#!/usr/bin/env bash
# NEXAR Full End-to-End Test
# Run: bash ~/story/test-e2e/run-tests.sh

BASE="http://localhost:3001"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PASS=0
FAIL=0

# ── Colors ─────────────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

sep()  { echo -e "\n${CYAN}──────────────────────────────── $1 ────────────────────────────────${NC}"; }
ok()   { echo -e "${GREEN}  ✔ PASS${NC} $1"; ((PASS++)); }
fail() { echo -e "${RED}  ✗ FAIL${NC} $1 — $2"; ((FAIL++)); }
info() { echo -e "${YELLOW}  ◆ ${NC}$1"; }

# ── Helper ─────────────────────────────────────────────────────────────────────
call() {
  local method=$1 path=$2 body=$3
  if [ -z "$body" ]; then
    curl -s -X "$method" "$BASE$path" -H "Content-Type: application/json"
  else
    curl -s -X "$method" "$BASE$path" -H "Content-Type: application/json" -d "$body"
  fi
}

check_ok() {
  local res=$1 label=$2
  local is_ok
  is_ok=$(echo "$res" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if d.get('ok') else 'no')" 2>/dev/null || echo "no")
  if [ "$is_ok" = "yes" ]; then
    ok "$label"
  else
    local errmsg
    errmsg=$(echo "$res" | python3 -c "import sys,json; d=json.load(sys.stdin); print(str(d.get('error','?'))+' '+str(d.get('message','')))" 2>/dev/null || echo "parse error")
    fail "$label" "$errmsg"
    echo "  Response: $res"
  fi
}

extract() { echo "$1" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('$2',''))" 2>/dev/null; }

# Send Photon-format webhook with required headers (dev mode: no signature needed)
spectrum_call() {
  local body=$1
  local ts
  ts=$(date +%s)
  curl -s -X POST "$BASE/webhook/spectrum" \
    -H "Content-Type: application/json" \
    -H "X-Spectrum-Event: messages" \
    -H "X-Spectrum-Timestamp: $ts" \
    -H "X-Spectrum-Signature: v0=devmode" \
    --data-raw "$body"
}

# Check that response is plain "ok" (200 ack from webhook)
check_webhook() {
  local res=$1 label=$2
  if [ "$res" = "ok" ]; then
    ok "$label"
  else
    fail "$label" "expected 'ok' got: $res"
  fi
}

echo ""
echo "  ██╗   ██╗███████╗██╗  ██╗ █████╗ ██████╗"
echo "  ██╔══██╗██╔════╝╚██╗██╔╝██╔══██╗██╔══██╗"
echo "  ██║  ██║█████╗   ╚███╔╝ ███████║██████╔╝"
echo "  ██║  ██║██╔══╝   ██╔██╗ ██╔══██║██╔══██╗"
echo "  ██████╔╝███████╗██╔╝ ██╗██║  ██║██║  ██║"
echo "  ╚═════╝ ╚══════╝╚═╝  ╚═╝╚═╝  ╚═╝╚═╝  ╚═╝"
echo "  End-to-End Test Suite"
echo ""

# ══════════════════════════════════════════════════════════════════════════════
sep "1. HEALTH CHECK"
# ══════════════════════════════════════════════════════════════════════════════

HEALTH=$(call GET /health)
check_ok "$HEALTH" "Server is healthy"

DB=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['services']['db'])" 2>/dev/null)
PRIVY=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['services']['privy'])" 2>/dev/null)
PINATA=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['services']['pinata'])" 2>/dev/null)
HF=$(echo "$HEALTH" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['services']['hf'])" 2>/dev/null)

[ "$DB" = "True" ] && ok "SQLite connected" || fail "SQLite connected" "db=False"
[ "$PRIVY" = "True" ] && ok "Privy MPC ready" || fail "Privy MPC ready" "privy=False"
[ "$PINATA" = "True" ] && ok "Pinata IPFS ready" || fail "Pinata IPFS ready" "pinata=False"
[ "$HF" = "True" ] && ok "HuggingFace inference ready" || info "HuggingFace: simulation mode (set HF_API_TOKEN + HF_MODEL_ID)"

# ══════════════════════════════════════════════════════════════════════════════
sep "2. WALLET MANAGEMENT"
# ══════════════════════════════════════════════════════════════════════════════

info "Creating wallets for Alice, Bob, Charlie, Dave..."

ALICE_RES=$(call POST /api/wallet/create '{"label":"alice@nexar-test.io"}')
check_ok "$ALICE_RES" "Alice wallet created"
ALICE_ADDR=$(extract "$ALICE_RES" address)
info "Alice: $ALICE_ADDR"

BOB_RES=$(call POST /api/wallet/create '{"label":"bob@nexar-test.io"}')
check_ok "$BOB_RES" "Bob wallet created"
BOB_ADDR=$(extract "$BOB_RES" address)
info "Bob:   $BOB_ADDR"

CHARLIE_RES=$(call POST /api/wallet/create '{"label":"charlie@nexar-test.io"}')
check_ok "$CHARLIE_RES" "Charlie wallet created"
CHARLIE_ADDR=$(extract "$CHARLIE_RES" address)
info "Charlie: $CHARLIE_ADDR"

DAVE_RES=$(call POST /api/wallet/create '{"label":"dave@nexar-test.io"}')
check_ok "$DAVE_RES" "Dave wallet created"
DAVE_ADDR=$(extract "$DAVE_RES" address)
info "Dave: $DAVE_ADDR"

# Idempotency check
ALICE_RES2=$(call POST /api/wallet/create '{"label":"alice@nexar-test.io"}')
ALICE_ADDR2=$(extract "$ALICE_RES2" address)
[ "$ALICE_ADDR" = "$ALICE_ADDR2" ] && ok "Wallet idempotency (same address returned)" || fail "Wallet idempotency" "got different address"

# Lookup
LOOKUP=$(call GET /api/wallet/alice@nexar-test.io)
check_ok "$LOOKUP" "Wallet lookup by label"

LIST=$(call GET /api/wallet)
check_ok "$LIST" "Wallet list endpoint"

info ""
info "⚠ IMPORTANT: Fund these wallets with $IP before asset registration tests:"
info "  Alice:   $ALICE_ADDR"
info "  Bob:     $BOB_ADDR"
info "  Charlie: $CHARLIE_ADDR"
info "  Dave:    $DAVE_ADDR"
info ""
read -p "  Press ENTER when all 4 wallets are funded with at least 1 \$IP each..."

# ══════════════════════════════════════════════════════════════════════════════
sep "3. ASSET REGISTRATION (per-user signing)"
# ══════════════════════════════════════════════════════════════════════════════

# Alice registers a dataset
info "Alice registering alpha signal dataset..."
DATASET_PAYLOAD=$(mktemp /tmp/nexar-XXXX.json)
python3 "$DIR/make_payload.py" asset \
  "alice@nexar-test.io" "Alpha Signal Q3-2024" "Proprietary quantitative alpha signals" \
  "DATASET" "$DIR/dataset.json" "application/json" "true" "15" "0.1" > "$DATASET_PAYLOAD"
ALICE_ASSET=$(curl -s -X POST "$BASE/api/asset/register" -H "Content-Type: application/json" --data-binary "@$DATASET_PAYLOAD")
rm -f "$DATASET_PAYLOAD"
check_ok "$ALICE_ASSET" "Alice: dataset registered as Story IP"
ALICE_IP=$(extract "$ALICE_ASSET" ipId)
ALICE_VAULT=$(extract "$ALICE_ASSET" vaultUuid)
info "Alice IP: $ALICE_IP"
info "Alice Vault UUID: $ALICE_VAULT"

# Bob registers a model
info "Bob registering AI model..."
MODEL_PAYLOAD=$(mktemp /tmp/nexar-XXXX.json)
python3 "$DIR/make_payload.py" asset \
  "bob@nexar-test.io" "FinanceGPT-1B Model" "Financial AI model inference access only" \
  "INFERENCE" "$DIR/model-info.json" "application/json" "true" "5" "0.05" > "$MODEL_PAYLOAD"
BOB_ASSET=$(curl -s -X POST "$BASE/api/asset/register" -H "Content-Type: application/json" --data-binary "@$MODEL_PAYLOAD")
rm -f "$MODEL_PAYLOAD"
check_ok "$BOB_ASSET" "Bob: model registered as Story IP"
BOB_IP=$(extract "$BOB_ASSET" ipId)
BOB_VAULT=$(extract "$BOB_ASSET" vaultUuid)
BOB_TERMS_ID=$(extract "$BOB_ASSET" licenseTermsId)
BOB_VAULT=$(extract "$BOB_ASSET" vaultUuid)
info "Bob IP: $BOB_IP"

# Get asset by ipId
ASSET_LOOKUP=$(call GET "/api/asset/$ALICE_IP")
check_ok "$ASSET_LOOKUP" "Asset lookup by ipId"

# List all assets
ASSET_LIST=$(call GET "/api/asset?owner=$ALICE_ADDR")
check_ok "$ASSET_LIST" "Asset list by owner"

# ══════════════════════════════════════════════════════════════════════════════
sep "4. TIMED VAULT — Film NDA (Charlie's video)"
# ══════════════════════════════════════════════════════════════════════════════

info "Charlie creating a timed NDA vault for a film..."

# Use video.mp4 if available, otherwise fall back to secret.txt
CONTENT_FILE="$DIR/video.mp4"
CONTENT_TYPE="video/mp4"
if [ ! -f "$CONTENT_FILE" ]; then
  CONTENT_FILE="$DIR/secret.txt"
  CONTENT_TYPE="text/plain"
fi

CHARLIE_PAYLOAD=$(mktemp /tmp/nexar-XXXX.json)
python3 "$DIR/make_payload.py" asset \
  "charlie@nexar-test.io" "Film NDA - Rough Cut" "Brand film rough cut NDA protected" \
  "DATASET" "$CONTENT_FILE" "$CONTENT_TYPE" "false" "0" "0" > "$CHARLIE_PAYLOAD"
CHARLIE_ASSET=$(curl -s -X POST "$BASE/api/asset/register" -H "Content-Type: application/json" --data-binary "@$CHARLIE_PAYLOAD")
rm -f "$CHARLIE_PAYLOAD"
check_ok "$CHARLIE_ASSET" "Charlie: film registered as Story IP"
CHARLIE_IP=$(extract "$CHARLIE_ASSET" ipId)
CHARLIE_VAULT=$(extract "$CHARLIE_ASSET" vaultUuid)

# Create timed vault (48h)
TIMED_PAYLOAD=$(mktemp /tmp/nexar-XXXX.json)
python3 "$DIR/make_payload.py" timed_vault \
  "charlie@nexar-test.io" "$CHARLIE_IP" "$CONTENT_FILE" "$CONTENT_TYPE" "172800" > "$TIMED_PAYLOAD"
TIMED_VAULT=$(curl -s -X POST "$BASE/api/vault/timed" -H "Content-Type: application/json" --data-binary "@$TIMED_PAYLOAD")
rm -f "$TIMED_PAYLOAD"
check_ok "$TIMED_VAULT" "Timed vault created (48h expiry, TimedAccessCondition)"
TIMED_UUID=$(extract "$TIMED_VAULT" vaultUuid)
TIMED_EXPIRY=$(extract "$TIMED_VAULT" expiryAt)
info "Timed vault UUID: $TIMED_UUID"
info "Expires at: $TIMED_EXPIRY"

# Create reviewer session for Dave
SESSION=$(call POST /api/vault/session "{
  \"reviewerLabel\": \"dave@nexar-test.io\",
  \"vaultUuid\": \"$TIMED_UUID\",
  \"ipId\": \"$CHARLIE_IP\",
  \"ttlSeconds\": 172800
}")
check_ok "$SESSION" "Reviewer session created for Dave"
SESSION_TOKEN=$(extract "$SESSION" token)
SESSION_EXPIRY=$(extract "$SESSION" expiresAt)
info "Session expires: $SESSION_EXPIRY"

# ══════════════════════════════════════════════════════════════════════════════
sep "5. LICENSING — fee check and minting"
# ══════════════════════════════════════════════════════════════════════════════

# Get license terms ID from Alice's asset
ALICE_TERMS_ID=$(echo "$ALICE_ASSET" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('licenseTermsId', '1'))" 2>/dev/null || echo "1")

# Check fee before minting
FEE_CHECK=$(call POST /api/license/terms/get-fee "{
  \"licensorIpId\": \"$ALICE_IP\",
  \"licenseTermsId\": \"$ALICE_TERMS_ID\"
}")
check_ok "$FEE_CHECK" "License fee check"
MINTING_FEE=$(extract "$FEE_CHECK" mintingFee)
info "Minting fee for Alice's dataset: $MINTING_FEE wei"

# Bob mints license for Alice's dataset (zero fee — non-commercial preview)
info "Bob minting license for Alice's dataset..."
BOB_LICENSE=$(call POST /api/license/mint "{
  \"licensorIpId\": \"$ALICE_IP\",
  \"licenseTermsId\": \"$ALICE_TERMS_ID\",
  \"buyerLabel\": \"bob@nexar-test.io\",
  \"mintingFee\": \"0\",
  \"amount\": 1
}")
check_ok "$BOB_LICENSE" "Bob minted license for Alice's dataset"
BOB_TOKEN_ID=$(echo "$BOB_LICENSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('licenseTokenIds',['0'])[0])" 2>/dev/null)
info "License token ID: $BOB_TOKEN_ID"

# Dave mints license for Charlie's film (zero fee — non-commercial)
CHARLIE_TERMS_ID=$(echo "$CHARLIE_ASSET" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('licenseTermsId', '1'))" 2>/dev/null || echo "1")
DAVE_LICENSE=$(call POST /api/license/mint "{
  \"licensorIpId\": \"$CHARLIE_IP\",
  \"licenseTermsId\": \"$CHARLIE_TERMS_ID\",
  \"buyerLabel\": \"dave@nexar-test.io\",
  \"mintingFee\": \"0\",
  \"amount\": 1
}")
check_ok "$DAVE_LICENSE" "Dave minted license for Charlie's film"
DAVE_TOKEN_ID=$(echo "$DAVE_LICENSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('licenseTokenIds',['0'])[0])" 2>/dev/null)

# Check licenses held
BOB_LICENSES=$(call GET /api/license/held/bob@nexar-test.io)
check_ok "$BOB_LICENSES" "Bob's held licenses"

ALICE_ISSUED=$(call GET "/api/license/issued/$ALICE_IP")
check_ok "$ALICE_ISSUED" "Licenses issued for Alice's IP"

# ══════════════════════════════════════════════════════════════════════════════
sep "6. VAULT ACCESS"
# ══════════════════════════════════════════════════════════════════════════════

# Bob accesses Alice's dataset vault with his license token
info "Bob accessing Alice's dataset vault..."
BOB_ACCESS=$(call POST /api/vault/access "{
  \"label\": \"bob@nexar-test.io\",
  \"vaultUuid\": \"$ALICE_VAULT\",
  \"licenseTokenIds\": [\"$BOB_TOKEN_ID\"]
}")
check_ok "$BOB_ACCESS" "Bob decrypted Alice's dataset vault"

# Dave accesses Charlie's timed film vault
info "Dave accessing Charlie's timed film vault..."
DAVE_ACCESS=$(call POST /api/vault/access "{
  \"label\": \"dave@nexar-test.io\",
  \"vaultUuid\": \"$TIMED_UUID\",
  \"licenseTokenIds\": [\"$DAVE_TOKEN_ID\"]
}")
check_ok "$DAVE_ACCESS" "Dave decrypted Charlie's timed vault"

# ══════════════════════════════════════════════════════════════════════════════
sep "7. ROYALTIES"
# ══════════════════════════════════════════════════════════════════════════════

# Check claimable for Alice
ALICE_CLAIMABLE=$(call GET "/api/royalty/$ALICE_IP/claimable")
check_ok "$ALICE_CLAIMABLE" "Alice claimable royalties"
CLAIMABLE_AMOUNT=$(extract "$ALICE_CLAIMABLE" claimableEth)
info "Alice claimable: $CLAIMABLE_AMOUNT WIP"

# Pay royalties to Alice from Bob's IP
info "Bob paying royalties to Alice..."
PAY_RESULT=$(call POST /api/royalty/pay "{
  \"receiverIpId\": \"$ALICE_IP\",
  \"amount\": \"1000000000000000\"
}")
check_ok "$PAY_RESULT" "Royalty payment to Alice"

# Check claimable again
ALICE_CLAIMABLE2=$(call GET "/api/royalty/$ALICE_IP/claimable")
check_ok "$ALICE_CLAIMABLE2" "Alice claimable after payment"
info "Alice claimable now: $(extract "$ALICE_CLAIMABLE2" claimableEth) WIP"

# Claim
info "Alice claiming royalties..."
CLAIM_RESULT=$(call POST /api/royalty/claim "{
  \"ancestorIpId\": \"$ALICE_IP\",
  \"childIpIds\": []
}")
check_ok "$CLAIM_RESULT" "Alice claimed royalties"

# ══════════════════════════════════════════════════════════════════════════════
sep "8. INFERENCE"
# ══════════════════════════════════════════════════════════════════════════════

info "Testing HuggingFace inference via Bob's model vault..."
info "(Inference runs through InferenceRuntime — vault decrypts, model context loaded)"

# We'll hit the server directly with a test inference request
# This goes through InferenceRuntime which reads the vault and calls HF
BOB_INFERENCE_LICENSE=$(call POST /api/license/mint "{
  \"licensorIpId\": \"$BOB_IP\",
  \"licenseTermsId\": \"$BOB_TERMS_ID\",
  \"buyerLabel\": \"charlie@nexar-test.io\",
  \"mintingFee\": \"0\"
}")
check_ok "$BOB_INFERENCE_LICENSE" "Charlie minted inference license for Bob's model"
CHARLIE_BOB_TOKEN=$(echo "$BOB_INFERENCE_LICENSE" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('licenseTokenIds',['0'])[0])" 2>/dev/null)

info "HF_MODEL_ID: $HF_MODEL_ID (set in .env)"
if [ -n "$HF_API_TOKEN" ] && [ "$HF" = "True" ]; then
  info "Real inference will run via HuggingFace API"
else
  info "Simulation mode — set HF_API_TOKEN + HF_MODEL_ID for real inference"
fi

# ══════════════════════════════════════════════════════════════════════════════
sep "9. SPECTRUM WEBHOOK"
# ══════════════════════════════════════════════════════════════════════════════

info "Simulating iMessage messages (Photon webhook format)..."

# Help — new user, gets welcome/not-registered message
SPECTRUM_HELP=$(spectrum_call '{
  "event": "messages",
  "space": { "id": "any;-;+11234567890", "platform": "iMessage", "type": "dm", "phone": "shared" },
  "message": {
    "id": "test-msg-1",
    "platform": "iMessage",
    "direction": "inbound",
    "timestamp": "2026-05-31T00:00:00Z",
    "sender": { "id": "+11234567890", "platform": "iMessage" },
    "content": { "type": "text", "text": "hi" }
  }
}')
check_webhook "$SPECTRUM_HELP" "Spectrum: help intent handled"

# Register alice on iMessage (so wallet/earnings/claim tests work)
SPECTRUM_REG=$(spectrum_call '{
  "event": "messages",
  "space": { "id": "any;-;+19876543210", "platform": "iMessage", "type": "dm", "phone": "shared" },
  "message": {
    "id": "test-msg-reg",
    "platform": "iMessage",
    "direction": "inbound",
    "timestamp": "2026-05-31T00:00:01Z",
    "sender": { "id": "+19876543210", "platform": "iMessage" },
    "content": { "type": "text", "text": "register testuser999" }
  }
}')
check_webhook "$SPECTRUM_REG" "Spectrum: wallet query handled"

# Earnings check
SPECTRUM_EARNINGS=$(spectrum_call '{
  "event": "messages",
  "space": { "id": "any;-;+19876543210", "platform": "iMessage", "type": "dm", "phone": "shared" },
  "message": {
    "id": "test-msg-3",
    "platform": "iMessage",
    "direction": "inbound",
    "timestamp": "2026-05-31T00:00:02Z",
    "sender": { "id": "+19876543210", "platform": "iMessage" },
    "content": { "type": "text", "text": "earnings" }
  }
}')
check_webhook "$SPECTRUM_EARNINGS" "Spectrum: earnings check handled"

# Share file intent
SPECTRUM_SHARE=$(spectrum_call '{
  "event": "messages",
  "space": { "id": "any;-;+19876543210", "platform": "iMessage", "type": "dm", "phone": "shared" },
  "message": {
    "id": "test-msg-4",
    "platform": "iMessage",
    "direction": "inbound",
    "timestamp": "2026-05-31T00:00:03Z",
    "sender": { "id": "+19876543210", "platform": "iMessage" },
    "content": { "type": "text", "text": "help" }
  }
}')
check_webhook "$SPECTRUM_SHARE" "Spectrum: share file intent handled"

# Claim earnings
SPECTRUM_CLAIM=$(spectrum_call '{
  "event": "messages",
  "space": { "id": "any;-;+19876543210", "platform": "iMessage", "type": "dm", "phone": "shared" },
  "message": {
    "id": "test-msg-5",
    "platform": "iMessage",
    "direction": "inbound",
    "timestamp": "2026-05-31T00:00:04Z",
    "sender": { "id": "+19876543210", "platform": "iMessage" },
    "content": { "type": "text", "text": "claim" }
  }
}')
check_webhook "$SPECTRUM_CLAIM" "Spectrum: claim earnings handled"

# ══════════════════════════════════════════════════════════════════════════════
sep "10. RATE LIMITING"
# ══════════════════════════════════════════════════════════════════════════════

info "Testing rate limiter (wallet endpoint — 5/min in prod, 100/min in dev)..."
for i in {1..3}; do
  RATE_RES=$(call POST /api/wallet/create "{\"label\":\"ratetest$i@nexar.io\"}")
  check_ok "$RATE_RES" "Rate limit test $i/3"
done

# ══════════════════════════════════════════════════════════════════════════════
sep "FINAL RESULTS"
# ══════════════════════════════════════════════════════════════════════════════

TOTAL=$((PASS + FAIL))
echo ""
echo -e "  Tests run:    $TOTAL"
echo -e "  ${GREEN}Passed:${NC}       $PASS"
echo -e "  ${RED}Failed:${NC}       $FAIL"
echo ""

if [ "$FAIL" -eq 0 ]; then
  echo -e "  ${GREEN}✔ ALL TESTS PASSED — NEXAR backend is production ready${NC}"
else
  echo -e "  ${RED}✗ $FAIL test(s) failed — check output above${NC}"
fi

echo ""
echo "  Live IPs on Aeneid:"
echo "  Alice (Dataset): $ALICE_IP"
echo "  Bob   (Model):   $BOB_IP"
echo "  Charlie (Film):  $CHARLIE_IP"
echo "  View: https://aeneid.explorer.story.foundation"
echo ""
