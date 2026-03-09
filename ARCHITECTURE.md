# LendBTC — Protocol Architecture Reference (v2)

## File Structure

```
lend-btc/
├── src/
│   ├── index.ts          ← OP_NET entry point (factory + abort handler)
│   └── LendBTC.ts        ← Full protocol (~700 lines AssemblyScript)
├── build/
│   └── LendBTC.wasm      ← Compiled WASM (npm run build)
├── asconfig.json
├── package.json
└── tsconfig.json
```

---

## Lending Pools

Three pools, identified by `poolId: uint8`:

| poolId | Token | Type   | Role                                      |
|--------|-------|--------|-------------------------------------------|
| 0      | BTC   | Native | Primary liquidity & collateral            |
| 1      | MOTO  | OP-20  | Loyalty token — borrowing discounts       |
| 2      | PILL  | OP-20  | Protection token — reduces liquidation risk|

---

## Pool Accounting Model (Compound cToken Style)

Each pool maintains four derived values:

| Variable             | Type        | Description                                         |
|----------------------|-------------|-----------------------------------------------------|
| `totalDeposits`      | `StoredU256`| Total pool assets: original deposits + earned interest |
| `totalBorrowed`      | `StoredU256`| Outstanding debt including compounded interest      |
| `totalShares`        | `StoredU256`| Total deposit shares minted across all depositors   |
| `availableLiquidity` | computed    | `totalDeposits − totalBorrowed`                    |
| `utilizationRate`    | computed    | `totalBorrowed / totalDeposits` (basis points)     |
| `interestRate`       | computed    | Current annual APR (basis points, see curve below)  |
| `borrowIndex`        | `StoredU256`| Compound interest index (RAY = 10^18 at start)     |

### State Transitions

```
On deposit(amount):
  totalDeposits  += amount
  totalShares    += sharesToMint            (shares = amount × totalShares / totalDeposits)
  userShares     += sharesToMint
  availLiquidity ↑ by amount

On withdraw(amount):
  totalDeposits  -= amount
  totalShares    -= sharesToBurn            (sharesToBurn = amount × totalShares / totalDeposits)
  userShares     -= sharesToBurn
  availLiquidity ↓ by amount

On borrow(amount):
  totalBorrowed  += amount
  availLiquidity ↓ by amount
  userPrincipal  = compoundedExisting + amount  (normalised to currentIndex)

On repay(amount):
  totalBorrowed  -= actualRepaid
  availLiquidity ↑ by actualRepaid
  userPrincipal  = compoundedDebt − actualRepaid  (re-normalised)

On accrueInterest (every call, per pool):
  ratePerBlock   = annualRateBps × RAY / (10000 × 52560)
  indexDelta     = oldIndex × ratePerBlock × blocksDelta / RAY
  interestEarned = totalBorrowed × indexDelta / oldIndex
  totalDeposits += interestEarned    ← depositors profit
  totalBorrowed += interestEarned    ← borrowers owe more
  borrowIndex   += indexDelta
```

---

## Deposit Share System

Shares represent a user's proportional claim on pool assets. They appreciate
automatically as interest accrues — no user action required.

```
Share minting (deposit):
  If pool empty:   shares = amount              (1:1 initialisation)
  Otherwise:       shares = amount × totalShares / totalDeposits

Token redemption value:
  tokenBalance = userShares × totalDeposits / totalShares

Exchange rate (grows over time):
  exchangeRate = totalDeposits × RAY / totalShares
  → Starts at 1.0 × RAY; grows as interest is earned
```

**Example with 10% APR interest accrual:**
```
t=0:  deposit 1000, totalDeposits=1000, totalShares=1000, rate=1.0×RAY
t=1y: interestEarned = totalBorrowed × 10% added to totalDeposits
      totalDeposits=1100, totalShares=1000, rate=1.1×RAY
      user redeems 1000 shares → receives 1100 tokens (earned 10%)
```

---

## Three-Slope Interest Rate Curve

Verified against required data points:

| Utilization | APR   | Basis Points |
|-------------|-------|--------------|
| 0%          | 2%    | 200 bp       |
| 50%         | 6%    | 600 bp       |
| 80%         | 12%   | 1200 bp      |
| 95%         | 30%   | 3000 bp      |
| 100%        | ~36%  | 3600 bp      |

### Formula

```
Slope 1 (util 0% → 50%):
  rate = 200 + util × 400 / 5000

Slope 2 (util 50% → 80%):
  rate = 600 + (util − 5000) × 600 / 3000

Slope 3 (util > 80%):
  rate = 1200 + (util − 8000) × 1800 / 1500
```

All values in basis points. No floats — pure integer arithmetic.

### Per-Block Accrual

```
ratePerBlockRay = annualRateBps × RAY / (10000 × 52560)
newIndex = oldIndex + oldIndex × ratePerBlockRay × blocksDelta / RAY
```

---

## Collateral → Borrow Rules

| Collateral | Can borrow   |
|------------|-------------|
| BTC        | MOTO, PILL  |
| MOTO       | BTC         |
| PILL       | BTC         |

