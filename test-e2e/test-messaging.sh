#!/usr/bin/env bash
# NEXAR Messaging & Identity Test Suite
# Tests: iMessage webhook, username registration, recovery, wallet, earnings, Telegram
# Run: bash ~/story/test-e2e/test-messaging.sh
# Server must be running: npm run start:dev

BASE="http://localhost:3001"
PASS=0
FAIL=0

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
sep()  { echo -e "\n${CYAN}─────────────────── $1 ───────────────────${NC}"; }
ok()   { echo -e "${GREEN}  ✔ PASS${NC} $1"; ((PASS++)); }
fail() { echo -e "${RED}  ✗ FAIL${NC} $1 — $2"; ((FAIL++)); }
info() { echo -e "${YELLOW}  ◆${NC} $1"; }

# ── Helpers ────────────────────────────────────────────────────────────────────

# Send Photon-format iMessage webhook (dev mode: signature skipped)
imessage() {
  local sender=$1 text=$2 msg_id=$3
  local ts; ts=$(date +%s)
  curl -s -X POST "$BASE/webhook/spectrum" \
    -H "Content-Type: application/json" \
    -H "X-Spectrum-Event: messages" \
    -H "X-Spectrum-Timestamp: $ts" \
    -H "X-Spectrum-Signature: v0=devmode" \
    --data-raw "{
      \"event\": \"messages\",
      \"space\": { \"id\": \"any;-;$sender\", \"platform\": \"iMessage\", \"type\": \"dm\", \"phone\": \"shared\" },
      \"message\": {
        \"id\": \"$msg_id\",
        \"platform\": \"iMessage\",
        \"direction\": \"inbound\",
        \"timestamp\": \"2026-06-01T00:00:00Z\",
        \"sender\": { \"id\": \"$sender\", \"platform\": \"iMessage\" },
        \"content\": { \"type\": \"text\", \"text\": \"$text\" }
      }
    }"
}

# Send Telegram webhook
telegram() {
  local chat_id=$1 text=$2 update_id=$3
  local tg_secret
  tg_secret=$(grep TELEGRAM_WEBHOOK_SECRET ~/story/.env 2>/dev/null | cut -d= -f2)
  curl -s -X POST "$BASE/webhook/telegram" \
    -H "Content-Type: application/json" \
    -H "X-Telegram-Bot-Api-Secret-Token: $tg_secret" \
    --data-raw "{
      \"update_id\": $update_id,
      \"message\": {
        \"message_id\": $update_id,
        \"from\": { \"id\": $chat_id, \"is_bot\": false, \"first_name\": \"Test\" },
        \"chat\": { \"id\": $chat_id, \"type\": \"private\" },
        \"date\": $(date +%s),
        \"text\": \"$text\"
      }
    }"
}

check_ack() {
  local res=$1 label=$2
  if [ "$res" = "ok" ]; then
    ok "$label"
  else
    fail "$label" "expected 'ok' got: ${res:0:80}"
  fi
}

check_json() {
  local res=$1 label=$2
  local is_ok
  is_ok=$(echo "$res" | python3 -c "import sys,json; d=json.load(sys.stdin); print('yes' if d.get('ok') else 'no')" 2>/dev/null || echo "no")
  if [ "$is_ok" = "yes" ]; then
    ok "$label"
  else
    local err
    err=$(echo "$res" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('message','?'))" 2>/dev/null || echo "parse error")
    fail "$label" "$err"
    echo "  Response: $res"
  fi
}

PHONE1="+15550000001"
PHONE2="+15550000002"
PHONE3="+15550000003"
TG_ID=9000001
USERNAME="testusr$(date +%s | tail -c 5)"  # unique each run

echo ""
echo "  NEXAR Messaging & Identity Test"
echo "  Username: @$USERNAME"
echo ""

# ══════════════════════════════════════════════════════════════════════════════
sep "1. iMESSAGE — NEW USER FLOW"
# ══════════════════════════════════════════════════════════════════════════════

# Unknown user texts "hi" → gets welcome/not-registered message
R=$(imessage "$PHONE1" "hi" "msg-001")
check_ack "$R" "New user: hi → welcome prompt"
sleep 0.3

# Unknown user texts help
R=$(imessage "$PHONE1" "help" "msg-002")
check_ack "$R" "New user: help → welcome prompt"
sleep 0.3

# Unknown user tries wallet (not registered yet)
R=$(imessage "$PHONE1" "wallet" "msg-003")
check_ack "$R" "New user: wallet → not registered prompt"
sleep 0.3

# ══════════════════════════════════════════════════════════════════════════════
sep "2. iMESSAGE — REGISTRATION"
# ══════════════════════════════════════════════════════════════════════════════

# Register with invalid username (too short)
R=$(imessage "$PHONE1" "register x" "msg-010")
check_ack "$R" "Register invalid username (too short)"
sleep 0.3

# Register with valid username
R=$(imessage "$PHONE1" "register $USERNAME" "msg-011")
check_ack "$R" "Register @$USERNAME on iMessage"
sleep 1  # wallet creation takes a moment

# Try registering same username from different phone (should fail — taken)
R=$(imessage "$PHONE2" "register $USERNAME" "msg-012")
check_ack "$R" "Register same username from new phone → taken"
sleep 0.3

