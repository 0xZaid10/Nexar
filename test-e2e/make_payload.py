#!/usr/bin/env python3
# Helper: build JSON payloads with large base64 content
# Usage: python3 make_payload.py <template_name> [args...]
import sys, json, base64, os

cmd = sys.argv[1]

if cmd == "asset":
    # args: label, name, description, tier, content_file, content_type, commercial, rev_share, base_price
    label, name, desc, tier, content_file, ctype, commercial, rev, price = sys.argv[2:]
    with open(content_file, "rb") as f:
        content_b64 = base64.b64encode(f.read()).decode()
    payload = {
        "label": label, "name": name, "description": desc, "tier": tier,
        "content": content_b64, "contentType": ctype,
        "commercial": commercial == "true", "revShare": float(rev), "basePrice": price
    }
    print(json.dumps(payload))

elif cmd == "timed_vault":
    # args: label, ip_id, content_file, content_type, ttl
    label, ip_id, content_file, ctype, ttl = sys.argv[2:]
    with open(content_file, "rb") as f:
        content_b64 = base64.b64encode(f.read()).decode()
    payload = {
        "label": label, "ipId": ip_id,
        "content": content_b64, "contentType": ctype,
        "ttlSeconds": int(ttl)
    }
    print(json.dumps(payload))
