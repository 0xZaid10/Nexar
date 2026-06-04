# ⬡ NEXAR — Private Intelligence Graph

> Register any file as on-chain intellectual property. Sell access cryptographically. Earn royalties automatically. All through Telegram.

---

## What is NEXAR?

NEXAR is a messaging-native IP monetization platform built on [Story Protocol](https://story.foundation) and [CDR (Confidential Data Rails)](https://docs.piplabs.xyz). It lets anyone turn their files — datasets, models, research, strategies, creative work — into licensed intellectual property that generates royalties every time someone buys access.

The entire experience happens through Telegram. No wallets to set up. No blockchain knowledge required. Just send a file and NEXAR handles everything: on-chain registration, encryption, licensing, and royalty distribution.

---

## The Problem

Creators, researchers, and data producers have no reliable way to:

- Prove they created something first
- Control who accesses their work
- Earn money when others use it
- Do any of this without technical blockchain knowledge

Existing solutions require users to connect wallets, pay gas, understand smart contracts, and navigate complex UIs. Most people give up before they start.

---

## The NEXAR Solution

NEXAR collapses the entire IP lifecycle into a conversation:

```
You: [sends a file]
NEXAR: ✅ Registered as IP on Story Protocol
       📋 Name: research-q3.pdf
       🔐 CDR vault created — only license holders can decrypt
       💰 Price: 0.1 IP per access

Someone else: buy @yourhandle/research-q3
NEXAR: 🛒 Confirm purchase for 0.1 IP? (confirm/cancel)

You: earnings
NEXAR: 💰 research-q3.pdf — 0.3000 WIP claimable

You: claim
NEXAR: ✅ 0.3 WIP claimed and sent to your wallet
```

That's it. The entire IP monetization lifecycle in a chat.

---

## How It Works

### For Creators

1. **Register** — Send any file to the NEXAR Telegram bot. It gets registered as an IP asset on Story Protocol with a unique on-chain identity. The file is AES-encrypted and stored on IPFS via Pinata. The encryption key goes into a CDR vault — not onto NEXAR's servers.

2. **Set terms** — Choose your access model: open (anyone can buy), private (specific person only), or timed (access expires after N hours via `TimedAccessCondition`). The minting fee goes to your royalty vault automatically on every purchase.

3. **Earn** — Every time someone buys a license, the fee flows into your Story Protocol royalty vault on-chain. Check earnings anytime with `earnings`. Claim with `claim` — it goes straight to your non-custodial wallet.

### For Buyers

1. **Discover** — Browse available IP on the NEXAR dashboard or ask the bot: `buy @username/filename`

2. **Buy** — Confirm the purchase. A license token gets minted to your wallet on-chain. This token is cryptographically your key — it is the only thing that unlocks the file.

3. **Access** — Type `access @username/filename`. The CDR validators check your license token on-chain, release the decryption key through threshold cryptography, and NEXAR delivers the decrypted file directly to your Telegram chat.

### Timed Access

Creators can issue time-limited vaults using the `TimedAccessCondition` contract. When a timed vault is created:
- A TTL (time-to-live) is set on-chain in seconds
- CDR validators enforce the expiry — after the TTL passes, `checkWriteCondition()` returns false and the vault becomes permanently inaccessible
- No manual revocation needed — access expires trustlessly on-chain
- Useful for: review copies, trial access, time-sensitive research, temporary collaborator access

```
You: [sends file] → "timed" → @reviewer for 48 hours
NEXAR: ✅ Timed vault created — expires in 48h
       @reviewer can access until [timestamp]
       After that: vault sealed permanently on-chain
```

---

## Use Cases

### 👤 Individuals
Share any files secretly to anyone , give access only to the person you want to share , fully encrypted on -chain , share secrets , images, files, videos , documents etc..
### 📊 Data Researchers
Register proprietary datasets, market research, or signal strategies. Sell access to hedge funds, quant traders, or other researchers at a price you set. Every download is a license on-chain — auditable and permanent.

### 🤖 AI/ML Practitioners
Monetize fine-tuned models, training datasets, embeddings, or inference outputs. The `InferenceAccessCondition` contract gates model compute access — buyers need a valid license to run inference. Attribution and commercial rights are embedded in the NFT.

### 📝 Writers and Analysts
Sell premium reports, newsletters, whitepapers, or investigative research without a paywall service taking 30%. You set the price, you keep the royalties, and every buyer has a provable on-chain receipt.

### 🎵 Creators
Register music stems, sample packs, design assets, or any creative work. License terms — commercial use rights, attribution requirements, revenue sharing for derivatives — are all encoded on-chain in the PIL terms.

### 🏢 Enterprises
Share confidential documents, technical specifications, or proprietary processes with verified partners. Use timed vaults for review periods. CDR ensures only authorized parties can decrypt — even if the IPFS link is shared publicly.

---

## Key Features

| Feature | How it works |
|---|---|
| **Messaging-native** | Full IP lifecycle via Telegram and iMessage |
| **Non-custodial wallets** | Privy MPC — you own your keys, NEXAR never does |
| **CDR encryption** | Threshold cryptography — no single party holds the key |
| **On-chain licensing** | Story Protocol PIL terms — commercial rights in the NFT |
| **Timed access** | `TimedAccessCondition` — vaults expire trustlessly on-chain |
| **Inference gating** | `InferenceAccessCondition` — compute access per license |
| **Auto royalties** | Mint fee flows to royalty vault automatically |
| **Plagiarism detection** | Perceptual fingerprint check before every registration |
| **Cross-platform** | Telegram + iMessage + Web dashboard |

---

## Architecture

```
┌─────────────────────────────────────────────────────┐
│                    User Interface                    │
│         Telegram Bot · iMessage · Web Dashboard      │
└────────────────────┬────────────────────────────────┘
                     │
┌────────────────────▼────────────────────────────────┐
│                  NEXAR Backend                       │
│              Node.js / Express / SQLite              │
│                                                      │
│  ┌─────────────┐  ┌──────────────┐  ┌────────────┐  │
│  │   Identity  │  │ Asset Engine │  │  Messaging │  │
│  │  (Privy +   │  │  (Story SDK  │  │  (Telegram │  │
│  │   SQLite)   │  │  + CDR SDK)  │  │  +Spectrum)│  │
│  └─────────────┘  └──────────────┘  └────────────┘  │
└────┬──────────────────┬─────────────────┬────────────┘
     │                  │                 │
┌────▼────┐      ┌──────▼──────┐   ┌─────▼──────┐
│  Privy  │      │    Story    │   │    CDR     │
│  (MPC   │      │  Protocol  │   │    Rails   │
│ Wallets)│      │  Aeneid    │   │(Threshold  │
└─────────┘      │  Testnet   │   │  Crypto)   │
                 └──────┬──────┘   └────────────┘
                        │
                 ┌──────▼──────┐
                 │   Pinata    │
                 │(IPFS storage│
                 │ encrypted)  │
                 └─────────────┘
```

---

## Deployed Contracts

All NEXAR and Story Protocol contracts on Aeneid Testnet.

| | |
|---|---|
| **Network** | Aeneid Testnet |
| **Chain ID** | 1315 |
| **RPC** | https://aeneid.storyrpc.io |
| **Explorer** | https://aeneid.explorer.story.foundation |

### NEXAR Contracts

#### NEXARRegistry — `0x0abf194137a47E8cC6D8773E38c8CD399D674128`
The central registry for all NEXAR IP assets. Maps every `ipId` to its CDR `vaultUuid` on-chain, making the pairing publicly verifiable and permanent. Anyone can look up which vault holds a given IP asset's encrypted content.

```solidity
registerAsset(address ipId, uint256 vaultUuid, uint8 tier, uint256 basePrice)
```

#### DynamicPricingHook — `0xeAA90ff07786E2f8Ed7012faB5949a0257cCfb96`
Implements Story Protocol's `ILicensingHook` interface. Called by Story Protocol on every license mint to determine the exact minting fee for a given IP asset. Allows per-asset pricing rather than a flat fee across all IP — each asset can have its own price registered at time of creation.

```solidity
registerAsset(address ipId, uint8 tier, uint256 basePrice)
// Called by Story Protocol on mint:
beforeMintLicenseTokens(mintLicenseTokensParams) → mintingFee
```

#### TimedAccessCondition — `0x0c8cE21CE246aaa2601efBB5Eb3Ba22D0924E26b`
Enforces time-limited vault access directly on-chain. When a timed vault is created, the expiry timestamp is registered here. CDR validators call `checkWriteCondition()` before releasing key shards — if the current block timestamp exceeds the TTL, the call reverts and the vault is permanently sealed. No manual intervention required.

```solidity
checkWriteCondition(address caller, bytes conditionData) → bool
// conditionData = abi.encode(address ipId, uint256 expiresAt)
```

#### InferenceAccessCondition — `0x3cAF4AaDcbB9DEB261d4E23A010652cEc03E0d2b`
Custom read condition for `INFERENCE` tier assets. Beyond checking license ownership, it verifies compute unit allocation and license terms specific to model inference. Gating model access at the CDR layer means inference can only run if the caller has a valid, active license — preventing unauthorized model usage even if model weights are somehow obtained.

```solidity
checkAccess(address caller, bytes conditionData, bytes accessAuxData) → bool
```

#### ReputationRegistry — `0x6Cd86319C6977811432881b08F14dC8E7dc2640F`
Tracks operator reputation scores on-chain. Currently used for future trust-based access control — allowing high-reputation operators to offer lower fees, priority access, or reduced collateral requirements. Foundation for a decentralized trust layer across the NEXAR network.

### Story Protocol Contracts (Aeneid)

| Contract | Address |
|---|---|
| SPG NFT Collection (NEXAR) | `0x6901E30ed2a14A78aB50BA13a4eE8a75D19467AE` |
| CDR Proxy | `0xCCCCCC0000000000000000000000000000000005` |
| CDR Implementation | `0xDC78a37C28A2d53441B8F09E26237320E0F9C0f9` |
| Operator / Deployer | `0xb92736aaE34B913497E775dFb52Bb7D334B11B2b` |

### Verifying a NEXAR IP On-Chain

```bash
# Via explorer
https://aeneid.explorer.story.foundation/ipa/<ipId>

# Programmatically
curl https://aeneid.storyrpc.io \
  -X POST \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc":"2.0","method":"eth_call",
    "params":[{
      "to": "0x1a9d0d28a0422E26D2b22BbC3572E3b59E60C2AB",
      "data": "<IPAssetRegistry.isRegistered(ipId) calldata>"
    },"latest"],
    "id":1
  }'
# Returns: true if registered
```

---

## Story Protocol — Programmable IP

Every file registered on NEXAR becomes a fully programmable IP asset on Story Protocol. This is not just metadata storage — it is a live on-chain identity with enforced commercial terms, automatic royalty distribution, and composable derivative rights.

### What happens when you register a file

**Step 1 — NFT Mint**
An ERC-721 token is minted on the NEXAR SPG NFT Collection (`0x6901E3...`). This NFT is proof of ownership. It lives in the creator's Privy MPC wallet permanently and can be transferred or traded like any NFT.

**Step 2 — IP Asset Registration**
The NFT is registered with Story Protocol's IP Asset Registry. This creates a canonical on-chain identity — the `ipId` — a deterministic address derived from the NFT contract and token ID. Every IP asset has one globally unique `ipId` that never changes.

**Step 3 — PIL Terms Attachment**
Programmable IP License (PIL) terms are registered and attached to the `ipId`. These terms are fully on-chain and encode:
- Whether commercial use is permitted
- The minting fee (how much buyers pay per license, routed through `DynamicPricingHook`)
- Revenue share percentage for derivative works
- Whether derivatives are allowed and under what conditions
- Attribution requirements

**Step 4 — Royalty Vault**
Story Protocol automatically deploys a royalty vault contract for every `ipId`. Every license purchase sends the minting fee directly into this vault — nobody can redirect or intercept it. The vault accumulates WIP (Wrapped IP) tokens that the creator claims at will.

**Step 5 — NEXARRegistry + DynamicPricingHook**
The `ipId` and `vaultUuid` pair is written to `NEXARRegistry` on-chain. The asset's tier and base price are registered with `DynamicPricingHook` so Story Protocol knows what to charge on each license mint.

### When someone buys a license

`mintLicenseTokens()` is called on Story Protocol's License Token contract. This mints an ERC-721 license token to the buyer's wallet encoding:
- Which `ipId` it licenses
- Which PIL terms apply
- The receiver address

The minting fee is sent directly to the `ipId`'s royalty vault. The license token IS the access credential — it is non-fungible, on-chain, auditable, and permanent.

### When royalties are claimed

`claimAllRevenue()` sweeps accumulated WIP from the royalty vault into the IP account (an ERC-6551 token-bound account). An `execute()` call on the IP account then transfers the WIP to the owner's personal wallet. The entire flow is on-chain — NEXAR cannot intercept or redirect funds.

### Story Protocol functions used

| Function | Purpose |
|---|---|
| `mintAndRegisterIpAssetWithPilTerms()` | Mint NFT + register IP + attach PIL in one tx |
| `mintLicenseTokens()` | Issue ERC-721 license token to buyer |
| `claimAllRevenue()` | Sweep royalty vault to IP account |
| `execute(to, value, data)` | Transfer WIP from IP account to owner wallet (ERC-6551) |
| `getLicenseTerms()` | Read attached commercial terms for any IP |
| `predictMintingLicenseFee()` | Preview price before purchase |
| `getRoyaltyVaultAddress()` | Get vault contract address for a given `ipId` |

---

## CDR — Confidential Data Rails

CDR is a decentralized threshold cryptography network by PipLabs that enforces access conditions at the encryption layer — not at the application layer. NEXAR uses CDR as its content protection backbone.

The key insight: CDR makes access control **trustless**. NEXAR's server cannot give someone access to a file. Only the on-chain condition can. If you don't hold a valid license token, no amount of social engineering, server compromise, or IPFS link sharing will get you the file.

### The encryption model

When a file is registered, it is encrypted with a randomly generated AES-256-GCM key. The encrypted file goes to IPFS (public URL, but unreadable). The AES key is then encrypted under CDR's global public key — a threshold BLS key shared across the validator network — and stored in a CDR vault. NEXAR's server discards the plaintext AES key after upload.

```
File → AES-256-GCM encrypt → IPFS (public, unreadable without key)
AES key → TDH2 encrypt under CDR global pubkey → CDR vault (vaultUuid)
```

### Read and Write Conditions

Every CDR vault has two independent on-chain conditions that validators check before doing anything with the vault.

---

**Write Condition — `OwnerWriteCondition`**
```
Contract:      0x4C9bFC96d7092b590D497A191826C3dA2277c34B
conditionData: abi.encode(address operatorAddress)
```
Controls who can update the vault — change the encrypted content, rotate the key, or modify metadata. Only the NEXAR operator wallet (`0xb92736...`) can pass this condition. This prevents anyone from swapping the encrypted content or poisoning the key after registration.

Checked by validators when: `CDRCore.write()` is called.

---

**Read Condition — `LicenseReadCondition`**
```
Contract:      0xC0640AD4CF2CaA9914C8e5C44234359a9102f7a3
conditionData: abi.encode(address licenseTokenContract, address ipId)
accessAuxData: abi.encode(uint256[] licenseTokenIds)
```
The core access gate. When a buyer requests decryption, every CDR validator independently calls `LicenseReadCondition.checkAccess(msg.sender, conditionData, accessAuxData)` on-chain. The condition verifies that `msg.sender` owns a valid Story Protocol license token for this specific `ipId`. If yes — and only if yes — the validator releases its partial key shard.

Checked by validators when: `CDRCore.read()` is called by the buyer's wallet.

---

**Timed Read Condition — `TimedAccessCondition`**
```
Contract:      0x0c8cE21CE246aaa2601efBB5Eb3Ba22D0924E26b
conditionData: abi.encode(address ipId, uint256 expiresAt)
```
Used for timed vaults. Validators call `checkWriteCondition()` and if `block.timestamp > expiresAt`, the call reverts. The vault becomes permanently sealed — no key shards are ever released again regardless of who calls or what license they hold. Time-based access revocation is enforced by the chain itself, not by NEXAR.

---

**Inference Condition — `InferenceAccessCondition`**
```
Contract:      0x3cAF4AaDcbB9DEB261d4E23A010652cEc03E0d2b
```
For `INFERENCE` tier assets only. Extends the license check with compute unit verification — ensuring the caller has both a valid license AND sufficient compute allocation for the requested inference operation.

---

### The threshold decryption flow

When a buyer calls `access @handle/filename`:

1. NEXAR builds a `CDRCore.read(vaultUuid, accessAuxData)` transaction
2. The buyer's Privy server wallet signs and broadcasts it to Aeneid Testnet
3. Each CDR validator independently observes the transaction and:
   - Verifies the transaction is valid and confirmed
   - Calls `LicenseReadCondition.checkAccess()` on-chain
   - If the buyer holds a valid license → releases its partial key shard (TDH2 partial)
4. NEXAR collects partial shards from a threshold number of validators
5. `tdh2Combine()` reconstructs the AES key locally
6. Ciphertext is downloaded from Pinata IPFS by CID
7. AES-256-GCM decryption produces the original file
8. Decrypted bytes are delivered to the user's Telegram chat
9. AES key is discarded from memory — never stored

### Why this is trustless

- CDR validators are independent nodes — no single one can reconstruct the key
- Each validator checks the license condition independently on-chain — NEXAR cannot lie about who holds a license
- The encrypted file on IPFS is permanently unreadable without the AES key
- The AES key in CDR is permanently inaccessible without passing the on-chain condition
- Even if NEXAR's entire server is compromised, there is no stored key to steal
- Even if the IPFS CID leaks publicly, the ciphertext is useless without CDR

### CDR contracts used

| Contract | Address | Role |
|---|---|---|
| CDR Core Proxy | `0xCCCCCC0000000000000000000000000000000005` | Entry point for all read/write operations |
| CDR Implementation | `0xDC78a37C28A2d53441B8F09E26237320E0F9C0f9` | Underlying vault logic |
| LicenseReadCondition | `0xC0640AD4CF2CaA9914C8e5C44234359a9102f7a3` | License ownership check |
| OwnerWriteCondition | `0x4C9bFC96d7092b590D497A191826C3dA2277c34B` | Vault write restriction |
| TimedAccessCondition | `0x0c8cE21CE246aaa2601efBB5Eb3Ba22D0924E26b` | Time-based access expiry |
| InferenceAccessCondition | `0x3cAF4AaDcbB9DEB261d4E23A010652cEc03E0d2b` | Compute-gated inference |

---

## Identity and Wallet Architecture

Each NEXAR user gets a **Privy server-side MPC wallet** created automatically when they register. This is a non-custodial wallet where:

- The private key is split across Privy's MPC infrastructure — NEXAR's server holds no shard
- Signing happens via Privy's `eth_sendTransaction` API with `caip2: "eip155:1315"`
- NEXAR sends the unsigned transaction — Privy's MPC network signs and broadcasts it
- The resulting tx hash is tracked on-chain like any other transaction
- Users can export their wallet from Privy's dashboard at any time

Identity is anchored to Telegram via `tgInitData` — a cryptographic proof that a message genuinely came from a specific Telegram user ID, verified server-side using the bot token as the HMAC-SHA256 key. No Telegram action is processed without this verification passing first.

---

## Full Data Flows

### Registration

```
User sends file to Telegram bot
        │
        ▼
Verify tgInitData (HMAC-SHA256 with bot token)
        │
        ▼
Download file from Telegram CDN
        │
        ▼
Compute perceptual fingerprint → check against registry (plagiarism)
        │
        ▼
[Step 1] Build + upload metadata JSON to Pinata IPFS → ipURI
        │
        ▼
[Step 2] mintAndRegisterIpAssetWithPilTerms()
         → NFT minted to user wallet on SPG collection (0x6901E3...)
         → ipId assigned (deterministic address)
         → PIL terms attached (commercial, minting fee, revShare)
         → DynamicPricingHook registered
         → Royalty vault deployed for ipId
        │
        ▼
[Step 3] AES-256-GCM encrypt file bytes
         Upload ciphertext to Pinata IPFS → CID
        │
        ▼
[Step 4] Create CDR vault
         → readCondition:  LicenseReadCondition(0xC064..., ipId)
         → writeCondition: OwnerWriteCondition(0x4C9b..., operatorAddress)
         → Write TDH2-encrypted AES key into vault
         → Discard plaintext AES key
        │
        ▼
[Step 5] NEXARRegistry.registerAsset(ipId, vaultUuid, tier, basePrice)
        │
        ▼
[Step 6] Store in SQLite: assets(ipId, vaultUuid, owner, licenseTermsId)
        │
        ▼
[Step 7] Auto-mint owner license token → stored in licenses table
         (owner can CDR-read their own file immediately)
        │
        ▼
Bot sends: ipId, Story Explorer link, price, access command
```

### Access (CDR Read)

```
Buyer: "access @ox_zaid10/cat"
        │
        ▼
Resolve owner handle → wallet address → find asset by slug in SQLite
        │
        ▼
Check licenses table: does buyer hold a token for this ipId?
        │
        ▼
POST /api/vault/access { label, vaultUuid, licenseTokenIds }
        │
        ▼
getUserClients(label) → load Privy server wallet for buyer
        │
        ▼
VaultManager.accessFileVault({ uuid, licenseTokenIds })
        │
        ├─ Encode accessAuxData: abi.encode(uint256[] licenseTokenIds)
        │
        ├─ cdrClient.consumer.accessCDR({ uuid, accessAuxData })
        │       │
        │       ├─ Sign CDRCore.read(vaultUuid, accessAuxData) via Privy API
        │       ├─ Broadcast to Aeneid Testnet
        │       │
        │       └─ CDR Validators (each independently):
        │               ├─ Observe confirmed tx
        │               ├─ Call LicenseReadCondition.checkAccess()
        │               │   → Verify msg.sender holds license token for ipId
        │               ├─ If valid → release TDH2 partial shard
        │               └─ If expired (timed vault) → revert permanently
        │
        ├─ Collect threshold partials → tdh2Combine() → AES key
        ├─ Download ciphertext from Pinata IPFS by CID
        ├─ AES-256-GCM decrypt → original file bytes
        └─ Discard AES key from memory
        │
        ▼
Telegram sends decrypted file directly to buyer's chat
```

---

## Running the Project

### Prerequisites

Make sure you have **Node.js 22** installed. We recommend using [nvm](https://github.com/nvm-sh/nvm):

```bash
nvm install 22
nvm use 22
node --version  # should print v22.x.x
```

### Backend

```bash
git clone https://github.com/yourorg/nexar
cd nexar

npm install
cp .env.example .env
```

Fill in `.env`:

```env
# Privy (MPC wallets)
PRIVY_APP_ID=your_privy_app_id
PRIVY_APP_SECRET=your_privy_app_secret

# Telegram bot
TELEGRAM_BOT_TOKEN=your_bot_token

# Pinata (IPFS storage)
PINATA_JWT=your_pinata_jwt

# HuggingFace (plagiarism detection)
HF_API_TOKEN=your_hf_token

# App URL (ngrok or production domain)
NEXAR_APP_URL=https://your-domain.com

# Optional: iMessage via Spectrum
SPECTRUM_TOKEN=your_spectrum_token
```

```bash
npm run start:dev
# Runs on port 3001
```

Set your Telegram webhook:
```bash
curl -X POST "https://api.telegram.org/bot{TOKEN}/setWebhook" \
  -d "url=https://your-domain.com/webhook/telegram"
```

### Mini App

```bash
cd miniapp
npm install && npm run build
# Output → ../public/app/ (served by backend at GET /app)
```

### Dashboard

```bash
cd dashboard
npm install
cp .env.example .env
# Set VITE_BACKEND_URL=http://localhost:3001
# Set VITE_TELEGRAM_URL=https://t.me/your_bot
# Set VITE_MINIAPP_URL=https://your-domain.com/app
npm run dev
# → http://localhost:3002
```

---

## Bot Commands

| Command | Description |
|---|---|
| `register yourhandle` | Create your NEXAR identity |
| `[send any file]` | Register it as IP on Story Protocol |
| `my assets` | List your registered IP |
| `buy @handle/filename` | Purchase access to someone's IP |
| `access @handle/filename` | Decrypt and download a licensed file |
| `earnings` | Check claimable royalties per asset |
| `claim` | Claim all royalties to your wallet |
| `wallet` | View your wallet address |
| `whoami` | Handle, wallet, and linked platforms |
| `my licenses` | Files you have purchased |
| `help` | Full command list |

---

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js 22, Express, TypeScript, SQLite (better-sqlite3) |
| Blockchain | Story Protocol SDK, Viem, Aeneid Testnet (Chain ID 1315) |
| Encryption | CDR SDK (PipLabs), AES-256-GCM, TDH2 |
| Wallets | Privy Server Wallets (MPC, non-custodial) |
| Storage | Pinata (IPFS pinning) |
| Messaging | Telegram Bot API, Spectrum (iMessage) |
| Frontend | React 19, Vite, TailwindCSS v4, TanStack Query, Wouter |
| Process manager | PM2 (production) |

---


*NEXAR — where your intelligence becomes property.*