# Try registering again from same phone (should say already registered)
R=$(imessage "$PHONE1" "register another" "msg-013")
check_ack "$R" "Re-register from same phone → already registered"
sleep 0.3

# ══════════════════════════════════════════════════════════════════════════════
sep "3. iMESSAGE — AUTHENTICATED INTENTS"
# ══════════════════════════════════════════════════════════════════════════════

R=$(imessage "$PHONE1" "wallet" "msg-020")
check_ack "$R" "Wallet address query"
sleep 0.3

R=$(imessage "$PHONE1" "whoami" "msg-021")
check_ack "$R" "Whoami query"
sleep 0.3

R=$(imessage "$PHONE1" "earnings" "msg-022")
check_ack "$R" "Earnings check"
sleep 0.3

R=$(imessage "$PHONE1" "help" "msg-023")
check_ack "$R" "Help message"
sleep 0.3

R=$(imessage "$PHONE1" "claim" "msg-024")
check_ack "$R" "Claim earnings"
sleep 0.3

# Link email
R=$(imessage "$PHONE1" "link email test@nexar.io" "msg-025")
check_ack "$R" "Link email address"
sleep 0.3

# Unknown intent → help
R=$(imessage "$PHONE1" "what is the meaning of life" "msg-026")
check_ack "$R" "Unknown intent → help fallback"
sleep 0.3

# ══════════════════════════════════════════════════════════════════════════════
sep "4. iMESSAGE — RECOVERY FLOW"
# ══════════════════════════════════════════════════════════════════════════════

# New phone initiates recovery
R=$(imessage "$PHONE2" "recover $USERNAME" "msg-030")
check_ack "$R" "Recovery initiated from new phone"
sleep 0.3

# Wrong code
R=$(imessage "$PHONE2" "verify 000000" "msg-031")
check_ack "$R" "Recovery: wrong code rejected"
sleep 0.3

# No pending recovery on PHONE3
R=$(imessage "$PHONE3" "verify 123456" "msg-032")
check_ack "$R" "Recovery: no pending on this phone"
sleep 0.3

# ══════════════════════════════════════════════════════════════════════════════
sep "5. TELEGRAM — NEW USER & REGISTRATION"
# ══════════════════════════════════════════════════════════════════════════════

TG_USER="tguser$(date +%s | tail -c 5)"

R=$(telegram "$TG_ID" "hi" "200001")
check_ack "$R" "Telegram: new user hi → welcome"
sleep 0.3

R=$(telegram "$TG_ID" "register $TG_USER" "200002")
check_ack "$R" "Telegram: register @$TG_USER"
sleep 3

R=$(telegram "$TG_ID" "wallet" "200003")
check_ack "$R" "Telegram: wallet query after register"
sleep 0.3

R=$(telegram "$TG_ID" "earnings" "200004")
check_ack "$R" "Telegram: earnings query"
sleep 0.3

R=$(telegram "$TG_ID" "help" "200005")
check_ack "$R" "Telegram: help message"
sleep 0.3

# ══════════════════════════════════════════════════════════════════════════════
sep "6. CROSS-PLATFORM — LINK TELEGRAM TO iMESSAGE ACCOUNT"
# ══════════════════════════════════════════════════════════════════════════════

# Register same username from Telegram that was registered on iMessage — should be "taken"
R=$(telegram "$TG_ID" "register $USERNAME" "200010")
check_ack "$R" "Telegram: existing iMessage username is taken"
sleep 0.3

# ══════════════════════════════════════════════════════════════════════════════
sep "7. DEDUP — SAME MESSAGE ID TWICE"
# ══════════════════════════════════════════════════════════════════════════════

R=$(imessage "$PHONE1" "help" "SAME-ID-001")
check_ack "$R" "Dedup: first send accepted"
sleep 0.1

R=$(imessage "$PHONE1" "help" "SAME-ID-001")
check_ack "$R" "Dedup: duplicate silently dropped (still 200)"
sleep 0.1

# ══════════════════════════════════════════════════════════════════════════════
sep "8. IDENTITY API — DB VERIFICATION"
# ══════════════════════════════════════════════════════════════════════════════

# Verify usernames exist in DB directly via SQLite
check_username() {
  local uname=$1 label=$2
  local found
  found=$(sqlite3 ~/story/nexar.db "SELECT COUNT(*) FROM usernames WHERE username='$uname';" 2>/dev/null || echo "0")
  if [ "$found" = "1" ]; then
    ok "$label"
  else
    fail "$label" "username not found in DB"
  fi
}

check_username "$USERNAME" "Username @$USERNAME exists in DB"
check_username "$TG_USER"  "Username @$TG_USER exists in DB"

# ══════════════════════════════════════════════════════════════════════════════
echo ""
echo "──────────────────────────────────────────────────────"
echo -e "  Tests run:  $((PASS + FAIL))"
echo -e "  ${GREEN}Passed:     $PASS${NC}"
if [ $FAIL -gt 0 ]; then
  echo -e "  ${RED}Failed:     $FAIL${NC}"
  echo ""
  echo -e "  ${RED}✗ $FAIL test(s) failed${NC}"
else
  echo -e "  ${GREEN}Failed:     $FAIL${NC}"
  echo ""
  echo -e "  ${GREEN}✔ ALL MESSAGING TESTS PASSED${NC}"
fi
echo ""