Auto-detected in `borrow()` — no explicit collateral pool argument needed.

---

## Risk Parameters

| Parameter              | Value     | Meaning                                |
|------------------------|-----------|----------------------------------------|
| Liquidation threshold  | 80% (LT)  | Used in HF numerator                   |
| Health factor floor    | 1.2 × RAY | Below this = liquidatable              |
| Liquidation bonus      | 5%        | Extra collateral given to liquidator   |
| Max liquidation/call   | 50%       | Prevents full seizure in one tx        |

**Health factor formula:**
```
HF = (collateralValue × 8000 × RAY) / (borrowValue × 10000)

At minimum viable position (150% collateral):
  HF = (150 × 0.80) / 100 = 1.20 ← exactly at boundary
```

---

## ABI — Frontend Integration

### Pool functions

```typescript
// Supply tokens → returns shares minted
deposit(poolId: uint8, amount: uint256) → sharesReceived: uint256

// Redeem by token amount → burns equivalent shares
withdraw(poolId: uint8, amount: uint256) → success: bool

// Borrow against auto-detected collateral
borrow(borrowPoolId: uint8, amount: uint256) → success: bool

// Repay debt → returns actual amount repaid
repay(poolId: uint8, amount: uint256) → actualRepaid: uint256

// Liquidate unhealthy position → returns collateral seized
liquidate(borrower: address, collateralPoolId: uint8, borrowPoolId: uint8, debtAmount: uint256) → collateralSeized: uint256
```

### View functions

```typescript
// Pool dashboard
getPoolInfo(poolId: uint8) → {
  totalDeposits:      uint256,
  totalBorrowed:      uint256,
  availableLiquidity: uint256,
  utilizationRate:    uint256,  // basis points 0–10000
  interestRate:       uint256,  // annual APR in basis points
}

// User deposit position
getUserBalance(user: address, poolId: uint8) → {
  shares:       uint256,   // lp-share tokens held
  tokenBalance: uint256,   // current redeemable token amount (includes earned interest)
}

// User borrow position
getUserVault(user: address) → {
  collateralValue: uint256,   // total collateral in satoshis
  borrowValue:     uint256,   // total debt in satoshis
  healthFactor:    uint256,   // RAY precision (1.2×10^18 = threshold)
}

// Quick health check
getHealthFactor(user: address) → uint256

// Pool share exchange rate (grows over time as interest accrues)
getExchangeRate(poolId: uint8) → uint256  // RAY precision
```

### Admin functions

```typescript
setTokenAddresses(moto: address, pill: address) → bool
setPrice(poolId: uint8, price: uint256) → bool        // price in sats × 10^8
setPaused(paused: bool) → bool
creditBtcDeposit(user: address, amount: uint256) → sharesReceived: uint256
```

---

## Storage Layout (34 pointers, strict order — never reorder)

```
 1  pausedPointer
 2  adminPointer
 3  priceBtcPointer
 4  priceMotoPointer
 5  pricePillPointer
 6  motoAddressPointer
 7  pillAddressPointer
 8  btcTotalDepositsPointer
 9  btcTotalBorrowedPointer
10  btcLastUpdatePointer
11  btcBorrowIndexPointer
12  btcTotalSharesPointer
13  motoTotalDepositsPointer
14  motoTotalBorrowedPointer
15  motoLastUpdatePointer
16  motoBorrowIndexPointer
17  motoTotalSharesPointer
18  pillTotalDepositsPointer
19  pillTotalBorrowedPointer
20  pillLastUpdatePointer
21  pillBorrowIndexPointer
22  pillTotalSharesPointer
23  userBtcSharesPointer
24  userMotoSharesPointer
25  userPillSharesPointer
26  userBtcBorrowPointer
27  userMotoBorrowPointer
28  userPillBorrowPointer
29  userBtcBorrowIdxPointer
30  userMotoBorrowIdxPointer
31  userPillBorrowIdxPointer
32  userBtcCollateralPointer
33  userMotoCollateralPointer
34  userPillCollateralPointer
```

---

## Build & Deploy

```bash
# Install
npm uninstall assemblyscript 2>/dev/null
npm install

# Verify (zero errors required)
npm run lint
npm run typecheck

# Build
npm run build  # → build/LendBTC.wasm

# Post-deploy setup
setTokenAddresses(motoContractAddress, pillContractAddress)
setPrice(0, 100000000)  # BTC = 1 sat/sat (10^8)
setPrice(1, 10000)      # MOTO initial price
setPrice(2, 5000)       # PILL initial price
```

---

## Security Invariants

- All u256 arithmetic via `SafeMath` — no raw operators
- No floats — rates in basis points (10 000 = 100%)
- CEI pattern: Checks → Effects → Interactions in every function
- Interest accrued before any pool state read
- Shares checked for zero before minting (prevents inflation attack on first deposit)
- Health factor verified before AND after every borrow and withdrawal
- `throw new Revert(...)` — never `throw Revert(...)` (missing `new` = silent no-op)
- `AddressMemoryMap` only — never native `Map<Address, T>` (reference equality broken)
- No while loops, no unbounded iteration
