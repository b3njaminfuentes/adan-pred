# BRIER PROTOCOL — Vault Feature Blueprint
## ADAN como el primer bot con vault abierto

---

## 1. La visión en una oración

> Un usuario entra a brier.world, ve el track record de ADAN en vivo (trades, WR, Brier score), conecta su wallet y deposita USDC — ADAN tradea por él y Brier distribuye las ganancias.

---

## 2. Los 3 estados del vault (flujo de vida)

```
SHADOW (hoy)          VAULT ABIERTO            VAULT ACTIVO
─────────────         ────────────────         ──────────────
ADAN paper-trades  →  Vault visible en         Depósitos reales
reporta a Brier       brier.world              ADAN tradea real
acumula track         nadie puede              Brier distribuye
record                depositar todavía     →  ganancias al vault
                      pero lo VEN
```

**El objetivo inmediato:** llegar al estado VAULT ABIERTO.
El vault tiene $0 pero está visible, tiene stats en vivo, y el botón "Deposit" existe (aunque esté deshabilitado o libre).

---

## 3. Qué hay que construir en `brier-protocol`

### 3A. Base de datos — tablas nuevas

```sql
-- Tabla de vaults
CREATE TABLE vaults (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bot_id        UUID REFERENCES bots(id) ON DELETE CASCADE,
  owner_wallet  TEXT NOT NULL,        -- wallet del dueño (benjofuentesv14)
  status        TEXT NOT NULL DEFAULT 'open',  -- open | paused | closed
  currency      TEXT NOT NULL DEFAULT 'USDC',
  total_aum     DECIMAL(18,6) DEFAULT 0,       -- total assets under management
  performance_fee_pct DECIMAL(5,2) DEFAULT 10, -- % que cobra ADAN de ganancias
  min_deposit   DECIMAL(18,6) DEFAULT 10,      -- mínimo para depositar (ej. 10 USDC)
  max_aum       DECIMAL(18,6) DEFAULT 100000,  -- tope total del vault
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW()
);

-- Tabla de depósitos de inversores
CREATE TABLE vault_deposits (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id      UUID REFERENCES vaults(id),
  investor_wallet TEXT NOT NULL,
  amount_usdc   DECIMAL(18,6) NOT NULL,
  shares        DECIMAL(18,6) NOT NULL,    -- shares proporcionales del vault
  tx_hash       TEXT,                      -- hash de la transacción on-chain
  status        TEXT DEFAULT 'pending',    -- pending | confirmed | withdrawn
  deposited_at  TIMESTAMPTZ DEFAULT NOW(),
  withdrawn_at  TIMESTAMPTZ
);

-- Tabla de NAV histórico (Net Asset Value por share)
CREATE TABLE vault_nav_history (
  id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  vault_id UUID REFERENCES vaults(id),
  nav      DECIMAL(18,6) NOT NULL,   -- valor de 1 share (empieza en 1.00)
  aum      DECIMAL(18,6) NOT NULL,   -- total AUM en ese momento
  recorded_at TIMESTAMPTZ DEFAULT NOW()
);
```

### 3B. API endpoints nuevos en brier-protocol

```
GET  /api/vaults/:botSlug              → stats públicos del vault (sin auth)
POST /api/vaults/:botSlug/deposit      → registrar intención de depósito (con wallet sig)
POST /api/vaults/:botSlug/withdraw     → retirar
GET  /api/vaults/:botSlug/investors    → lista de inversores (paginada)
GET  /api/vaults/:botSlug/nav-history  → historial de NAV para el gráfico
PATCH /api/vaults/:botSlug             → actualizar status/config (solo owner)
```

**Respuesta de `GET /api/vaults/:botSlug` (lo que ve el mundo):**
```json
{
  "botSlug": "adan-pred",
  "botName": "ADAN-PRED",
  "ownerWallet": "0x...",
  "status": "open",
  "currency": "USDC",
  "totalAUM": 0,
  "investorCount": 0,
  "nav": 1.00,
  "performanceFeePct": 10,
  "minDeposit": 10,
  "maxAUM": 100000,
  "trackRecord": {
    "totalTrades": 142,
    "winRate": 0.58,
    "brierScore": 0.21,
    "tier": "tier1",
    "daysActive": 12
  }
}
```

### 3C. Página pública del vault en Next.js

**Ruta:** `/bot/[slug]/vault`  o en la misma página del bot con una tab "Vault"

**Lo que se muestra (aunque el vault esté en $0):**

```
┌─────────────────────────────────────────────────────┐
│  ADAN-PRED VAULT                         🟢 OPEN    │
├─────────────────────────────────────────────────────┤
│  AUM Total          NAV/Share    Inversores          │
│  $0 USDC            $1.0000      0                  │
├─────────────────────────────────────────────────────┤
│  Track Record (shadow training)                      │
│  142 trades  58% WR  Brier: 0.21  Tier 1           │
│  ████████████░░░░░░  [gráfico de NAV]               │
├─────────────────────────────────────────────────────┤
│  [Connect Wallet]  →  [Deposit USDC]                │
│  Min: $10 USDC  |  Fee: 10% sobre ganancias        │
└─────────────────────────────────────────────────────┘
```

**Flujo UX connect wallet → depositar:**
1. Usuario hace clic en **"Connect Wallet"** (wagmi/RainbowKit)
2. Se muestra cuánto tiene de USDC
3. Usuario escribe el monto → clic **"Deposit"**
4. **Opción A (sin smart contract):** El usuario transfiere USDC directamente a una wallet de custodia de Brier, y Brier registra su participación en la DB. Simple pero centralizado.
5. **Opción B (con smart contract):** El usuario llama a `vault.deposit(amount)` en el contrato, que emite un evento y mintea shares. Descentralizado pero más complejidad.

**Para empezar: Opción A (custodia central)** — más rápido de lanzar, se puede migrar al contrato después.

### 3D. Modelo de shares (cómo se reparten ganancias)

```
Depósito inicial: 100 USDC → recibe 100 shares (NAV = $1.00)

ADAN gana +20% en 30 días:
  NAV sube a $1.20

Si alguien nuevo deposita 100 USDC ahora:
  100 / 1.20 = 83.3 shares

Si el primero retira sus 100 shares:
  100 shares × $1.20 NAV = $120
  ADAN cobra 10% sobre la ganancia: 10% × $20 = $2
  Inversor recibe: $118
```

---

## 4. Lo que ya funciona hoy (no hay que construir)

✅ **ADAN reporta cada paper trade a Brier** → `POST /api/bots/adan-pred/paper-trade`  
✅ **Brier calcula Brier score, WR, total trades** → ya aparece en brier.world  
✅ **brier-reporter.js** → ya conectado en adan-pred  
✅ **BRIER_URL, BRIER_BOT_SLUG, BRIER_INGEST_KEY** → ya definidos en .env.example  

Solo falta el **vault layer** encima del tracking que ya existe.

---

## 5. Orden de construcción recomendado

```
Semana 1: Vault básico (sin depósitos reales)
  ├─ Schema SQL: vaults table
  ├─ API: GET /api/vaults/:slug (stats públicos)
  └─ Página: /bot/[slug]/vault con stats del bot + "OPEN" badge

Semana 2: Connect wallet + depósito (Opción A - custodia)
  ├─ wagmi/RainbowKit en frontend
  ├─ Wallet de custodia Brier (multisig Safe recomendado)
  ├─ API: POST /api/vaults/:slug/deposit
  └─ vault_deposits table

Semana 3: NAV + shares + withdraw
  ├─ Cron job que actualiza NAV cada día
  ├─ vault_nav_history table
  ├─ API: POST /api/vaults/:slug/withdraw
  └─ Gráfico de NAV en la página

Futuro: smart contract de custodia (EVM — Polygon o Base)
```

---

## 6. Cómo abrir esta sesión en brier-protocol

1. En claude.ai/code → **New Session**
2. Seleccionar repo: `b3njaminfuentes/brier-protocol`
3. Decirle a Claude: *"Implementa el vault blueprint que está en adan-pred/docs/vault-blueprint.md — empieza por la Semana 1"*

---

## 7. Variables de entorno que necesitará brier-protocol

```env
# Wallet de custodia donde llegan los depósitos (tuya, multisig recomendado)
CUSTODY_WALLET_ADDRESS=0x...

# Para verificar firmas de wallet en el backend
NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID=...

# Chain donde vive el USDC (Polygon recomendado — gas barato)
CHAIN_ID=137
USDC_CONTRACT=0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359
```
