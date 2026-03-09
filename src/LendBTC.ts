/**
 * LendBTC — Bitcoin-native DeFi Lending Protocol on OP_NET
 *
 * Deposit & Withdraw System v3
 * ────────────────────────────
 * Three liquidity pools: BTC (native L1), MOTO (OP-20), PILL (OP-20).
 *
 * ┌─────────────────────────────────────────────────────────────────────┐
 * │  DEPOSIT SYSTEM                                                     │
 * │                                                                     │
 * │  1. userDeposits[user][token]  — net principal (deposited−withdrawn)│
 * │  2. userShares[user][token]    — deposit shares (LP position)       │
 * │  3. Shares appreciate as pool earns interest; no action needed      │
 * │                                                                     │
 * │  deposit(token, amount):                                            │
 * │    shares = amount × totalShares / totalDeposits (1:1 if empty)     │
 * │    totalDeposits  ↑ amount                                          │
 * │    totalShares    ↑ shares                                          │
 * │    userDeposits   ↑ amount                                          │
 * │    userShares     ↑ shares                                          │
 * │    availLiquidity ↑ amount                                          │
 * │                                                                     │
 * │  withdraw(token, amount):                                           │
 * │    sharesToBurn = amount × totalShares / totalDeposits              │
 * │    totalDeposits  ↓ amount                                          │
 * │    totalShares    ↓ sharesToBurn                                    │
 * │    userDeposits   ↓ amount  (clamped to 0)                          │
 * │    userShares     ↓ sharesToBurn                                    │
 * │    availLiquidity ↓ amount                                          │
 * │                                                                     │
 * │  View: getDepositPosition(user, token)                              │
 * │    → deposited, shares, tokenBalance, earnedInterest                │
 * │    → currentAPR (basis points), estimatedAPY, historicalAPY        │
 * │                                                                     │
 * │  View: getAllDepositPositions(user)                                  │
 * │    → above for BTC + MOTO + PILL in one call                        │
 * └─────────────────────────────────────────────────────────────────────┘
 *
 * Pool Accounting (Compound cToken style):
 *   totalDeposits = pool assets (deposits + accrued interest)
 *   totalBorrowed = outstanding debt (principal + compounded interest)
 *   availLiquidity = totalDeposits − totalBorrowed
 *   exchangeRate = totalDeposits / totalShares (grows over time)
 *
 * Interest Curve (three slopes, no floats):
 *   0% util  → 2%  APR   │  50% util → 6%  APR
 *   80% util → 12% APR   │  95% util → 30% APR
 *
 * Collateral Rules:  BTC → MOTO/PILL  │  MOTO → BTC  │  PILL → BTC
 *
 * Pool IDs:  POOL_BTC = 0  |  POOL_MOTO = 1  |  POOL_PILL = 2
 */

import {
    Blockchain,
    OP_NET,
    Address,
    Calldata,
    BytesWriter,
    Selector,
    StoredU256,
    StoredBoolean,
    StoredString,
    AddressMemoryMap,
    encodeSelector,
    SafeMath,
    Revert,
} from '@btc-vision/btc-runtime/runtime';

import { u256 } from '@btc-vision/as-bignum/assembly';

const EMPTY_POINTER: Uint8Array = new Uint8Array(30);

// ─────────────────────────────────────────────────────────────────────────────
// PRECISION CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

/** 10^18 — RAY fixed-point precision for borrow index, exchange rate, health factor */
const RAY: u256 = u256.fromString('1000000000000000000');

/** 10 000 = 100% in basis-point arithmetic */
const BASIS_POINTS: u256 = u256.fromU32(10000);

// ─────────────────────────────────────────────────────────────────────────────
// RISK CONSTANTS
// ─────────────────────────────────────────────────────────────────────────────

const LIQUIDATION_THRESHOLD_BPS: u256 = u256.fromU32(8000);
const HF_LIQUIDATION_THRESHOLD: u256  = u256.fromString('1200000000000000000');
const HF_PROTECTION_THRESHOLD: u256   = u256.fromString('1100000000000000000'); // 1.1×RAY — active when PILL staked
const LIQUIDATION_BONUS_BPS: u256     = u256.fromU32(500);
const MAX_LIQUIDATION_BPS: u256       = u256.fromU32(5000);

// ─────────────────────────────────────────────────────────────────────────────
// PILL PROTECTION SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
//
//  Users who stake PILL tokens into the protection contract lower their
//  effective liquidation HF threshold from 1.2 to 1.1.  This gives them a
//  10-percentage-point larger buffer before their vault becomes liquidatable.
//
//  Staking is SEPARATE from the PILL lending pool:
//    • Lending deposit → earns yield, used as borrow collateral
//    • Protection stake → locked for HF benefit, earns nothing, redeemable at will
//
//  Minimum stake to activate: PILL_MIN_STAKE (100 PILL, 10^8 decimals)
//
//  ┌──────────────────────────────────┬──────────────────────────────────────┐
//  │ State                            │ Liquidation HF threshold             │
//  ├──────────────────────────────────┼──────────────────────────────────────┤
//  │ No PILL staked (or < 100 PILL)   │ 1.20 × RAY  (standard)              │
//  │ ≥ 100 PILL staked                │ 1.10 × RAY  (protected)             │
//  └──────────────────────────────────┴──────────────────────────────────────┘

/** Minimum PILL (token units, 10^8 decimals) required to activate protection */
const PILL_MIN_STAKE: u256 = u256.fromString('10000000000'); // 100 PILL

// ─────────────────────────────────────────────────────────────────────────────
// RISK ENGINE — TIER THRESHOLDS & STATUS CODES
// ─────────────────────────────────────────────────────────────────────────────
//
//  Three-tier risk classification applied to every vault:
//
//  ┌─────────────────┬───────────────────────────────────────────────────────┐
//  │ Tier            │ Condition            │ Code │ Meaning                 │
//  ├─────────────────┼──────────────────────┼──────┼─────────────────────────┤
//  │ SAFE            │ HF > 1.5 × RAY       │  1   │ Healthy buffer          │
//  │ WARNING         │ 1.2 ≤ HF ≤ 1.5 × RAY│  2   │ Approaching liquidation │
//  │ LIQUIDATABLE    │ HF < 1.2 × RAY       │  3   │ Open to liquidators     │
//  │ NO_POSITION     │ no debt at all       │  0   │ Not in risk system      │
//  └─────────────────┴──────────────────────┴──────┴─────────────────────────┘
//
//  Safe borrow limit derivation:
//    HF > 1.5  →  collateral × 8000 / (borrow × 10000) > 1.5
//            →  borrow < collateral × 8000 / 15000
//  Warning borrow limit (liquidation floor):
//    HF > 1.2  →  borrow < collateral × 8000 / 12000
//
//  Action type codes used by previewRisk():
//    0 = addCollateral   1 = borrow   2 = repay   3 = withdrawCollateral

/** 1.5 × RAY — upper boundary between WARNING and SAFE tiers */
const HF_SAFE_THRESHOLD: u256 = u256.fromString('1500000000000000000');

/** Risk status codes returned by getRiskStatus() and previewRisk() */
const RISK_NONE:        u256  = u256.fromU32(0); // no debt — not monitored
const RISK_SAFE:        u256  = u256.fromU32(1); // HF > 1.5 × RAY
const RISK_WARNING:     u256  = u256.fromU32(2); // 1.2 ≤ HF ≤ 1.5 × RAY
const RISK_LIQUIDATABLE:u256  = u256.fromU32(3); // HF < 1.2 × RAY

/** Action codes for previewRisk() */
const ACTION_ADD_COLLATERAL:     u8 = 0;
const ACTION_BORROW:             u8 = 1;
const ACTION_REPAY:              u8 = 2;
const ACTION_WITHDRAW_COLLATERAL:u8 = 3;

/**
 * Minimum collateral ratio: 150% (15 000 bp).
 * maxBorrowValue = collateralValue × BASIS_POINTS / COLLATERAL_RATIO_BPS
 *                = collateralValue × 10 000 / 15 000
 *                = collateralValue × 0.6667
 * Maximum LTV    = 10 000 / 15 000 × BASIS_POINTS = 6 666 bp (66.67%)
 */
const COLLATERAL_RATIO_BPS: u256 = u256.fromU32(15000);

/** Satoshi scale divisor used when converting token amounts to satoshi value */
const SAT_SCALE: u256 = u256.fromU32(100000000);

// ─────────────────────────────────────────────────────────────────────────────
// INTEREST RATE MODEL — THREE SLOPES
// ─────────────────────────────────────────────────────────────────────────────
//
//  Data points (all verified in _interestRate):
//   0%  util → 200  bp (2%)
//   50% util → 600  bp (6%)   ← kink 1
//   80% util → 1200 bp (12%)  ← kink 2
//   95% util → 3000 bp (30%)
//
//  Slope 1  [0–50%]:   rate = 200 + util × 400 / 5000
//  Slope 2  [50–80%]:  rate = 600 + (util−5000) × 600 / 3000
//  Slope 3  [>80%]:    rate = 1200 + (util−8000) × 1800 / 1500

const RATE_AT_ZERO:  u256 = u256.fromU32(200);
const RATE_AT_KINK1: u256 = u256.fromU32(600);
const RATE_AT_KINK2: u256 = u256.fromU32(1200);
const KINK1_UTIL:    u256 = u256.fromU32(5000);
const KINK2_UTIL:    u256 = u256.fromU32(8000);
const SLOPE1_DELTA:  u256 = u256.fromU32(400);
const SLOPE2_DELTA:  u256 = u256.fromU32(600);
const SLOPE2_RANGE:  u256 = u256.fromU32(3000);
const SLOPE3_DELTA:  u256 = u256.fromU32(1800);
const SLOPE3_RANGE:  u256 = u256.fromU32(1500);

/** Bitcoin produces ~144 blocks/day → 52 560 per year */
const BLOCKS_PER_YEAR: u256 = u256.fromU32(52560);

// ─────────────────────────────────────────────────────────────────────────────
// POOL IDs
// ─────────────────────────────────────────────────────────────────────────────

const POOL_BTC:  u8 = 0;
const POOL_MOTO: u8 = 1;
const POOL_PILL: u8 = 2;

// ─────────────────────────────────────────────────────────────────────────────
// MOTO LOYALTY SYSTEM
// ─────────────────────────────────────────────────────────────────────────────
//
//  Users who deposit MOTO into the protocol earn tiered borrowing discounts.
//  The discount is applied to the NEW principal recorded when a user borrows.
//  Pool totalBorrowed tracks the full amount (correct for liquidity accounting).
//  The gap is the protocol's loyalty subsidy.
//
//  Tier thresholds are in MOTO token units (10^8 decimals — same as BTC sats).
//
//  ┌──────┬────────────────┬──────────────────┬──────────────────────────────┐
//  │ Tier │ Min MOTO       │ Raw threshold     │ Borrow discount              │
//  ├──────┼────────────────┼──────────────────┼──────────────────────────────┤
//  │  0   │ < 100          │ < 10 000 000 000  │ 0 bp  — no discount         │
//  │  1   │ ≥ 100 MOTO     │ ≥ 10 000 000 000  │ 100 bp — 1% off borrow APR │
//  │  2   │ ≥ 500 MOTO     │ ≥ 50 000 000 000  │ 300 bp — 3% off borrow APR │
//  │  3   │ ≥ 1 000 MOTO   │ ≥ 100 000 000 000 │ 500 bp — 5% off borrow APR │
//  └──────┴────────────────┴──────────────────┴──────────────────────────────┘
//
//  "MOTO balance" = deposited MOTO LP share value (_userTokenBalance(user, POOL_MOTO)).
//  Holding MOTO in the protocol earns yield AND unlocks borrowing discounts.

/** Minimum deposited MOTO (token units, 10^8 decimals) per tier */
const LOYALTY_TIER1_MIN: u256 = u256.fromString('10000000000');   // 100 MOTO
const LOYALTY_TIER2_MIN: u256 = u256.fromString('50000000000');   // 500 MOTO
const LOYALTY_TIER3_MIN: u256 = u256.fromString('100000000000');  // 1 000 MOTO

/** Borrow interest discount in basis points per tier */
const LOYALTY_TIER1_DISCOUNT: u256 = u256.fromU32(100);  // 1%
const LOYALTY_TIER2_DISCOUNT: u256 = u256.fromU32(300);  // 3%
const LOYALTY_TIER3_DISCOUNT: u256 = u256.fromU32(500);  // 5%

// ─────────────────────────────────────────────────────────────────────────────
// CONTRACT
// ─────────────────────────────────────────────────────────────────────────────

@final
export class LendBTC extends OP_NET {

    // ── Storage pointer declarations ─────────────────────────────────────────
    // CRITICAL: never reorder, never insert between existing entries after deploy.
    // Only append new pointers at the END.

    // ── Protocol ──
    private readonly pausedPointer: u16            = Blockchain.nextPointer; // 1
    private readonly adminPointer: u16             = Blockchain.nextPointer; // 2

    // ── Oracle prices ──
    private readonly priceBtcPointer: u16          = Blockchain.nextPointer; // 3
    private readonly priceMotoPointer: u16         = Blockchain.nextPointer; // 4
    private readonly pricePillPointer: u16         = Blockchain.nextPointer; // 5

    // ── Token addresses ──
    private readonly motoAddressPointer: u16       = Blockchain.nextPointer; // 6
    private readonly pillAddressPointer: u16       = Blockchain.nextPointer; // 7

    // ── BTC pool globals ──
    private readonly btcTotalDepositsPointer: u16  = Blockchain.nextPointer; // 8
    private readonly btcTotalBorrowedPointer: u16  = Blockchain.nextPointer; // 9
    private readonly btcLastUpdatePointer: u16     = Blockchain.nextPointer; // 10
    private readonly btcBorrowIndexPointer: u16    = Blockchain.nextPointer; // 11
    private readonly btcTotalSharesPointer: u16    = Blockchain.nextPointer; // 12

    // ── MOTO pool globals ──
    private readonly motoTotalDepositsPointer: u16 = Blockchain.nextPointer; // 13
    private readonly motoTotalBorrowedPointer: u16 = Blockchain.nextPointer; // 14
    private readonly motoLastUpdatePointer: u16    = Blockchain.nextPointer; // 15
    private readonly motoBorrowIndexPointer: u16   = Blockchain.nextPointer; // 16
    private readonly motoTotalSharesPointer: u16   = Blockchain.nextPointer; // 17

    // ── PILL pool globals ──
    private readonly pillTotalDepositsPointer: u16 = Blockchain.nextPointer; // 18
    private readonly pillTotalBorrowedPointer: u16 = Blockchain.nextPointer; // 19
    private readonly pillLastUpdatePointer: u16    = Blockchain.nextPointer; // 20
    private readonly pillBorrowIndexPointer: u16   = Blockchain.nextPointer; // 21
    private readonly pillTotalSharesPointer: u16   = Blockchain.nextPointer; // 22

    // ── User deposit shares (LP tokens) ──
    private readonly userBtcSharesPointer: u16     = Blockchain.nextPointer; // 23
    private readonly userMotoSharesPointer: u16    = Blockchain.nextPointer; // 24
    private readonly userPillSharesPointer: u16    = Blockchain.nextPointer; // 25

    // ── User borrow principals ──
    private readonly userBtcBorrowPointer: u16     = Blockchain.nextPointer; // 26
    private readonly userMotoBorrowPointer: u16    = Blockchain.nextPointer; // 27
    private readonly userPillBorrowPointer: u16    = Blockchain.nextPointer; // 28

    // ── User borrow-index snapshots ──
    private readonly userBtcBorrowIdxPointer: u16  = Blockchain.nextPointer; // 29
    private readonly userMotoBorrowIdxPointer: u16 = Blockchain.nextPointer; // 30
    private readonly userPillBorrowIdxPointer: u16 = Blockchain.nextPointer; // 31

    // ── User collateral flags ──
    private readonly userBtcCollateralPointer: u16  = Blockchain.nextPointer; // 32
    private readonly userMotoCollateralPointer: u16 = Blockchain.nextPointer; // 33
    private readonly userPillCollateralPointer: u16 = Blockchain.nextPointer; // 34

    // ── userDeposits[user][token] — net principal (cumulative deposited − withdrawn) ──
    // Used for earnedInterest = tokenBalance − userDeposits
    private readonly userBtcNetDepositPointer: u16  = Blockchain.nextPointer; // 35
    private readonly userMotoNetDepositPointer: u16 = Blockchain.nextPointer; // 36
    private readonly userPillNetDepositPointer: u16 = Blockchain.nextPointer; // 37

    // ── userDepositBlock[user][token] — block of first deposit per pool ──
    // Used for historical APY = (earned / principal) / (elapsed / BLOCKS_PER_YEAR)
    private readonly userBtcDepositBlockPointer: u16  = Blockchain.nextPointer; // 38
    private readonly userMotoDepositBlockPointer: u16 = Blockchain.nextPointer; // 39
    private readonly userPillDepositBlockPointer: u16 = Blockchain.nextPointer; // 40

    // ── PILL protection stake ──
    // Separate from the PILL lending deposit — no yield, lowers liquidation HF threshold.
    private readonly userPillStakePointer: u16 = Blockchain.nextPointer; // 41

    // ── BTC Yield Loop tracking ──
    // Records the leverage level, initial BTC snapshot, and active flag per user.
    // Actual MOTO debt lives in the normal borrow maps (userMotoBorrow/Idx).
    private readonly userLoopLevelPointer:      u16 = Blockchain.nextPointer; // 42
    private readonly userLoopInitialBtcPointer: u16 = Blockchain.nextPointer; // 43
    private readonly userLoopActivePointer:     u16 = Blockchain.nextPointer; // 44

    // ─────────────────────────────────────────────────────────────────────────
    // STORAGE INSTANCES
    // ─────────────────────────────────────────────────────────────────────────

    private readonly paused: StoredBoolean       = new StoredBoolean(this.pausedPointer, false);
    private readonly adminAddress: StoredString  = new StoredString(this.adminPointer);

    // Prices (satoshis per token unit × 10^8 scale)
    private readonly priceBtc: StoredU256  = new StoredU256(this.priceBtcPointer,  EMPTY_POINTER);
    private readonly priceMoto: StoredU256 = new StoredU256(this.priceMotoPointer, EMPTY_POINTER);
    private readonly pricePill: StoredU256 = new StoredU256(this.pricePillPointer, EMPTY_POINTER);

    private readonly motoAddress: StoredString = new StoredString(this.motoAddressPointer);
    private readonly pillAddress: StoredString = new StoredString(this.pillAddressPointer);

    // ── BTC pool ──
    private readonly btcTotalDeposits: StoredU256 = new StoredU256(this.btcTotalDepositsPointer, EMPTY_POINTER);
    private readonly btcTotalBorrowed: StoredU256 = new StoredU256(this.btcTotalBorrowedPointer, EMPTY_POINTER);
    private readonly btcLastUpdate: StoredU256    = new StoredU256(this.btcLastUpdatePointer,    EMPTY_POINTER);
    private readonly btcBorrowIndex: StoredU256   = new StoredU256(this.btcBorrowIndexPointer,   EMPTY_POINTER);
    private readonly btcTotalShares: StoredU256   = new StoredU256(this.btcTotalSharesPointer,   EMPTY_POINTER);

    // ── MOTO pool ──
    private readonly motoTotalDeposits: StoredU256 = new StoredU256(this.motoTotalDepositsPointer, EMPTY_POINTER);
    private readonly motoTotalBorrowed: StoredU256 = new StoredU256(this.motoTotalBorrowedPointer, EMPTY_POINTER);
    private readonly motoLastUpdate: StoredU256    = new StoredU256(this.motoLastUpdatePointer,    EMPTY_POINTER);
    private readonly motoBorrowIndex: StoredU256   = new StoredU256(this.motoBorrowIndexPointer,   EMPTY_POINTER);
    private readonly motoTotalShares: StoredU256   = new StoredU256(this.motoTotalSharesPointer,   EMPTY_POINTER);

    // ── PILL pool ──
    private readonly pillTotalDeposits: StoredU256 = new StoredU256(this.pillTotalDepositsPointer, EMPTY_POINTER);
    private readonly pillTotalBorrowed: StoredU256 = new StoredU256(this.pillTotalBorrowedPointer, EMPTY_POINTER);
    private readonly pillLastUpdate: StoredU256    = new StoredU256(this.pillLastUpdatePointer,    EMPTY_POINTER);
    private readonly pillBorrowIndex: StoredU256   = new StoredU256(this.pillBorrowIndexPointer,   EMPTY_POINTER);
    private readonly pillTotalShares: StoredU256   = new StoredU256(this.pillTotalSharesPointer,   EMPTY_POINTER);

    // ── User shares (LP tokens) ──
    private readonly userBtcShares: AddressMemoryMap =
        new AddressMemoryMap(this.userBtcSharesPointer);
    private readonly userMotoShares: AddressMemoryMap =
        new AddressMemoryMap(this.userMotoSharesPointer);
    private readonly userPillShares: AddressMemoryMap =
        new AddressMemoryMap(this.userPillSharesPointer);

    // ── User borrow principals ──
    private readonly userBtcBorrow: AddressMemoryMap =
        new AddressMemoryMap(this.userBtcBorrowPointer);
    private readonly userMotoBorrow: AddressMemoryMap =
        new AddressMemoryMap(this.userMotoBorrowPointer);
    private readonly userPillBorrow: AddressMemoryMap =
        new AddressMemoryMap(this.userPillBorrowPointer);

    // ── User borrow-index snapshots ──
    private readonly userBtcBorrowIdx: AddressMemoryMap =
        new AddressMemoryMap(this.userBtcBorrowIdxPointer);
    private readonly userMotoBorrowIdx: AddressMemoryMap =
        new AddressMemoryMap(this.userMotoBorrowIdxPointer);
    private readonly userPillBorrowIdx: AddressMemoryMap =
        new AddressMemoryMap(this.userPillBorrowIdxPointer);

    // ── User collateral flags ──
    private readonly userBtcCollateral: AddressMemoryMap =
        new AddressMemoryMap(this.userBtcCollateralPointer);
    private readonly userMotoCollateral: AddressMemoryMap =
        new AddressMemoryMap(this.userMotoCollateralPointer);
    private readonly userPillCollateral: AddressMemoryMap =
        new AddressMemoryMap(this.userPillCollateralPointer);

    // ── userDeposits[user][token] — net principal tracker ──
    private readonly userBtcNetDeposit: AddressMemoryMap =
        new AddressMemoryMap(this.userBtcNetDepositPointer);
    private readonly userMotoNetDeposit: AddressMemoryMap =
        new AddressMemoryMap(this.userMotoNetDepositPointer);
    private readonly userPillNetDeposit: AddressMemoryMap =
        new AddressMemoryMap(this.userPillNetDepositPointer);

    // ── userDepositBlock[user][token] — first deposit block ──
    private readonly userBtcDepositBlock: AddressMemoryMap =
        new AddressMemoryMap(this.userBtcDepositBlockPointer);
    private readonly userMotoDepositBlock: AddressMemoryMap =
        new AddressMemoryMap(this.userMotoDepositBlockPointer);
    private readonly userPillDepositBlock: AddressMemoryMap =
        new AddressMemoryMap(this.userPillDepositBlockPointer);

    // ── PILL protection stakes ──
    private readonly userPillStake: AddressMemoryMap =
        new AddressMemoryMap(this.userPillStakePointer);

    // ── BTC Yield Loop state ──
    private readonly userLoopLevel:      AddressMemoryMap =
        new AddressMemoryMap(this.userLoopLevelPointer);
    private readonly userLoopInitialBtc: AddressMemoryMap =
        new AddressMemoryMap(this.userLoopInitialBtcPointer);
    private readonly userLoopActive:     AddressMemoryMap =
        new AddressMemoryMap(this.userLoopActivePointer);

    // ─────────────────────────────────────────────────────────────────────────
    // SELECTORS
    // ─────────────────────────────────────────────────────────────────────────

    private readonly depositSelector: Selector =
        encodeSelector('deposit(uint8,uint256)');
    private readonly withdrawSelector: Selector =
        encodeSelector('withdraw(uint8,uint256)');
    private readonly borrowSelector: Selector =
        encodeSelector('borrow(uint8,uint256)');
    private readonly repaySelector: Selector =
        encodeSelector('repay(uint8,uint256)');
    private readonly liquidateSelector: Selector =
        encodeSelector('liquidate(address,uint8,uint8,uint256)');
    private readonly creditBtcDepositSelector: Selector =
        encodeSelector('creditBtcDeposit(address,uint256)');
    private readonly setTokenAddressesSelector: Selector =
        encodeSelector('setTokenAddresses(address,address)');
    private readonly setPriceSelector: Selector =
        encodeSelector('setPrice(uint8,uint256)');
    private readonly setPausedSelector: Selector =
        encodeSelector('setPaused(bool)');
    private readonly getPoolInfoSelector: Selector =
        encodeSelector('getPoolInfo(uint8)');
    private readonly getDepositPositionSelector: Selector =
        encodeSelector('getDepositPosition(address,uint8)');
    private readonly getAllDepositPositionsSelector: Selector =
        encodeSelector('getAllDepositPositions(address)');
    private readonly getUserVaultSelector: Selector =
        encodeSelector('getUserVault(address)');
    private readonly getHealthFactorSelector: Selector =
        encodeSelector('getHealthFactor(address)');
    private readonly getExchangeRateSelector: Selector =
        encodeSelector('getExchangeRate(uint8)');
    private readonly getBorrowPositionSelector: Selector =
        encodeSelector('getBorrowPosition(address,uint8)');
    private readonly getAllBorrowPositionsSelector: Selector =
        encodeSelector('getAllBorrowPositions(address)');
    private readonly previewBorrowSelector: Selector =
        encodeSelector('previewBorrow(uint8,uint256)');

    // ── MOTO loyalty system ───────────────────────────────────────────────────
    private readonly getLoyaltyInfoSelector: Selector =
        encodeSelector('getLoyaltyInfo(address)');
    private readonly getEffectiveBorrowRateSelector: Selector =
        encodeSelector('getEffectiveBorrowRate(uint8)');

    // ── Interest rate model views ─────────────────────────────────────────────
    private readonly getInterestRatesSelector: Selector =
        encodeSelector('getInterestRates(uint8)');
    private readonly getAllPoolRatesSelector: Selector =
        encodeSelector('getAllPoolRates()');

    // ── Liquidation engine views ──────────────────────────────────────────────
    private readonly getLiquidationInfoSelector: Selector =
        encodeSelector('getLiquidationInfo(address)');
    private readonly previewLiquidationSelector: Selector =
        encodeSelector('previewLiquidation(address,uint8,uint8,uint256)');

    // ── Risk engine views ─────────────────────────────────────────────────────
    private readonly getRiskStatusSelector: Selector =
        encodeSelector('getRiskStatus(address)');
    private readonly previewRiskSelector2: Selector =
        encodeSelector('previewRisk(uint8,uint8,uint256)');
    private readonly getRiskParametersSelector: Selector =
        encodeSelector('getRiskParameters()');

    // ── Vault actions ──────────────────────────────────────────────────────────
    // addCollateral / withdrawCollateral are vault-semantic aliases for deposit /
    // withdraw.  They exist so the frontend can present a vault-centric UX while
    // sharing exactly the same on-chain storage and accounting logic.
    private readonly addCollateralSelector: Selector =
        encodeSelector('addCollateral(uint8,uint256)');
    private readonly withdrawCollateralSelector: Selector =
        encodeSelector('withdrawCollateral(uint8,uint256)');
    private readonly getVaultSelector: Selector =
        encodeSelector('getVault(address)');

    // ── PILL protection system ────────────────────────────────────────────────
    private readonly stakePillSelector: Selector =
        encodeSelector('stakePill(uint256)');
    private readonly unstakePillSelector: Selector =
        encodeSelector('unstakePill(uint256)');
    private readonly getPillProtectionSelector: Selector =
        encodeSelector('getPillProtection(address)');

    // ── BTC Yield Loop strategy ───────────────────────────────────────────────
    private readonly openLoopSelector: Selector =
        encodeSelector('openLoop(uint8)');
    private readonly closeLoopSelector: Selector =
        encodeSelector('closeLoop()');
    private readonly getLoopMetricsSelector: Selector =
        encodeSelector('getLoopMetrics(address)');
    private readonly previewLoopSelector: Selector =
        encodeSelector('previewLoop(uint8)');

    // ─────────────────────────────────────────────────────────────────────────
    // CONSTRUCTOR & DEPLOYMENT
    // ─────────────────────────────────────────────────────────────────────────

    public constructor() {
        super();
        // Only selector computation here — NEVER any storage writes.
    }

    public override onDeployment(_calldata: Calldata): void {
        // Runs ONCE. Store deployer as admin and record starting block per pool.
        this.adminAddress.value = Blockchain.tx.sender.toHex();

        const deployBlock: u256 = u256.fromU64(Blockchain.block.number);
        this.btcLastUpdate.set(deployBlock);
        this.motoLastUpdate.set(deployBlock);
        this.pillLastUpdate.set(deployBlock);
        // Initialise borrow indices to RAY.
        this.btcBorrowIndex.set(RAY);
        this.motoBorrowIndex.set(RAY);
        this.pillBorrowIndex.set(RAY);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // CALL ROUTING
    // ─────────────────────────────────────────────────────────────────────────

    public override execute(method: Selector, calldata: Calldata): BytesWriter {
        const selector: Selector = method;
        switch (selector) {
            case this.depositSelector:               return this._deposit(calldata);
            case this.withdrawSelector:              return this._withdraw(calldata);
            case this.borrowSelector:                return this._borrow(calldata);
            case this.repaySelector:                 return this._repay(calldata);
            case this.liquidateSelector:             return this._liquidate(calldata);
            case this.creditBtcDepositSelector:      return this._creditBtcDeposit(calldata);
            case this.setTokenAddressesSelector:     return this._setTokenAddresses(calldata);
            case this.setPriceSelector:              return this._setPrice(calldata);
            case this.setPausedSelector:             return this._setPaused(calldata);
            case this.getPoolInfoSelector:           return this._getPoolInfo(calldata);
            case this.getDepositPositionSelector:    return this._getDepositPosition(calldata);
            case this.getAllDepositPositionsSelector: return this._getAllDepositPositions(calldata);
            case this.getUserVaultSelector:          return this._getUserVault(calldata);
            case this.getHealthFactorSelector:       return this._getHealthFactor(calldata);
            case this.getExchangeRateSelector:        return this._getExchangeRate(calldata);
            case this.getBorrowPositionSelector:      return this._getBorrowPosition(calldata);
            case this.getAllBorrowPositionsSelector:   return this._getAllBorrowPositions(calldata);
            case this.previewBorrowSelector:          return this._previewBorrow(calldata);
            case this.addCollateralSelector:          return this._addCollateral(calldata);
            case this.withdrawCollateralSelector:     return this._withdrawCollateral(calldata);
            case this.getVaultSelector:               return this._getVault(calldata);
            case this.stakePillSelector:              return this._stakePill(calldata);
            case this.unstakePillSelector:            return this._unstakePill(calldata);
            case this.getPillProtectionSelector:      return this._getPillProtection(calldata);
            case this.openLoopSelector:               return this._openLoop(calldata);
            case this.closeLoopSelector:              return this._closeLoop(calldata);
            case this.getLoopMetricsSelector:         return this._getLoopMetrics(calldata);
            case this.previewLoopSelector:            return this._previewLoop(calldata);
            case this.getLoyaltyInfoSelector:          return this._getLoyaltyInfo(calldata);
            case this.getEffectiveBorrowRateSelector:  return this._getEffectiveBorrowRate(calldata);
            case this.getInterestRatesSelector:        return this._getInterestRates(calldata);
            case this.getAllPoolRatesSelector:          return this._getAllPoolRates(calldata);
            case this.getLiquidationInfoSelector:     return this._getLiquidationInfo(calldata);
            case this.previewLiquidationSelector:     return this._previewLiquidation(calldata);
            case this.getRiskStatusSelector:          return this._getRiskStatus(calldata);
            case this.previewRiskSelector2:           return this._previewRisk2(calldata);
            case this.getRiskParametersSelector:      return this._getRiskParameters(calldata);
            default:                                  return super.execute(method, calldata);
        }
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  DEPOSIT SYSTEM
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * deposit(token: uint8, amount: uint256) → sharesReceived: uint256
     *
     * Supply tokens to a lending pool.
     *
     * What happens on deposit:
     *   1. Interest is accrued to the current block (exchange rate updated).
     *   2. Deposit shares are calculated and minted.
     *   3. Pool totalDeposits and totalShares increase.
     *   4. userDeposits[caller][token] (net principal) increases by amount.
     *   5. First-deposit block is recorded (used for historical APY).
     *   6. Collateral is auto-enabled for this pool on first deposit.
     *   7. For MOTO/PILL: tokens are pulled from caller via transferFrom.
     *   8. For BTC: backend must have credited the deposit via creditBtcDeposit().
     *
     * Share minting formula:
     *   If pool is empty → shares = amount  (1:1 initialisation)
     *   Otherwise        → shares = amount × totalShares / totalDeposits
     *
     * Returns: sharesReceived — the LP shares minted for this deposit.
     *
     * Reverts if:
     *   - Protocol is paused
     *   - amount == 0
     *   - Computed shares == 0 (dust deposit)
     */
    @method(
        { name: 'token',  type: ABIDataTypes.UINT8   },
        { name: 'amount', type: ABIDataTypes.UINT256  }
    )
    @returns({ name: 'sharesReceived', type: ABIDataTypes.UINT256 })
    private _deposit(calldata: Calldata): BytesWriter {
        this._requireNotPaused();
        const token: u8       = calldata.readU8();
        const amount: u256    = calldata.readU256();
        const caller: Address = Blockchain.tx.sender;
        this._requireValidPool(token);
        if (u256.eq(amount, u256.Zero)) throw new Revert('LEND: deposit amount is zero');
        const shares: u256 = this.__doDeposit(caller, token, amount);
        const writer = new BytesWriter(32);
        writer.writeU256(shares);
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    //  VAULT ACTIONS
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * addCollateral(token: uint8, amount: uint256) → sharesReceived: uint256
     *
     * Vault-semantic entry point for supplying collateral.
     * Identical on-chain behaviour to deposit() — tokens are added to the
     * liquidity pool, LP shares are minted, and the pool is marked as active
     * collateral for the caller's vault. The dual naming lets the frontend
     * present a vault-centric UX without any separate storage or logic path.
     *
     * Vault state changes:
     *   collateralBalance[token]  ↑ amount (tracked via LP shares)
     *   totalCollateralValue      ↑ amount × price
     *   healthFactor              ↑ (more collateral → safer)
     *   availableCredit           ↑ (more capacity to borrow)
     *
     * Reverts if: paused | amount == 0 | invalid pool | dust (zero shares)
     */
    @method(
        { name: 'token',  type: ABIDataTypes.UINT8   },
        { name: 'amount', type: ABIDataTypes.UINT256  }
    )
    @returns({ name: 'sharesReceived', type: ABIDataTypes.UINT256 })
    private _addCollateral(calldata: Calldata): BytesWriter {
        this._requireNotPaused();
        const token: u8       = calldata.readU8();
        const amount: u256    = calldata.readU256();
        const caller: Address = Blockchain.tx.sender;
        this._requireValidPool(token);
        if (u256.eq(amount, u256.Zero)) throw new Revert('LEND: zero collateral amount');
        const shares: u256 = this.__doDeposit(caller, token, amount);
        const writer = new BytesWriter(32);
        writer.writeU256(shares);
        return writer;
    }

    /**
     * withdrawCollateral(token: uint8, amount: uint256) → success: bool
     *
     * Vault-semantic entry point for removing collateral.
     * Identical on-chain behaviour to withdraw(), with the added emphasis that
     * the vault's health factor is verified before any state is modified.
     *
     * Vault state changes:
     *   collateralBalance[token]  ↓ amount
     *   totalCollateralValue      ↓ amount × price
     *   healthFactor              ↓ (less collateral → riskier)
     *   availableCredit           ↓
     *
     * The withdrawal is rejected with a descriptive revert if the resulting
     * health factor would fall below the 1.2 × RAY liquidation threshold.
     *
     * Reverts if: paused | amount == 0 | invalid pool | insufficient shares |
     *             pool liquidity borrowed | HF would drop below 1.2
     */
    @method(
        { name: 'token',  type: ABIDataTypes.UINT8   },
        { name: 'amount', type: ABIDataTypes.UINT256  }
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    private _withdrawCollateral(calldata: Calldata): BytesWriter {
        this._requireNotPaused();
        const token: u8       = calldata.readU8();
        const amount: u256    = calldata.readU256();
        const caller: Address = Blockchain.tx.sender;
        this._requireValidPool(token);
        if (u256.eq(amount, u256.Zero)) throw new Revert('LEND: zero withdrawal amount');
        this.__doWithdraw(caller, token, amount);
        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  WITHDRAW SYSTEM
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * withdraw(token: uint8, amount: uint256) → success: bool
     *
     * Remove deposited tokens from a pool by burning deposit shares.
     *
     * What happens on withdrawal:
     *   1. Interest is accrued to the current block.
     *   2. Shares to burn are calculated: sharesToBurn = amount × totalShares / totalDeposits
     *   3. Caller must own >= sharesToBurn shares.
     *   4. Pool must have >= amount availableLiquidity (not borrowed out).
     *   5. If caller has active borrows, health factor is simulated post-withdrawal.
     *      Reverts if simulated HF < 1.2.
     *   6. Pool totalDeposits, totalShares, caller's shares all decrease.
     *   7. userDeposits[caller][token] decreases by amount (clamped at 0).
     *   8. Deposit block is cleared only if position is fully closed (shares == 0).
     *   9. For MOTO/PILL: tokens are transferred back to caller.
     *      For BTC: backend constructs the return L1 transaction.
     *
     * Note: Callers who have earned interest will receive MORE tokens than
     * they originally deposited (since tokenBalance = shares × exchangeRate,
     * and exchangeRate has grown).
     *
     * Reverts if:
     *   - Protocol is paused
     *   - amount == 0
     *   - Pool has insufficient liquidity
     *   - Caller has insufficient shares
     *   - Withdrawal would push health factor below 1.2
     */
    @method(
        { name: 'token',  type: ABIDataTypes.UINT8   },
        { name: 'amount', type: ABIDataTypes.UINT256  }
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    private _withdraw(calldata: Calldata): BytesWriter {
        this._requireNotPaused();
        const token: u8       = calldata.readU8();
        const amount: u256    = calldata.readU256();
        const caller: Address = Blockchain.tx.sender;
        this._requireValidPool(token);
        if (u256.eq(amount, u256.Zero)) throw new Revert('LEND: withdraw amount is zero');
        this.__doWithdraw(caller, token, amount);
        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  DEPOSIT POSITION VIEWS
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * getDepositPosition(user: address, token: uint8)
     *
     * Returns the complete deposit position for a user in a specific pool.
     *
     * Returns (8 values × 32 bytes):
     *   netDeposited    — cumulative raw amount deposited minus withdrawn (principal)
     *   shares          — current LP share balance
     *   tokenBalance    — current redeemable token value (shares × exchangeRate)
     *   earnedInterest  — tokenBalance − netDeposited (0 if not yet profitable)
     *   currentAPR      — pool's current annual rate in basis points (200 = 2%)
     *   estimatedAPY    — APR converted to approximate compound APY in basis points
     *   historicalAPYBps— actual APY earned since first deposit (basis points)
     *   firstDepositBlock — block number when user first deposited to this pool
     *
     * APY Formulas:
     *   estimatedAPY ≈ currentAPR × (1 + currentAPR/(BASIS_POINTS×BLOCKS_PER_YEAR))^BLOCKS_PER_YEAR
     *   (simplified to currentAPR for integer-safe approximation in this implementation)
     *
     *   historicalAPY = (earnedInterest / netDeposited)
     *                   / (blocksElapsed / BLOCKS_PER_YEAR)
     *                   × BASIS_POINTS
     */
    @method(
        { name: 'user',  type: ABIDataTypes.ADDRESS },
        { name: 'token', type: ABIDataTypes.UINT8   }
    )
    @returns(
        { name: 'netDeposited',      type: ABIDataTypes.UINT256 },
        { name: 'shares',            type: ABIDataTypes.UINT256 },
        { name: 'tokenBalance',      type: ABIDataTypes.UINT256 },
        { name: 'earnedInterest',    type: ABIDataTypes.UINT256 },
        { name: 'currentAPR',        type: ABIDataTypes.UINT256 },
        { name: 'estimatedAPY',      type: ABIDataTypes.UINT256 },
        { name: 'historicalAPYBps',  type: ABIDataTypes.UINT256 },
        { name: 'firstDepositBlock', type: ABIDataTypes.UINT256 }
    )
    private _getDepositPosition(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();
        const token: u8     = calldata.readU8();
        this._requireValidPool(token);

        const pos: DepositPosition = this._computeDepositPosition(user, token);

        const writer = new BytesWriter(32 * 8);
        writer.writeU256(pos.netDeposited);
        writer.writeU256(pos.shares);
        writer.writeU256(pos.tokenBalance);
        writer.writeU256(pos.earnedInterest);
        writer.writeU256(pos.currentAPR);
        writer.writeU256(pos.estimatedAPY);
        writer.writeU256(pos.historicalAPYBps);
        writer.writeU256(pos.firstDepositBlock);
        return writer;
    }

    /**
     * getAllDepositPositions(user: address)
     *
     * Returns deposit positions for all three pools (BTC, MOTO, PILL) in a single
     * on-chain call — minimises frontend RPC round-trips.
     *
     * Returns 24 uint256 values (8 per pool × 3 pools):
     *   [0..7]   BTC  position (same fields as getDepositPosition)
     *   [8..15]  MOTO position
     *   [16..23] PILL position
     */
    @method({ name: 'user', type: ABIDataTypes.ADDRESS })
    @returns(
        // BTC
        { name: 'btcNetDeposited',   type: ABIDataTypes.UINT256 },
        { name: 'btcShares',         type: ABIDataTypes.UINT256 },
        { name: 'btcTokenBalance',   type: ABIDataTypes.UINT256 },
        { name: 'btcEarned',         type: ABIDataTypes.UINT256 },
        { name: 'btcCurrentAPR',     type: ABIDataTypes.UINT256 },
        { name: 'btcEstimatedAPY',   type: ABIDataTypes.UINT256 },
        { name: 'btcHistoricalAPY',  type: ABIDataTypes.UINT256 },
        { name: 'btcDepositBlock',   type: ABIDataTypes.UINT256 },
        // MOTO
        { name: 'motoNetDeposited',  type: ABIDataTypes.UINT256 },
        { name: 'motoShares',        type: ABIDataTypes.UINT256 },
        { name: 'motoTokenBalance',  type: ABIDataTypes.UINT256 },
        { name: 'motoEarned',        type: ABIDataTypes.UINT256 },
        { name: 'motoCurrentAPR',    type: ABIDataTypes.UINT256 },
        { name: 'motoEstimatedAPY',  type: ABIDataTypes.UINT256 },
        { name: 'motoHistoricalAPY', type: ABIDataTypes.UINT256 },
        { name: 'motoDepositBlock',  type: ABIDataTypes.UINT256 },
        // PILL
        { name: 'pillNetDeposited',  type: ABIDataTypes.UINT256 },
        { name: 'pillShares',        type: ABIDataTypes.UINT256 },
        { name: 'pillTokenBalance',  type: ABIDataTypes.UINT256 },
        { name: 'pillEarned',        type: ABIDataTypes.UINT256 },
        { name: 'pillCurrentAPR',    type: ABIDataTypes.UINT256 },
        { name: 'pillEstimatedAPY',  type: ABIDataTypes.UINT256 },
        { name: 'pillHistoricalAPY', type: ABIDataTypes.UINT256 },
        { name: 'pillDepositBlock',  type: ABIDataTypes.UINT256 }
    )
    private _getAllDepositPositions(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();

        const btc:  DepositPosition = this._computeDepositPosition(user, POOL_BTC);
        const moto: DepositPosition = this._computeDepositPosition(user, POOL_MOTO);
        const pill: DepositPosition = this._computeDepositPosition(user, POOL_PILL);

        const writer = new BytesWriter(32 * 24);

        // BTC
        writer.writeU256(btc.netDeposited);
        writer.writeU256(btc.shares);
        writer.writeU256(btc.tokenBalance);
        writer.writeU256(btc.earnedInterest);
        writer.writeU256(btc.currentAPR);
        writer.writeU256(btc.estimatedAPY);
        writer.writeU256(btc.historicalAPYBps);
        writer.writeU256(btc.firstDepositBlock);

        // MOTO
        writer.writeU256(moto.netDeposited);
        writer.writeU256(moto.shares);
        writer.writeU256(moto.tokenBalance);
        writer.writeU256(moto.earnedInterest);
        writer.writeU256(moto.currentAPR);
        writer.writeU256(moto.estimatedAPY);
        writer.writeU256(moto.historicalAPYBps);
        writer.writeU256(moto.firstDepositBlock);

        // PILL
        writer.writeU256(pill.netDeposited);
        writer.writeU256(pill.shares);
        writer.writeU256(pill.tokenBalance);
        writer.writeU256(pill.earnedInterest);
        writer.writeU256(pill.currentAPR);
        writer.writeU256(pill.estimatedAPY);
        writer.writeU256(pill.historicalAPYBps);
        writer.writeU256(pill.firstDepositBlock);

        return writer;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  INTEREST RATE MODEL VIEWS
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * getInterestRates(token: uint8) → 8 uint256 values
     *
     * Complete interest rate snapshot for one lending pool.
     *
     * ┌───────────────────────────────────────────────────────────────────────┐
     * │  RATE DERIVATION                                                      │
     * │                                                                       │
     * │  utilizationRate  = totalBorrowed / totalDeposits  (basis points)    │
     * │                                                                       │
     * │  borrowAPR        = three-slope curve at utilization                 │
     * │    0% util → 200 bp (2%)   50% util → 600 bp (6%)                   │
     * │    80% util → 1200 bp (12%)  95% util → 3000 bp (30%)               │
     * │                                                                       │
     * │  supplyAPR        = borrowAPR × utilizationRate / 10 000            │
     * │    Only the utilized fraction of deposits earns interest.             │
     * │    Example: 80% util, 12% borrow → 9.6% supply APR                 │
     * │                                                                       │
     * │  APY approximation (continuous compounding, integer math):           │
     * │    APY ≈ APR + APR² / (2 × 10 000)                                  │
     * │    Accurate to < 0.2% for rates 0–30%; exact at small rates.        │
     * │    Derivation: first two terms of Taylor series of e^(APR/10000)−1  │
     * │                                                                       │
     * │  Automatic update:                                                    │
     * │    Rates are computed live from storage on every call. They change   │
     * │    automatically after every deposit, borrow, repay, or withdrawal   │
     * │    because those actions change totalDeposits / totalBorrowed.       │
     * └───────────────────────────────────────────────────────────────────────┘
     *
     * Returns:
     *   borrowAPR       — annual borrow rate in basis points
     *   supplyAPR       — annual supply earn rate in basis points
     *   borrowAPY       — approximate compound borrow APY in basis points
     *   supplyAPY       — approximate compound supply APY in basis points
     *   utilizationRate — pool utilization in basis points (0 = empty, 10000 = fully borrowed)
     *   totalDeposits   — total tokens in pool (original + earned interest)
     *   totalBorrowed   — total outstanding compounded debt
     *   availLiquidity  — free tokens available to borrow
     */
    @method({ name: 'token', type: ABIDataTypes.UINT8 })
    @returns(
        { name: 'borrowAPR',       type: ABIDataTypes.UINT256 },
        { name: 'supplyAPR',       type: ABIDataTypes.UINT256 },
        { name: 'borrowAPY',       type: ABIDataTypes.UINT256 },
        { name: 'supplyAPY',       type: ABIDataTypes.UINT256 },
        { name: 'utilizationRate', type: ABIDataTypes.UINT256 },
        { name: 'totalDeposits',   type: ABIDataTypes.UINT256 },
        { name: 'totalBorrowed',   type: ABIDataTypes.UINT256 },
        { name: 'availLiquidity',  type: ABIDataTypes.UINT256 }
    )
    private _getInterestRates(calldata: Calldata): BytesWriter {
        const token: u8 = calldata.readU8();
        this._requireValidPool(token);

        const rates: PoolRates = this._computePoolRates(token);

        const writer = new BytesWriter(32 * 8);
        writer.writeU256(rates.borrowAPR);
        writer.writeU256(rates.supplyAPR);
        writer.writeU256(rates.borrowAPY);
        writer.writeU256(rates.supplyAPY);
        writer.writeU256(rates.utilizationRate);
        writer.writeU256(rates.totalDeposits);
        writer.writeU256(rates.totalBorrowed);
        writer.writeU256(rates.availLiquidity);
        return writer;
    }

    /**
     * getAllPoolRates() → 24 uint256 values (8 per pool × 3 pools)
     *
     * Returns interest rates for all three pools (BTC, MOTO, PILL) in a
     * single call. Designed for the main lending dashboard that needs to
     * render a comparison table without 3 separate RPC round-trips.
     *
     * Layout:
     *   [0..7]   BTC  rates  (same 8 fields as getInterestRates)
     *   [8..15]  MOTO rates
     *   [16..23] PILL rates
     *
     * Field order per pool (prefix = btc / moto / pill):
     *   borrowAPR, supplyAPR, borrowAPY, supplyAPY,
     *   utilizationRate, totalDeposits, totalBorrowed, availLiquidity
     */
    @returns(
        // BTC
        { name: 'btcBorrowAPR',       type: ABIDataTypes.UINT256 },
        { name: 'btcSupplyAPR',       type: ABIDataTypes.UINT256 },
        { name: 'btcBorrowAPY',       type: ABIDataTypes.UINT256 },
        { name: 'btcSupplyAPY',       type: ABIDataTypes.UINT256 },
        { name: 'btcUtilizationRate', type: ABIDataTypes.UINT256 },
        { name: 'btcTotalDeposits',   type: ABIDataTypes.UINT256 },
        { name: 'btcTotalBorrowed',   type: ABIDataTypes.UINT256 },
        { name: 'btcAvailLiquidity',  type: ABIDataTypes.UINT256 },
        // MOTO
        { name: 'motoBorrowAPR',       type: ABIDataTypes.UINT256 },
        { name: 'motoSupplyAPR',       type: ABIDataTypes.UINT256 },
        { name: 'motoBorrowAPY',       type: ABIDataTypes.UINT256 },
        { name: 'motoSupplyAPY',       type: ABIDataTypes.UINT256 },
        { name: 'motoUtilizationRate', type: ABIDataTypes.UINT256 },
        { name: 'motoTotalDeposits',   type: ABIDataTypes.UINT256 },
        { name: 'motoTotalBorrowed',   type: ABIDataTypes.UINT256 },
        { name: 'motoAvailLiquidity',  type: ABIDataTypes.UINT256 },
        // PILL
        { name: 'pillBorrowAPR',       type: ABIDataTypes.UINT256 },
        { name: 'pillSupplyAPR',       type: ABIDataTypes.UINT256 },
        { name: 'pillBorrowAPY',       type: ABIDataTypes.UINT256 },
        { name: 'pillSupplyAPY',       type: ABIDataTypes.UINT256 },
        { name: 'pillUtilizationRate', type: ABIDataTypes.UINT256 },
        { name: 'pillTotalDeposits',   type: ABIDataTypes.UINT256 },
        { name: 'pillTotalBorrowed',   type: ABIDataTypes.UINT256 },
        { name: 'pillAvailLiquidity',  type: ABIDataTypes.UINT256 }
    )
    private _getAllPoolRates(_calldata: Calldata): BytesWriter {
        const btc:  PoolRates = this._computePoolRates(POOL_BTC);
        const moto: PoolRates = this._computePoolRates(POOL_MOTO);
        const pill: PoolRates = this._computePoolRates(POOL_PILL);

        const writer = new BytesWriter(32 * 24);

        // BTC
        writer.writeU256(btc.borrowAPR);
        writer.writeU256(btc.supplyAPR);
        writer.writeU256(btc.borrowAPY);
        writer.writeU256(btc.supplyAPY);
        writer.writeU256(btc.utilizationRate);
        writer.writeU256(btc.totalDeposits);
        writer.writeU256(btc.totalBorrowed);
        writer.writeU256(btc.availLiquidity);

        // MOTO
        writer.writeU256(moto.borrowAPR);
        writer.writeU256(moto.supplyAPR);
        writer.writeU256(moto.borrowAPY);
        writer.writeU256(moto.supplyAPY);
        writer.writeU256(moto.utilizationRate);
        writer.writeU256(moto.totalDeposits);
        writer.writeU256(moto.totalBorrowed);
        writer.writeU256(moto.availLiquidity);

        // PILL
        writer.writeU256(pill.borrowAPR);
        writer.writeU256(pill.supplyAPR);
        writer.writeU256(pill.borrowAPY);
        writer.writeU256(pill.supplyAPY);
        writer.writeU256(pill.utilizationRate);
        writer.writeU256(pill.totalDeposits);
        writer.writeU256(pill.totalBorrowed);
        writer.writeU256(pill.availLiquidity);

        return writer;
    }

    /**
     * getPoolInfo(token: uint8)
     *
     * Returns the five core pool metrics needed for a dashboard display.
     *
     * Returns:
     *   totalDeposits       — total tokens in pool (original + earned interest)
     *   totalBorrowed       — total outstanding debt (compounded)
     *   availableLiquidity  — totalDeposits − totalBorrowed
     *   utilizationRate     — basis points 0–10 000 (0% to 100%)
     *   interestRate        — current annual APR in basis points
     */
    @method({ name: 'token', type: ABIDataTypes.UINT8 })
    @returns(
        { name: 'totalDeposits',      type: ABIDataTypes.UINT256 },
        { name: 'totalBorrowed',      type: ABIDataTypes.UINT256 },
        { name: 'availableLiquidity', type: ABIDataTypes.UINT256 },
        { name: 'utilizationRate',    type: ABIDataTypes.UINT256 },
        { name: 'interestRate',       type: ABIDataTypes.UINT256 }
    )
    private _getPoolInfo(calldata: Calldata): BytesWriter {
        const token: u8 = calldata.readU8();
        this._requireValidPool(token);

        const totalDep: u256 = this._totalDeposits(token).value;
        const totalBor: u256 = this._totalBorrowed(token).value;
        const avail: u256    = this._availableLiquidity(token);
        const utilBps: u256  = this._utilizationRate(token);
        const rateBps: u256  = this._interestRate(utilBps);

        const writer = new BytesWriter(32 * 5);
        writer.writeU256(totalDep);
        writer.writeU256(totalBor);
        writer.writeU256(avail);
        writer.writeU256(utilBps);
        writer.writeU256(rateBps);
        return writer;
    }

    /**
     * getExchangeRate(token: uint8) → exchangeRate (RAY precision)
     *
     * exchangeRate = totalDeposits × RAY / totalShares
     * Starts at 1.0 × RAY on pool creation. Grows as interest accrues.
     * 1.05 × RAY means 1 share redeems for 1.05 tokens (5% yield earned).
     */
    @method({ name: 'token', type: ABIDataTypes.UINT8 })
    @returns({ name: 'exchangeRate', type: ABIDataTypes.UINT256 })
    private _getExchangeRate(calldata: Calldata): BytesWriter {
        const token: u8 = calldata.readU8();
        this._requireValidPool(token);

        const totalSh: u256  = this._totalShares(token).value;
        const totalDep: u256 = this._totalDeposits(token).value;

        const rate: u256 = u256.eq(totalSh, u256.Zero)
            ? RAY
            : SafeMath.div(SafeMath.mul(totalDep, RAY), totalSh);

        const writer = new BytesWriter(32);
        writer.writeU256(rate);
        return writer;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  BORROWING ENGINE
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * borrow(token: uint8, amount: uint256)
     *   → (collateralValue, borrowValue, ltvAfterBorrow, healthFactorAfter)
     *
     * Borrow tokens from a pool using collateral already deposited.
     *
     * ┌─────────────────────────────────────────────────────────────────────┐
     * │  COLLATERAL RULES                                                   │
     * │    userCollateral[user][BTC]  → can borrow MOTO or PILL            │
     * │    userCollateral[user][MOTO] → can borrow BTC                     │
     * │    userCollateral[user][PILL] → can borrow BTC                     │
     * │                                                                     │
     * │  COLLATERAL REQUIREMENT: 150% minimum                               │
     * │    If collateral value = $150, max borrow value = $100              │
     * │    Maximum LTV = 66.67% (10 000 / 15 000 basis points)             │
     * │                                                                     │
     * │  HEALTH FACTOR after borrow must stay >= 1.2 × 10^18               │
     * │    HF = (collateralValue × 80% × RAY) / borrowValue                 │
     * └─────────────────────────────────────────────────────────────────────┘
     *
     * Interest compounding:
     *   Any existing debt in this pool is normalised to the current borrow
     *   index before appending the new amount. This ensures the stored
     *   "principal" always reflects debt compounded to the last action.
     *
     * Returns four values so the frontend can update the UI immediately
     * without a second RPC call:
     *   collateralValue   — total collateral in satoshis (all enabled pools)
     *   borrowValue       — total debt in satoshis after this borrow
     *   ltvAfterBorrow    — loan-to-value ratio in basis points (max 6 666)
     *   healthFactorAfter — health factor in RAY precision
     *
     * Reverts if:
     *   - Protocol paused
     *   - amount == 0
     *   - No valid collateral for this borrow token (wrong collateral type)
     *   - Pool has insufficient liquidity
     *   - HF after borrow would fall below 1.2 (undercollateralised)
     */
    @method(
        { name: 'token',  type: ABIDataTypes.UINT8   },
        { name: 'amount', type: ABIDataTypes.UINT256  }
    )
    @returns(
        { name: 'collateralValue',   type: ABIDataTypes.UINT256 },
        { name: 'borrowValue',       type: ABIDataTypes.UINT256 },
        { name: 'ltvAfterBorrow',    type: ABIDataTypes.UINT256 },
        { name: 'healthFactorAfter', type: ABIDataTypes.UINT256 },
        { name: 'riskStatus',        type: ABIDataTypes.UINT256 },
        { name: 'loyaltyDiscountBps',type: ABIDataTypes.UINT256 },
        { name: 'loyaltyTier',       type: ABIDataTypes.UINT256 }
    )
    private _borrow(calldata: Calldata): BytesWriter {
        // ── CHECKS ──────────────────────────────────────────────────────────
        this._requireNotPaused();
        const token: u8       = calldata.readU8();
        const amount: u256    = calldata.readU256();
        const caller: Address = Blockchain.tx.sender;

        this._requireValidPool(token);
        if (u256.eq(amount, u256.Zero)) throw new Revert('LEND: zero borrow amount');

        // Enforce collateral→borrow pairing rules
        this._requireValidCollateral(caller, token);

        // Accrue interest so borrow index is fresh before computing HF
        this._accrueInterest(token);

        // Pool must have enough free tokens
        const avail: u256 = this._availableLiquidity(token);
        if (u256.lt(avail, amount)) throw new Revert('LEND: insufficient pool liquidity');

        // Simulate health factor AFTER borrow — must stay above the caller's effective threshold
        // (1.1×RAY if PILL protection active, 1.2×RAY otherwise)
        const hfAfter: u256 = this._simulatedHFAfterBorrow(caller, token, amount);
        if (u256.lt(hfAfter, this._liquidationThreshold(caller))) {
            throw new Revert('LEND: undercollateralised — 150% collateral required');
        }

        // ── LOYALTY DISCOUNT ─────────────────────────────────────────────────
        // Compute the caller's MOTO tier at borrow time.
        // The discount reduces the new borrow principal recorded for the user:
        //   effectivePrincipal = amount × (1 − discountBps / 10 000)
        // Pool totalBorrowed still records the full `amount` (liquidity accounting).
        // The difference is the protocol's subsidy cost for loyalty rewards.
        const discountBps: u256 = this._loyaltyDiscountBps(caller);
        const tier: u256        = this._loyaltyTier(caller);

        let effectiveAmount: u256;
        if (u256.eq(discountBps, u256.Zero)) {
            effectiveAmount = amount;
        } else {
            const discountTokens: u256 = SafeMath.div(
                SafeMath.mul(amount, discountBps), BASIS_POINTS,
            );
            effectiveAmount = SafeMath.sub(amount, discountTokens);
        }

        // ── EFFECTS ─────────────────────────────────────────────────────────
        // Normalise any existing debt to current index, then append the discounted
        // new borrow amount. Pool totalBorrowed tracks the full undiscounted amount
        // for accurate available-liquidity computation.
        const currentPrincipal: u256 = this._borrowMap(token).get(caller);
        const currentIdxSnap: u256   = this._borrowIdxMap(token).get(caller);
        const currentIndex: u256     = this._borrowIndex(token).value;

        let newPrincipal: u256;
        if (u256.eq(currentPrincipal, u256.Zero)) {
            // First borrow: record discounted amount directly
            newPrincipal = effectiveAmount;
        } else {
            // Compound existing principal to today, then append discounted new borrow
            const compoundedExisting: u256 = SafeMath.div(
                SafeMath.mul(currentPrincipal, currentIndex),
                currentIdxSnap,
            );
            newPrincipal = SafeMath.add(compoundedExisting, effectiveAmount);
        }

        this._borrowMap(token).set(caller, newPrincipal);
        this._borrowIdxMap(token).set(caller, currentIndex);

        // Pool tracks full amount borrowed (for available liquidity)
        const totalBorrowedStore: StoredU256 = this._totalBorrowed(token);
        totalBorrowedStore.set(SafeMath.add(totalBorrowedStore.value, amount));

        // ── COMPUTE RETURN VALUES ────────────────────────────────────────────
        const collatValue: u256  = this._totalCollateralValue(caller);
        const newBorrowVal: u256 = this._totalBorrowValue(caller);

        let ltvBps: u256;
        if (u256.eq(collatValue, u256.Zero)) {
            ltvBps = u256.Zero;
        } else {
            ltvBps = SafeMath.div(
                SafeMath.mul(newBorrowVal, BASIS_POINTS),
                collatValue,
            );
        }

        const riskStatusAfter: u256 = this._classifyRisk(hfAfter, true, this._liquidationThreshold(caller));

        // ── INTERACTIONS ─────────────────────────────────────────────────────
        if (token === POOL_MOTO || token === POOL_PILL) {
            this._pushOP20(token, caller, amount); // user receives full amount
        }
        // BTC: backend sends BTC from protocol reserve to user.

        const writer = new BytesWriter(32 * 7);
        writer.writeU256(collatValue);
        writer.writeU256(newBorrowVal);
        writer.writeU256(ltvBps);
        writer.writeU256(hfAfter);
        writer.writeU256(riskStatusAfter);
        writer.writeU256(discountBps); // 0/100/300/500 — applied to this borrow
        writer.writeU256(tier);        // 0/1/2/3 — caller's loyalty tier
        return writer;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  REPAY ENGINE
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * repay(token: uint8, amount: uint256) → (actualRepaid, remainingDebt)
     *
     * Repay borrowed debt in a specific pool.
     *
     * ┌─────────────────────────────────────────────────────────────────────┐
     * │  Compounded debt = principal × currentIndex / indexAtBorrow        │
     * │  If amount > compounded debt, only exact debt is taken.             │
     * │                                                                     │
     * │  After repay:                                                       │
     * │    userDebt[user][token] ↓ actualRepaid                            │
     * │    pool totalBorrowed    ↓ actualRepaid                            │
     * │    pool availLiquidity   ↑ actualRepaid                            │
     * └─────────────────────────────────────────────────────────────────────┘
     *
     * Returns:
     *   actualRepaid  — tokens actually taken from caller (≤ amount, ≤ debt)
     *   remainingDebt — compounded debt remaining in this pool after repayment
     *
     * Reverts if:
     *   - Protocol paused
     *   - amount == 0
     *   - Caller has no debt in this pool
     */
    @method(
        { name: 'token',  type: ABIDataTypes.UINT8   },
        { name: 'amount', type: ABIDataTypes.UINT256  }
    )
    @returns(
        { name: 'actualRepaid',  type: ABIDataTypes.UINT256 },
        { name: 'remainingDebt', type: ABIDataTypes.UINT256 },
        { name: 'healthFactor',  type: ABIDataTypes.UINT256 },
        { name: 'riskStatus',    type: ABIDataTypes.UINT256 }
    )
    private _repay(calldata: Calldata): BytesWriter {
        // ── CHECKS ──────────────────────────────────────────────────────────
        this._requireNotPaused();
        const token: u8       = calldata.readU8();
        const amount: u256    = calldata.readU256();
        const caller: Address = Blockchain.tx.sender;

        this._requireValidPool(token);
        if (u256.eq(amount, u256.Zero)) throw new Revert('LEND: zero repay amount');

        // Accrue to current block before computing exact debt
        this._accrueInterest(token);

        const repayPrincipal: u256 = this._borrowMap(token).get(caller);
        const repayIdxSnap: u256   = this._borrowIdxMap(token).get(caller);
        if (u256.eq(repayPrincipal, u256.Zero)) throw new Revert('LEND: no debt in this pool');

        // Compute exact compounded debt: principal × currentIndex / indexAtBorrow
        const currentIndex: u256   = this._borrowIndex(token).value;
        const compoundedDebt: u256 = SafeMath.div(
            SafeMath.mul(repayPrincipal, currentIndex),
            repayIdxSnap,
        );

        // ── COMPUTE REPAY AMOUNTS ────────────────────────────────────────────
        let actualRepaid: u256;
        let remainingDebt: u256;
        if (u256.ge(amount, compoundedDebt)) {
            // Full repayment — clear position
            actualRepaid  = compoundedDebt;
            remainingDebt = u256.Zero;
        } else {
            // Partial repayment — remaining debt stored as new compounded principal
            actualRepaid  = amount;
            remainingDebt = SafeMath.sub(compoundedDebt, amount);
        }

        // ── EFFECTS ─────────────────────────────────────────────────────────
        // Store remaining principal at current index (re-normalised)
        this._borrowMap(token).set(caller, remainingDebt);
        this._borrowIdxMap(token).set(caller, u256.eq(remainingDebt, u256.Zero) ? u256.Zero : currentIndex);

        // Decrease pool totalBorrowed (clamped to avoid underflow on rounding)
        const totalBorrowedStore: StoredU256 = this._totalBorrowed(token);
        const safeReduce: u256 = u256.lt(actualRepaid, totalBorrowedStore.value)
            ? actualRepaid
            : totalBorrowedStore.value;
        totalBorrowedStore.set(SafeMath.sub(totalBorrowedStore.value, safeReduce));
        // availableLiquidity implicitly increases because totalBorrowed ↓ while totalDeposits unchanged

        // ── INTERACTIONS ─────────────────────────────────────────────────────
        if (token === POOL_MOTO || token === POOL_PILL) {
            this._pullOP20(token, caller, actualRepaid);
        }
        // BTC repayment: backend verifies the BTC L1 transaction to protocol reserve.

        // Post-repay risk status — recomputed so frontend updates without an extra RPC call
        const hfAfterRepay: u256       = this._computeHF(caller);
        const hasBorrowsAfter: boolean = this._hasBorrows(caller);
        const riskAfterRepay: u256     = this._classifyRisk(hfAfterRepay, hasBorrowsAfter, this._liquidationThreshold(caller));

        const writer = new BytesWriter(32 * 4);
        writer.writeU256(actualRepaid);
        writer.writeU256(remainingDebt);
        writer.writeU256(hfAfterRepay);
        writer.writeU256(riskAfterRepay); // 0=none 1=safe 2=warning
        return writer;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  BORROW POSITION VIEWS
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * getBorrowPosition(user: address, token: uint8)
     *
     * Returns the complete borrow position for one pool. Gives the frontend
     * everything needed to render a borrow dashboard row for a single token.
     *
     * Returns (9 uint256 values):
     * ┌──────────────────────┬─────────────────────────────────────────────┐
     * │ Field                │ Description                                 │
     * ├──────────────────────┼─────────────────────────────────────────────┤
     * │ userDebt             │ userDebt[user][token] — compounded debt     │
     * │                      │ (principal × currentIndex / indexAtBorrow)  │
     * │ userCollateral       │ userCollateral[user] — total collateral in  │
     * │                      │ satoshis (all enabled pools combined)       │
     * │ debtValueInSats      │ userDebt for this pool in satoshis          │
     * │ totalBorrowValueSats │ all-pool combined borrow value in satoshis  │
     * │ loanToValueRatio     │ (totalBorrowValueSats/collateral)×10000 bp  │
     * │                      │ Max 6 666 bp (66.67%) at 150% collateral    │
     * │ interestRate         │ pool's current annual APR in basis points   │
     * │ healthFactor         │ overall HF in RAY precision (1.2×10^18)     │
     * │ maxBorrowable        │ additional tokens borrowable from this pool │
     * │ isLiquidatable       │ 1 if HF < 1.2×RAY, 0 otherwise             │
     * └──────────────────────┴─────────────────────────────────────────────┘
     */
    @method(
        { name: 'user',  type: ABIDataTypes.ADDRESS },
        { name: 'token', type: ABIDataTypes.UINT8   }
    )
    @returns(
        { name: 'userDebt',             type: ABIDataTypes.UINT256 },
        { name: 'userCollateral',       type: ABIDataTypes.UINT256 },
        { name: 'debtValueInSats',      type: ABIDataTypes.UINT256 },
        { name: 'totalBorrowValueSats', type: ABIDataTypes.UINT256 },
        { name: 'loanToValueRatio',     type: ABIDataTypes.UINT256 },
        { name: 'interestRate',         type: ABIDataTypes.UINT256 },
        { name: 'healthFactor',         type: ABIDataTypes.UINT256 },
        { name: 'maxBorrowable',        type: ABIDataTypes.UINT256 },
        { name: 'isLiquidatable',       type: ABIDataTypes.UINT256 }
    )
    private _getBorrowPosition(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();
        const token: u8     = calldata.readU8();
        this._requireValidPool(token);

        const pos: BorrowPosition = this._computeBorrowPosition(user, token);

        const writer = new BytesWriter(32 * 9);
        writer.writeU256(pos.userDebt);
        writer.writeU256(pos.userCollateral);
        writer.writeU256(pos.debtValueInSats);
        writer.writeU256(pos.totalBorrowValueSats);
        writer.writeU256(pos.loanToValueRatio);
        writer.writeU256(pos.interestRate);
        writer.writeU256(pos.healthFactor);
        writer.writeU256(pos.maxBorrowable);
        writer.writeU256(pos.isLiquidatable);
        return writer;
    }

    /**
     * getAllBorrowPositions(user: address)
     *
     * Returns borrow positions for all three pools in one call.
     * Returns 27 uint256 values (9 per pool × 3 pools):
     *   [0..8]   BTC  borrow position
     *   [9..17]  MOTO borrow position
     *   [18..26] PILL borrow position
     */
    @method({ name: 'user', type: ABIDataTypes.ADDRESS })
    @returns(
        // BTC
        { name: 'btcDebt',              type: ABIDataTypes.UINT256 },
        { name: 'btcCollateral',        type: ABIDataTypes.UINT256 },
        { name: 'btcDebtValueSats',     type: ABIDataTypes.UINT256 },
        { name: 'btcTotalBorrowSats',   type: ABIDataTypes.UINT256 },
        { name: 'btcLTV',               type: ABIDataTypes.UINT256 },
        { name: 'btcInterestRate',      type: ABIDataTypes.UINT256 },
        { name: 'btcHealthFactor',      type: ABIDataTypes.UINT256 },
        { name: 'btcMaxBorrowable',     type: ABIDataTypes.UINT256 },
        { name: 'btcIsLiquidatable',    type: ABIDataTypes.UINT256 },
        // MOTO
        { name: 'motoDebt',             type: ABIDataTypes.UINT256 },
        { name: 'motoCollateral',       type: ABIDataTypes.UINT256 },
        { name: 'motoDebtValueSats',    type: ABIDataTypes.UINT256 },
        { name: 'motoTotalBorrowSats',  type: ABIDataTypes.UINT256 },
        { name: 'motoLTV',              type: ABIDataTypes.UINT256 },
        { name: 'motoInterestRate',     type: ABIDataTypes.UINT256 },
        { name: 'motoHealthFactor',     type: ABIDataTypes.UINT256 },
        { name: 'motoMaxBorrowable',    type: ABIDataTypes.UINT256 },
        { name: 'motoIsLiquidatable',   type: ABIDataTypes.UINT256 },
        // PILL
        { name: 'pillDebt',             type: ABIDataTypes.UINT256 },
        { name: 'pillCollateral',       type: ABIDataTypes.UINT256 },
        { name: 'pillDebtValueSats',    type: ABIDataTypes.UINT256 },
        { name: 'pillTotalBorrowSats',  type: ABIDataTypes.UINT256 },
        { name: 'pillLTV',              type: ABIDataTypes.UINT256 },
        { name: 'pillInterestRate',     type: ABIDataTypes.UINT256 },
        { name: 'pillHealthFactor',     type: ABIDataTypes.UINT256 },
        { name: 'pillMaxBorrowable',    type: ABIDataTypes.UINT256 },
        { name: 'pillIsLiquidatable',   type: ABIDataTypes.UINT256 }
    )
    private _getAllBorrowPositions(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();

        const btc:  BorrowPosition = this._computeBorrowPosition(user, POOL_BTC);
        const moto: BorrowPosition = this._computeBorrowPosition(user, POOL_MOTO);
        const pill: BorrowPosition = this._computeBorrowPosition(user, POOL_PILL);

        const writer = new BytesWriter(32 * 27);

        // BTC
        writer.writeU256(btc.userDebt);
        writer.writeU256(btc.userCollateral);
        writer.writeU256(btc.debtValueInSats);
        writer.writeU256(btc.totalBorrowValueSats);
        writer.writeU256(btc.loanToValueRatio);
        writer.writeU256(btc.interestRate);
        writer.writeU256(btc.healthFactor);
        writer.writeU256(btc.maxBorrowable);
        writer.writeU256(btc.isLiquidatable);

        // MOTO
        writer.writeU256(moto.userDebt);
        writer.writeU256(moto.userCollateral);
        writer.writeU256(moto.debtValueInSats);
        writer.writeU256(moto.totalBorrowValueSats);
        writer.writeU256(moto.loanToValueRatio);
        writer.writeU256(moto.interestRate);
        writer.writeU256(moto.healthFactor);
        writer.writeU256(moto.maxBorrowable);
        writer.writeU256(moto.isLiquidatable);

        // PILL
        writer.writeU256(pill.userDebt);
        writer.writeU256(pill.userCollateral);
        writer.writeU256(pill.debtValueInSats);
        writer.writeU256(pill.totalBorrowValueSats);
        writer.writeU256(pill.loanToValueRatio);
        writer.writeU256(pill.interestRate);
        writer.writeU256(pill.healthFactor);
        writer.writeU256(pill.maxBorrowable);
        writer.writeU256(pill.isLiquidatable);

        return writer;
    }

    /**
     * previewBorrow(token: uint8, amount: uint256)
     *
     * Simulate a borrow without executing it. Lets the frontend show live
     * previews of health factor and LTV as the user types an amount.
     *
     * Returns (8 uint256 values):
     * ┌─────────────────────┬──────────────────────────────────────────────┐
     * │ isAllowed           │ 1 if borrow would succeed, 0 if it reverts   │
     * │ rejectReason        │ 0 = ok                                       │
     * │                     │ 1 = no valid collateral for this token       │
     * │                     │ 2 = would exceed 150% collateral requirement │
     * │                     │ 3 = pool has insufficient liquidity          │
     * │ collateralValue     │ caller's current total collateral in sats    │
     * │ currentBorrowValue  │ caller's current total borrow value in sats  │
     * │ newBorrowValue      │ projected borrow value after this borrow     │
     * │ newHealthFactor     │ projected HF in RAY after this borrow        │
     * │ newLTV              │ projected LTV in basis points after borrow   │
     * │ maxBorrowable       │ max amount caller can borrow from this pool  │
     * └─────────────────────┴──────────────────────────────────────────────┘
     */
    @method(
        { name: 'token',  type: ABIDataTypes.UINT8   },
        { name: 'amount', type: ABIDataTypes.UINT256  }
    )
    @returns(
        { name: 'isAllowed',          type: ABIDataTypes.UINT256 },
        { name: 'rejectReason',       type: ABIDataTypes.UINT256 },
        { name: 'collateralValue',    type: ABIDataTypes.UINT256 },
        { name: 'currentBorrowValue', type: ABIDataTypes.UINT256 },
        { name: 'newBorrowValue',     type: ABIDataTypes.UINT256 },
        { name: 'newHealthFactor',    type: ABIDataTypes.UINT256 },
        { name: 'newLTV',             type: ABIDataTypes.UINT256 },
        { name: 'maxBorrowable',      type: ABIDataTypes.UINT256 }
    )
    private _previewBorrow(calldata: Calldata): BytesWriter {
        const token: u8    = calldata.readU8();
        const amount: u256 = calldata.readU256();
        const caller: Address = Blockchain.tx.sender;

        const writer = new BytesWriter(32 * 8);

        // Gather current state (read-only; no accrual to keep this a pure view)
        const collatValue: u256     = this._totalCollateralValue(caller);
        const currentDebtVal: u256  = this._totalBorrowValue(caller);

        // ── Check 1: valid pool ──
        if (token !== POOL_BTC && token !== POOL_MOTO && token !== POOL_PILL) {
            this._writePreviewResult(writer, u256.Zero, u256.fromU32(4),
                collatValue, currentDebtVal, currentDebtVal, u256.Max, u256.Zero, u256.Zero);
            return writer;
        }

        // ── Compute max borrowable ──
        // maxDebtValue = collateralValue × BASIS_POINTS / COLLATERAL_RATIO_BPS
        // remainingCapacity = maxDebtValue − currentDebtValue
        let maxBorrowable: u256;
        if (u256.eq(collatValue, u256.Zero)) {
            maxBorrowable = u256.Zero;
        } else {
            const maxDebtValue: u256 = SafeMath.div(
                SafeMath.mul(collatValue, BASIS_POINTS),
                COLLATERAL_RATIO_BPS,
            );
            if (u256.gt(currentDebtVal, maxDebtValue)) {
                maxBorrowable = u256.Zero;
            } else {
                const remainingCapacitySats: u256 = SafeMath.sub(maxDebtValue, currentDebtVal);
                const tokenPrice: u256 = this._price(token);
                if (u256.eq(tokenPrice, u256.Zero)) {
                    maxBorrowable = u256.Zero;
                } else {
                    // remainingCapacity is in satoshis; convert to token units
                    maxBorrowable = SafeMath.div(
                        SafeMath.mul(remainingCapacitySats, SAT_SCALE),
                        tokenPrice,
                    );
                    // Also cap by pool's available liquidity
                    const poolAvail: u256 = this._availableLiquidity(token);
                    if (u256.lt(poolAvail, maxBorrowable)) {
                        maxBorrowable = poolAvail;
                    }
                }
            }
        }

        // ── Check 2: valid collateral type ──
        let hasValidCollateral: boolean = false;
        if (token === POOL_BTC) {
            hasValidCollateral =
                (u256.eq(this.userMotoCollateral.get(caller), u256.One) &&
                 !u256.eq(this._userTokenBalance(caller, POOL_MOTO), u256.Zero)) ||
                (u256.eq(this.userPillCollateral.get(caller), u256.One) &&
                 !u256.eq(this._userTokenBalance(caller, POOL_PILL), u256.Zero));
        } else {
            hasValidCollateral =
                u256.eq(this.userBtcCollateral.get(caller), u256.One) &&
                !u256.eq(this._userTokenBalance(caller, POOL_BTC), u256.Zero);
        }
        if (!hasValidCollateral) {
            this._writePreviewResult(writer, u256.Zero, u256.One,
                collatValue, currentDebtVal, currentDebtVal, u256.Max, u256.Zero, maxBorrowable);
            return writer;
        }

        // ── Check 3: pool has liquidity ──
        const avail: u256 = this._availableLiquidity(token);
        if (u256.lt(avail, amount)) {
            this._writePreviewResult(writer, u256.Zero, u256.fromU32(3),
                collatValue, currentDebtVal, currentDebtVal, u256.Max, u256.Zero, maxBorrowable);
            return writer;
        }

        // ── Check 4: collateral ratio / HF simulation ──
        const addedDebtSats: u256 = SafeMath.div(
            SafeMath.mul(amount, this._price(token)),
            SAT_SCALE,
        );
        const newDebtVal: u256 = SafeMath.add(currentDebtVal, addedDebtSats);

        let newHF: u256;
        if (u256.eq(newDebtVal, u256.Zero)) {
            newHF = u256.Max;
        } else {
            newHF = SafeMath.div(
                SafeMath.mul(SafeMath.mul(collatValue, LIQUIDATION_THRESHOLD_BPS), RAY),
                SafeMath.mul(newDebtVal, BASIS_POINTS),
            );
        }

        let newLTV: u256;
        if (u256.eq(collatValue, u256.Zero)) {
            newLTV = u256.Zero;
        } else {
            newLTV = SafeMath.div(SafeMath.mul(newDebtVal, BASIS_POINTS), collatValue);
        }

        if (u256.lt(newHF, this._liquidationThreshold(caller))) {
            this._writePreviewResult(writer, u256.Zero, u256.fromU32(2),
                collatValue, currentDebtVal, newDebtVal, newHF, newLTV, maxBorrowable);
            return writer;
        }

        // All checks pass
        this._writePreviewResult(writer, u256.One, u256.Zero,
            collatValue, currentDebtVal, newDebtVal, newHF, newLTV, maxBorrowable);
        return writer;
    }

    /** Helper to write the 8-field preview result without repetition. */
    private _writePreviewResult(
        writer: BytesWriter,
        isAllowed: u256,
        rejectReason: u256,
        collateralValue: u256,
        currentBorrowValue: u256,
        newBorrowValue: u256,
        newHealthFactor: u256,
        newLTV: u256,
        maxBorrowable: u256,
    ): void {
        writer.writeU256(isAllowed);
        writer.writeU256(rejectReason);
        writer.writeU256(collateralValue);
        writer.writeU256(currentBorrowValue);
        writer.writeU256(newBorrowValue);
        writer.writeU256(newHealthFactor);
        writer.writeU256(newLTV);
        writer.writeU256(maxBorrowable);
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  LIQUIDATION ENGINE
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * liquidate(borrower, collateralToken, borrowToken, debtAmount)
     *
     * Core liquidation action. Any caller can liquidate a vault whose
     * health factor has dropped below 1.2 × RAY.
     *
     * ┌─────────────────────────────────────────────────────────────────────┐
     * │  PROCESS                                                            │
     * │  1. Verify HF < 1.2 (position is liquidatable)                     │
     * │  2. Cap debtAmount to 50% of the borrower's compounded debt        │
     * │  3. Compute collateralSeized = debtValue/collatPrice × 1.05 (105%) │
     * │  4. Burn borrower's LP shares for collateralSeized token amount     │
     * │  5. Reduce borrower's debt by actualDebtRepaid                     │
     * │  6. Update pool totalBorrowed (liquidity restored)                  │
     * │  7. Pull debt tokens from liquidator (MOTO/PILL) / BTC via backend │
     * │  8. Push collateral tokens to liquidator (MOTO/PILL) / BTC backend │
     * └─────────────────────────────────────────────────────────────────────┘
     *
     * Returns 5 values:
     *   collateralSeized  — total collateral tokens sent to liquidator
     *   debtRepaid        — actual debt tokens taken from liquidator
     *   liquidationBonus  — bonus tokens within collateralSeized (5%)
     *   borrowerHFAfter   — borrower's health factor after liquidation (RAY)
     *   borrowerRiskAfter — borrower's risk tier after (1=safe 2=warning 3=risk)
     *
     * Reverts if:
     *   - Protocol paused
     *   - debtAmount == 0
     *   - Invalid pool IDs
     *   - Borrower's HF ≥ 1.2 (position is healthy)
     *   - Borrower has no debt in the specified borrow pool
     *   - Borrower has insufficient collateral balance to cover seizure
     */
    @method(
        { name: 'borrower',        type: ABIDataTypes.ADDRESS },
        { name: 'collateralToken', type: ABIDataTypes.UINT8   },
        { name: 'borrowToken',     type: ABIDataTypes.UINT8   },
        { name: 'debtAmount',      type: ABIDataTypes.UINT256  }
    )
    @returns(
        { name: 'collateralSeized',  type: ABIDataTypes.UINT256 },
        { name: 'debtRepaid',        type: ABIDataTypes.UINT256 },
        { name: 'liquidationBonus',  type: ABIDataTypes.UINT256 },
        { name: 'borrowerHFAfter',   type: ABIDataTypes.UINT256 },
        { name: 'borrowerRiskAfter', type: ABIDataTypes.UINT256 }
    )
    private _liquidate(calldata: Calldata): BytesWriter {
        this._requireNotPaused();
        const borrower: Address   = calldata.readAddress();
        const collatToken: u8     = calldata.readU8();
        const borrowToken: u8     = calldata.readU8();
        const debtAmount: u256    = calldata.readU256();
        const liquidator: Address = Blockchain.tx.sender;

        if (u256.eq(debtAmount, u256.Zero)) throw new Revert('LEND: zero liquidation amount');
        this._requireValidPool(collatToken);
        this._requireValidPool(borrowToken);

        // Accrue both pools so indexes and balances are current
        this._accrueInterest(collatToken);
        this._accrueInterest(borrowToken);

        // ── COMPUTE (pure, no state writes) ─────────────────────────────────
        const result: LiquidationResult =
            this._computeLiquidationResult(borrower, collatToken, borrowToken, debtAmount);

        if (u256.eq(result.isAllowed, u256.Zero)) {
            if (u256.eq(result.rejectReason, u256.One))
                throw new Revert('LEND: borrower position is healthy');
            if (u256.eq(result.rejectReason, u256.fromU32(2)))
                throw new Revert('LEND: borrower has no debt in this pool');
            throw new Revert('LEND: insufficient borrower collateral for seizure');
        }

        // ── EFFECTS — seize collateral (burn borrower LP shares) ─────────────
        const collatTotalShares: StoredU256   = this._totalShares(collatToken);
        const collatTotalDeposits: StoredU256 = this._totalDeposits(collatToken);

        // shares to burn = seized tokens × totalShares / totalDeposits
        const sharesToBurn: u256 = SafeMath.div(
            SafeMath.mul(result.collateralSeized, collatTotalShares.value),
            collatTotalDeposits.value,
        );
        const borrowerSharesCurrent: u256 = this._sharesMap(collatToken).get(borrower);
        const safeBurn: u256 = u256.lt(sharesToBurn, borrowerSharesCurrent)
            ? sharesToBurn : borrowerSharesCurrent;
        const borrowerSharesAfter: u256 = SafeMath.sub(borrowerSharesCurrent, safeBurn);
        this._sharesMap(collatToken).set(borrower, borrowerSharesAfter);
        collatTotalShares.set(SafeMath.sub(collatTotalShares.value, safeBurn));
        collatTotalDeposits.set(SafeMath.sub(collatTotalDeposits.value, result.collateralSeized));

        // Clear collateral flag if pool position fully closed
        if (u256.eq(borrowerSharesAfter, u256.Zero)) {
            this._collateralMap(collatToken).set(borrower, u256.Zero);
            this._depositBlockMap(collatToken).set(borrower, u256.Zero);
        }

        // Reduce net deposit principal tracker (clamped to 0)
        const borrowerNetDepCurrent: u256 = this._netDepositMap(collatToken).get(borrower);
        if (u256.gt(borrowerNetDepCurrent, result.collateralSeized)) {
            this._netDepositMap(collatToken).set(borrower, SafeMath.sub(borrowerNetDepCurrent, result.collateralSeized));
        } else {
            this._netDepositMap(collatToken).set(borrower, u256.Zero);
        }

        // ── EFFECTS — reduce borrower debt ────────────────────────────────────
        const liqPrincipal: u256 = this._borrowMap(borrowToken).get(borrower);
        const liqIdxSnap: u256   = this._borrowIdxMap(borrowToken).get(borrower);
        const currentIdx: u256   = this._borrowIndex(borrowToken).value;
        const compoundedDebt: u256 = SafeMath.div(
            SafeMath.mul(liqPrincipal, currentIdx), liqIdxSnap,
        );
        const newDebt: u256 = u256.gt(compoundedDebt, result.actualDebtRepaid)
            ? SafeMath.sub(compoundedDebt, result.actualDebtRepaid)
            : u256.Zero;
        this._borrowMap(borrowToken).set(borrower, newDebt);
        this._borrowIdxMap(borrowToken).set(borrower, u256.eq(newDebt, u256.Zero) ? u256.Zero : currentIdx);

        // ── EFFECTS — restore pool liquidity (totalBorrowed ↓) ───────────────
        const poolBorrowed: StoredU256 = this._totalBorrowed(borrowToken);
        const safeReduce: u256 = u256.lt(result.actualDebtRepaid, poolBorrowed.value)
            ? result.actualDebtRepaid : poolBorrowed.value;
        poolBorrowed.set(SafeMath.sub(poolBorrowed.value, safeReduce));

        // ── INTERACTIONS ─────────────────────────────────────────────────────
        // Pull debt repayment from liquidator (MOTO/PILL); BTC via backend
        if (borrowToken === POOL_MOTO || borrowToken === POOL_PILL) {
            this._pullOP20(borrowToken, liquidator, result.actualDebtRepaid);
        }
        // Push seized collateral to liquidator (MOTO/PILL); BTC via backend
        if (collatToken === POOL_MOTO || collatToken === POOL_PILL) {
            this._pushOP20(collatToken, liquidator, result.collateralSeized);
        }

        const writer = new BytesWriter(32 * 5);
        writer.writeU256(result.collateralSeized);
        writer.writeU256(result.actualDebtRepaid);
        writer.writeU256(result.bonusAmount);
        writer.writeU256(result.hfAfter);
        writer.writeU256(result.riskAfter);
        return writer;
    }

    /**
     * getLiquidationInfo(borrower: address) → 14 uint256 values
     *
     * Full liquidation opportunity snapshot for a given borrower. Designed for
     * liquidator bots and frontend dashboards that need to evaluate whether a
     * vault is profitable to liquidate and how much they can seize.
     *
     * ┌──────────────────────────┬──────────────────────────────────────────┐
     * │ isLiquidatable           │ 1 if HF < 1.2 × RAY, else 0             │
     * │ healthFactor             │ current HF in RAY                       │
     * │ collateralValue          │ total collateral value (satoshis)        │
     * │ borrowValue              │ total debt value (satoshis)              │
     * │ btcDebt                  │ compounded BTC debt (token units)        │
     * │ motoDebt                 │ compounded MOTO debt                     │
     * │ pillDebt                 │ compounded PILL debt                     │
     * │ btcCollateral            │ BTC LP → redeemable token balance        │
     * │ motoCollateral           │ MOTO LP → redeemable token balance       │
     * │ pillCollateral           │ PILL LP → redeemable token balance       │
     * │ maxLiquidatableBtc       │ max BTC debt liquidatable (50% rule)     │
     * │ maxLiquidatableMoto      │ max MOTO debt liquidatable               │
     * │ maxLiquidatablePill      │ max PILL debt liquidatable               │
     * │ liquidationBonusBps      │ protocol bonus constant: 500 (5%)        │
     * └──────────────────────────┴──────────────────────────────────────────┘
     */
    @method({ name: 'borrower', type: ABIDataTypes.ADDRESS })
    @returns(
        { name: 'isLiquidatable',      type: ABIDataTypes.UINT256 },
        { name: 'healthFactor',        type: ABIDataTypes.UINT256 },
        { name: 'collateralValue',     type: ABIDataTypes.UINT256 },
        { name: 'borrowValue',         type: ABIDataTypes.UINT256 },
        { name: 'btcDebt',             type: ABIDataTypes.UINT256 },
        { name: 'motoDebt',            type: ABIDataTypes.UINT256 },
        { name: 'pillDebt',            type: ABIDataTypes.UINT256 },
        { name: 'btcCollateral',       type: ABIDataTypes.UINT256 },
        { name: 'motoCollateral',      type: ABIDataTypes.UINT256 },
        { name: 'pillCollateral',      type: ABIDataTypes.UINT256 },
        { name: 'maxLiquidatableBtc',  type: ABIDataTypes.UINT256 },
        { name: 'maxLiquidatableMoto', type: ABIDataTypes.UINT256 },
        { name: 'maxLiquidatablePill', type: ABIDataTypes.UINT256 },
        { name: 'liquidationBonusBps', type: ABIDataTypes.UINT256 }
    )
    private _getLiquidationInfo(calldata: Calldata): BytesWriter {
        const borrower: Address = calldata.readAddress();

        const hf: u256          = this._computeHF(borrower);
        const collatValue: u256 = this._totalCollateralValue(borrower);
        const borrowValue: u256 = this._totalBorrowValue(borrower);

        const isLiquidatable: u256 = (
            !u256.eq(borrowValue, u256.Zero) &&
            u256.lt(hf, this._liquidationThreshold(borrower))
        ) ? u256.One : u256.Zero;

        // Per-pool compounded debt
        const btcDebt:  u256 = this._compoundedDebt(borrower, POOL_BTC);
        const motoDebt: u256 = this._compoundedDebt(borrower, POOL_MOTO);
        const pillDebt: u256 = this._compoundedDebt(borrower, POOL_PILL);

        // Per-pool collateral (redeemable LP share value)
        const btcCollat:  u256 = this._userTokenBalance(borrower, POOL_BTC);
        const motoCollat: u256 = this._userTokenBalance(borrower, POOL_MOTO);
        const pillCollat: u256 = this._userTokenBalance(borrower, POOL_PILL);

        // Max liquidatable per pool = 50% of compounded debt
        const maxLiqBtc:  u256 = SafeMath.div(SafeMath.mul(btcDebt,  MAX_LIQUIDATION_BPS), BASIS_POINTS);
        const maxLiqMoto: u256 = SafeMath.div(SafeMath.mul(motoDebt, MAX_LIQUIDATION_BPS), BASIS_POINTS);
        const maxLiqPill: u256 = SafeMath.div(SafeMath.mul(pillDebt, MAX_LIQUIDATION_BPS), BASIS_POINTS);

        const writer = new BytesWriter(32 * 14);
        writer.writeU256(isLiquidatable);
        writer.writeU256(hf);
        writer.writeU256(collatValue);
        writer.writeU256(borrowValue);
        writer.writeU256(btcDebt);
        writer.writeU256(motoDebt);
        writer.writeU256(pillDebt);
        writer.writeU256(btcCollat);
        writer.writeU256(motoCollat);
        writer.writeU256(pillCollat);
        writer.writeU256(maxLiqBtc);
        writer.writeU256(maxLiqMoto);
        writer.writeU256(maxLiqPill);
        writer.writeU256(LIQUIDATION_BONUS_BPS);
        return writer;
    }

    /**
     * previewLiquidation(borrower, collateralToken, borrowToken, debtAmount)
     *
     * Simulate a liquidation call and return the full outcome without writing
     * any state. Lets liquidator bots calculate exact profitability before
     * submitting the real transaction.
     *
     * Returns 8 values:
     * ┌──────────────────────┬──────────────────────────────────────────────┐
     * │ isAllowed            │ 1 = liquidation would succeed                │
     * │ rejectReason         │ 0=ok 1=healthy 2=no-debt 3=low-collateral    │
     * │ actualDebtRepaid     │ debt tokens taken (capped at 50%)            │
     * │ collatBase           │ collateral equiv of repaid debt              │
     * │ bonusAmount          │ 5% bonus tokens                             │
     * │ collateralSeized     │ collatBase + bonusAmount                     │
     * │ borrowerHFAfter      │ borrower's projected HF after (RAY)         │
     * │ borrowerRiskAfter    │ borrower's projected risk tier after         │
     * └──────────────────────┴──────────────────────────────────────────────┘
     */
    @method(
        { name: 'borrower',        type: ABIDataTypes.ADDRESS },
        { name: 'collateralToken', type: ABIDataTypes.UINT8   },
        { name: 'borrowToken',     type: ABIDataTypes.UINT8   },
        { name: 'debtAmount',      type: ABIDataTypes.UINT256  }
    )
    @returns(
        { name: 'isAllowed',         type: ABIDataTypes.UINT256 },
        { name: 'rejectReason',      type: ABIDataTypes.UINT256 },
        { name: 'actualDebtRepaid',  type: ABIDataTypes.UINT256 },
        { name: 'collatBase',        type: ABIDataTypes.UINT256 },
        { name: 'bonusAmount',       type: ABIDataTypes.UINT256 },
        { name: 'collateralSeized',  type: ABIDataTypes.UINT256 },
        { name: 'borrowerHFAfter',   type: ABIDataTypes.UINT256 },
        { name: 'borrowerRiskAfter', type: ABIDataTypes.UINT256 }
    )
    private _previewLiquidation(calldata: Calldata): BytesWriter {
        const borrower: Address = calldata.readAddress();
        const collatToken: u8   = calldata.readU8();
        const borrowToken: u8   = calldata.readU8();
        const debtAmount: u256  = calldata.readU256();

        const result: LiquidationResult =
            this._computeLiquidationResult(borrower, collatToken, borrowToken, debtAmount);

        const writer = new BytesWriter(32 * 8);
        writer.writeU256(result.isAllowed);
        writer.writeU256(result.rejectReason);
        writer.writeU256(result.actualDebtRepaid);
        writer.writeU256(result.collatBase);
        writer.writeU256(result.bonusAmount);
        writer.writeU256(result.collateralSeized);
        writer.writeU256(result.hfAfter);
        writer.writeU256(result.riskAfter);
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // BTC CREDIT (admin / trusted relayer)
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * creditBtcDeposit(user, amount) — admin only.
     * Called by backend after verifying BTC sent to the protocol's CSV-locked address.
     * Mints deposit shares for the user and updates userDeposits tracking.
     */
    @method(
        { name: 'user',   type: ABIDataTypes.ADDRESS  },
        { name: 'amount', type: ABIDataTypes.UINT256   }
    )
    @returns({ name: 'sharesReceived', type: ABIDataTypes.UINT256 })
    private _creditBtcDeposit(calldata: Calldata): BytesWriter {
        this._requireAdmin();
        const user: Address  = calldata.readAddress();
        const amount: u256   = calldata.readU256();
        if (u256.eq(amount, u256.Zero)) throw new Revert('LEND: zero amount');

        this._accrueInterest(POOL_BTC);

        const totalSharesStore: StoredU256   = this.btcTotalShares;
        const totalDepositsStore: StoredU256 = this.btcTotalDeposits;

        let sharesToMint: u256;
        if (u256.eq(totalSharesStore.value, u256.Zero) ||
            u256.eq(totalDepositsStore.value, u256.Zero)) {
            sharesToMint = amount;
        } else {
            sharesToMint = SafeMath.div(
                SafeMath.mul(amount, totalSharesStore.value),
                totalDepositsStore.value,
            );
        }
        if (u256.eq(sharesToMint, u256.Zero)) throw new Revert('LEND: zero shares');

        totalDepositsStore.set(SafeMath.add(totalDepositsStore.value, amount));
        totalSharesStore.set(SafeMath.add(totalSharesStore.value, sharesToMint));

        const currentUserShares: u256 = this.userBtcShares.get(user);
        this.userBtcShares.set(user, SafeMath.add(currentUserShares, sharesToMint));

        const currentNetDeposit: u256 = this.userBtcNetDeposit.get(user);
        this.userBtcNetDeposit.set(user, SafeMath.add(currentNetDeposit, amount));

        const currentDepositBlock: u256 = this.userBtcDepositBlock.get(user);
        if (u256.eq(currentDepositBlock, u256.Zero)) {
            this.userBtcDepositBlock.set(user, u256.fromU64(Blockchain.block.number));
        }

        const currentCollatFlag: u256 = this.userBtcCollateral.get(user);
        if (u256.eq(currentCollatFlag, u256.Zero)) this.userBtcCollateral.set(user, u256.One);

        const writer = new BytesWriter(32);
        writer.writeU256(sharesToMint);
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // USER VAULT VIEW
    // ─────────────────────────────────────────────────────────────────────────

    @method({ name: 'user', type: ABIDataTypes.ADDRESS })
    @returns(
        { name: 'collateralValue', type: ABIDataTypes.UINT256 },
        { name: 'borrowValue',     type: ABIDataTypes.UINT256 },
        { name: 'healthFactor',    type: ABIDataTypes.UINT256 }
    )
    private _getUserVault(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();
        const writer = new BytesWriter(32 * 3);
        writer.writeU256(this._totalCollateralValue(user));
        writer.writeU256(this._totalBorrowValue(user));
        writer.writeU256(this._computeHF(user));
        return writer;
    }

    @method({ name: 'user', type: ABIDataTypes.ADDRESS })
    @returns({ name: 'healthFactor', type: ABIDataTypes.UINT256 })
    private _getHealthFactor(calldata: Calldata): BytesWriter {
        const writer = new BytesWriter(32);
        writer.writeU256(this._computeHF(calldata.readAddress()));
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // ADMIN
    // ─────────────────────────────────────────────────────────────────────────

    @method(
        { name: 'motoAddress', type: ABIDataTypes.ADDRESS },
        { name: 'pillAddress', type: ABIDataTypes.ADDRESS }
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    private _setTokenAddresses(calldata: Calldata): BytesWriter {
        this._requireAdmin();
        this.motoAddress.value = calldata.readAddress().toHex();
        this.pillAddress.value = calldata.readAddress().toHex();
        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    @method(
        { name: 'token', type: ABIDataTypes.UINT8   },
        { name: 'price', type: ABIDataTypes.UINT256  }
    )
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    private _setPrice(calldata: Calldata): BytesWriter {
        this._requireAdmin();
        const token: u8   = calldata.readU8();
        const price: u256 = calldata.readU256();
        if (u256.eq(price, u256.Zero)) throw new Revert('LEND: zero price');
        this._requireValidPool(token);
        if (token === POOL_BTC)       this.priceBtc.set(price);
        else if (token === POOL_MOTO) this.priceMoto.set(price);
        else                          this.pricePill.set(price);
        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    @method({ name: 'paused', type: ABIDataTypes.BOOL })
    @returns({ name: 'success', type: ABIDataTypes.BOOL })
    private _setPaused(calldata: Calldata): BytesWriter {
        this._requireAdmin();
        this.paused.value = calldata.readBoolean();
        const writer = new BytesWriter(1);
        writer.writeBoolean(true);
        return writer;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  MOTO LOYALTY SYSTEM — PUBLIC VIEWS
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * getLoyaltyInfo(user: address) → 6 uint256 values
     *
     * Complete loyalty dashboard for a user.  Tells the frontend exactly which
     * tier the user is in, how much discount they receive on borrows, and how
     * much more MOTO they need to reach the next tier.
     *
     * ┌───────────────────────┬──────────────────────────────────────────────┐
     * │ motoBalance           │ Deposited MOTO LP share value (token units)  │
     * │ loyaltyTier           │ 0=none  1=Tier1  2=Tier2  3=Tier3 (max)     │
     * │ discountBps           │ Active borrow discount: 0/100/300/500 bp     │
     * │ nextTierThreshold     │ MOTO needed for next tier (0 if at Tier 3)   │
     * │ nextTierDiscountBps   │ Discount at next tier (0 if at Tier 3)       │
     * │ motoToNextTier        │ Additional MOTO needed for next tier         │
     * └───────────────────────┴──────────────────────────────────────────────┘
     *
     * Example:
     *   User has 350 MOTO deposited → Tier 1 (≥100), discount = 100 bp (1%)
     *   nextTierThreshold  = 500 MOTO (50_000_000_000 raw)
     *   nextTierDiscountBps= 300 (3%)
     *   motoToNextTier     = 150 MOTO (15_000_000_000 raw)
     */
    @method({ name: 'user', type: ABIDataTypes.ADDRESS })
    @returns(
        { name: 'motoBalance',         type: ABIDataTypes.UINT256 },
        { name: 'loyaltyTier',         type: ABIDataTypes.UINT256 },
        { name: 'discountBps',         type: ABIDataTypes.UINT256 },
        { name: 'nextTierThreshold',   type: ABIDataTypes.UINT256 },
        { name: 'nextTierDiscountBps', type: ABIDataTypes.UINT256 },
        { name: 'motoToNextTier',      type: ABIDataTypes.UINT256 }
    )
    private _getLoyaltyInfo(calldata: Calldata): BytesWriter {
        const user: Address    = calldata.readAddress();
        const motoBal: u256    = this._userTokenBalance(user, POOL_MOTO);
        const tier: u256       = this._loyaltyTier(user);
        const discount: u256   = this._loyaltyDiscountBps(user);

        // Next tier threshold and discount
        let nextThreshold: u256;
        let nextDiscount: u256;
        let motoNeeded: u256;

        if (u256.eq(tier, u256.Zero)) {
            // Not yet at Tier 1
            nextThreshold = LOYALTY_TIER1_MIN;
            nextDiscount  = LOYALTY_TIER1_DISCOUNT;
            motoNeeded    = u256.gt(LOYALTY_TIER1_MIN, motoBal)
                ? SafeMath.sub(LOYALTY_TIER1_MIN, motoBal) : u256.Zero;
        } else if (u256.eq(tier, u256.One)) {
            // At Tier 1 — next is Tier 2
            nextThreshold = LOYALTY_TIER2_MIN;
            nextDiscount  = LOYALTY_TIER2_DISCOUNT;
            motoNeeded    = u256.gt(LOYALTY_TIER2_MIN, motoBal)
                ? SafeMath.sub(LOYALTY_TIER2_MIN, motoBal) : u256.Zero;
        } else if (u256.eq(tier, u256.fromU32(2))) {
            // At Tier 2 — next is Tier 3
            nextThreshold = LOYALTY_TIER3_MIN;
            nextDiscount  = LOYALTY_TIER3_DISCOUNT;
            motoNeeded    = u256.gt(LOYALTY_TIER3_MIN, motoBal)
                ? SafeMath.sub(LOYALTY_TIER3_MIN, motoBal) : u256.Zero;
        } else {
            // Already at max tier (Tier 3)
            nextThreshold = u256.Zero;
            nextDiscount  = u256.Zero;
            motoNeeded    = u256.Zero;
        }

        const writer = new BytesWriter(32 * 6);
        writer.writeU256(motoBal);
        writer.writeU256(tier);
        writer.writeU256(discount);
        writer.writeU256(nextThreshold);
        writer.writeU256(nextDiscount);
        writer.writeU256(motoNeeded);
        return writer;
    }

    /**
     * getEffectiveBorrowRate(token: uint8) → 4 uint256 values
     *
     * Returns the caller's personalised borrow APR and APY for a given pool,
     * after applying any active MOTO loyalty discount.
     *
     * ┌─────────────────────┬────────────────────────────────────────────────┐
     * │ baseBorrowAPR       │ Pool borrow APR (no discount) — basis points   │
     * │ effectiveBorrowAPR  │ baseBorrowAPR − discount — basis points        │
     * │ effectiveBorrowAPY  │ Approximate compound APY of effectiveBorrowAPR │
     * │ discountBps         │ Active discount (0/100/300/500 bp)             │
     * └─────────────────────┴────────────────────────────────────────────────┘
     *
     * Example: pool at 80% util → baseBorrowAPR = 1200 bp (12%)
     *   Tier 3 user: effectiveBorrowAPR = 1200 − 500 = 700 bp (7%)
     *   effectiveBorrowAPY ≈ 700 + 700²/20000 = 724 bp (7.24%)
     */
    @method({ name: 'token', type: ABIDataTypes.UINT8 })
    @returns(
        { name: 'baseBorrowAPR',      type: ABIDataTypes.UINT256 },
        { name: 'effectiveBorrowAPR', type: ABIDataTypes.UINT256 },
        { name: 'effectiveBorrowAPY', type: ABIDataTypes.UINT256 },
        { name: 'discountBps',        type: ABIDataTypes.UINT256 }
    )
    private _getEffectiveBorrowRate(calldata: Calldata): BytesWriter {
        const token: u8       = calldata.readU8();
        const caller: Address = Blockchain.tx.sender;
        this._requireValidPool(token);

        const utilBps: u256    = this._utilizationRate(token);
        const baseAPR: u256    = this._interestRate(utilBps);
        const discount: u256   = this._loyaltyDiscountBps(caller);

        // Clamp: effective APR cannot go below the base rate floor (RATE_AT_ZERO = 200 bp)
        let effectiveAPR: u256;
        if (u256.ge(discount, baseAPR)) {
            effectiveAPR = u256.Zero; // full discount would go negative — clamp to 0
        } else {
            effectiveAPR = SafeMath.sub(baseAPR, discount);
        }

        const effectiveAPY: u256 = this._approximateAPY(effectiveAPR);

        const writer = new BytesWriter(32 * 4);
        writer.writeU256(baseAPR);
        writer.writeU256(effectiveAPR);
        writer.writeU256(effectiveAPY);
        writer.writeU256(discount);
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL — LOYALTY SYSTEM
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Return the caller's loyalty tier based on deposited MOTO balance.
     *
     *   0 = no tier   (< 100 MOTO deposited)
     *   1 = Tier 1    (≥ 100 MOTO)   → 1% borrow discount
     *   2 = Tier 2    (≥ 500 MOTO)   → 3% borrow discount
     *   3 = Tier 3    (≥ 1 000 MOTO) → 5% borrow discount
     *
     * "Deposited MOTO" = LP share value in the MOTO pool, computed via
     * _userTokenBalance(user, POOL_MOTO) = shares × totalDeposits / totalShares.
     * This automatically appreciates as pool interest accrues, incentivising
     * users to keep MOTO deposited for longer to maintain their tier.
     */
    private _loyaltyTier(user: Address): u256 {
        const motoBal: u256 = this._userTokenBalance(user, POOL_MOTO);
        if (u256.ge(motoBal, LOYALTY_TIER3_MIN)) return u256.fromU32(3);
        if (u256.ge(motoBal, LOYALTY_TIER2_MIN)) return u256.fromU32(2);
        if (u256.ge(motoBal, LOYALTY_TIER1_MIN)) return u256.One;
        return u256.Zero;
    }

    /**
     * Return the borrow discount in basis points for the caller's current tier.
     * Returns 0 if user has no tier (< 100 MOTO deposited).
     */
    private _loyaltyDiscountBps(user: Address): u256 {
        const tier: u256 = this._loyaltyTier(user);
        if (u256.eq(tier, u256.fromU32(3))) return LOYALTY_TIER3_DISCOUNT;
        if (u256.eq(tier, u256.fromU32(2))) return LOYALTY_TIER2_DISCOUNT;
        if (u256.eq(tier, u256.One))        return LOYALTY_TIER1_DISCOUNT;
        return u256.Zero;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  RISK ENGINE — PUBLIC VIEWS
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * getRiskStatus(user: address) → 9 uint256 values
     *
     * Full risk snapshot for a user's vault. Called automatically by the
     * protocol after every state-changing action (addCollateral, borrow,
     * repay, withdrawCollateral) — frontend reads this response to render
     * up-to-date risk indicators without an extra round-trip.
     *
     * ┌──────────────────────────┬──────────────────────────────────────────┐
     * │ collateralValue          │ All enabled collateral → satoshis        │
     * │ borrowValue              │ All compounded debt    → satoshis        │
     * │ healthFactor             │ RAY; ≥1.5=SAFE, ≥1.2=WARNING, <1.2=RISK │
     * │ loanToValueRatio         │ Basis points 0-10 000                    │
     * │ riskStatus               │ 0=none 1=safe 2=warning 3=liquidatable   │
     * │ safeMaxBorrow            │ Max additional debt (sats) s.t. HF > 1.5 │
     * │ warningMaxBorrow         │ Max additional debt (sats) s.t. HF > 1.2 │
     * │ liquidationCollatValue   │ Collateral value (sats) at which HF=1.2  │
     * │ distanceToLiquidationBps │ (HF−1.2) / 1.2 × 10000 ; 0 if already  │
     * └──────────────────────────┴──────────────────────────────────────────┘
     *
     * Safe borrow limit:
     *   HF = collateral × 8000 × RAY / (borrow × 10000) > 1.5×RAY
     *   → maxSafeBorrowValue = collateral × 8000 / 15000 (in sats)
     *
     * Warning borrow limit (= liquidation floor):
     *   HF > 1.2×RAY → maxWarningBorrowValue = collateral × 8000 / 12000 (sats)
     *
     * Liquidation collateral value:
     *   HF = 1.2 when collatValue = borrow × 12000 / 8000 = borrow × 1.5
     */
    @method({ name: 'user', type: ABIDataTypes.ADDRESS })
    @returns(
        { name: 'collateralValue',          type: ABIDataTypes.UINT256 },
        { name: 'borrowValue',              type: ABIDataTypes.UINT256 },
        { name: 'healthFactor',             type: ABIDataTypes.UINT256 },
        { name: 'loanToValueRatio',         type: ABIDataTypes.UINT256 },
        { name: 'riskStatus',               type: ABIDataTypes.UINT256 },
        { name: 'safeMaxBorrow',            type: ABIDataTypes.UINT256 },
        { name: 'warningMaxBorrow',         type: ABIDataTypes.UINT256 },
        { name: 'liquidationCollatValue',   type: ABIDataTypes.UINT256 },
        { name: 'distanceToLiquidationBps', type: ABIDataTypes.UINT256 }
    )
    private _getRiskStatus(calldata: Calldata): BytesWriter {
        const user: Address     = calldata.readAddress();
        const collatValue: u256 = this._totalCollateralValue(user);
        const borrowValue: u256 = this._totalBorrowValue(user);
        const hf: u256          = this._computeHF(user);

        // LTV
        let ltv: u256;
        if (u256.eq(collatValue, u256.Zero)) {
            ltv = u256.Zero;
        } else {
            ltv = SafeMath.div(SafeMath.mul(borrowValue, BASIS_POINTS), collatValue);
        }

        // Risk status classification
        const status: u256 = this._classifyRisk(hf, !u256.eq(borrowValue, u256.Zero), this._liquidationThreshold(user));

        // Safe max borrow: borrow < collateral × 8000 / 15000 (HF stays > 1.5)
        // Warning max borrow: borrow < collateral × 8000 / 12000 (HF stays > 1.2)
        let safeMaxBorrow: u256;
        let warningMaxBorrow: u256;
        if (u256.eq(collatValue, u256.Zero)) {
            safeMaxBorrow    = u256.Zero;
            warningMaxBorrow = u256.Zero;
        } else {
            // safeCapacity = collateral × 8000 / 15000
            const safeCapacity: u256 = SafeMath.div(
                SafeMath.mul(collatValue, LIQUIDATION_THRESHOLD_BPS),
                u256.fromU32(15000),
            );
            safeMaxBorrow = u256.gt(safeCapacity, borrowValue)
                ? SafeMath.sub(safeCapacity, borrowValue)
                : u256.Zero;

            // warningCapacity = collateral × 8000 / 12000
            const warningCapacity: u256 = SafeMath.div(
                SafeMath.mul(collatValue, LIQUIDATION_THRESHOLD_BPS),
                u256.fromU32(12000),
            );
            warningMaxBorrow = u256.gt(warningCapacity, borrowValue)
                ? SafeMath.sub(warningCapacity, borrowValue)
                : u256.Zero;
        }

        // User's effective liquidation threshold (1.1 or 1.2 × RAY depending on protection)
        const userLiqThresh: u256 = this._liquidationThreshold(user);

        // Liquidation collateral value = the collateral value at which HF = userLiqThresh
        //   HF = collat × 8000 × RAY / (borrow × 10000) = userLiqThresh
        //   → collat = borrow × userLiqThresh × 10000 / (8000 × RAY)
        //   Simplified: for 1.2×RAY → collat = borrow × 12000 / 8000
        //               for 1.1×RAY → collat = borrow × 11000 / 8000
        const liqNumeratorBps: u256 = this._hasProtection(user) ? u256.fromU32(11000) : u256.fromU32(12000);
        const liquidationCollatValue: u256 = u256.eq(borrowValue, u256.Zero)
            ? u256.Zero
            : SafeMath.div(
                SafeMath.mul(borrowValue, liqNumeratorBps),
                LIQUIDATION_THRESHOLD_BPS,
            );

        // Distance to liquidation = (HF − userLiqThresh) × 10000 / userLiqThresh  (basis points)
        let distanceBps: u256;
        if (u256.le(hf, userLiqThresh)) {
            distanceBps = u256.Zero;
        } else {
            distanceBps = SafeMath.div(
                SafeMath.mul(SafeMath.sub(hf, userLiqThresh), BASIS_POINTS),
                userLiqThresh,
            );
        }

        const writer = new BytesWriter(32 * 9);
        writer.writeU256(collatValue);
        writer.writeU256(borrowValue);
        writer.writeU256(hf);
        writer.writeU256(ltv);
        writer.writeU256(status);
        writer.writeU256(safeMaxBorrow);
        writer.writeU256(warningMaxBorrow);
        writer.writeU256(liquidationCollatValue);
        writer.writeU256(distanceBps);
        return writer;
    }

    /**
     * previewRisk(action: uint8, token: uint8, amount: uint256) → 8 uint256 values
     *
     * Simulate a vault action and return the projected risk outcome — without
     * executing any state change. Lets the frontend show live risk tier changes
     * as the user types an amount into the UI.
     *
     * Action codes:
     *   0 = addCollateral      → collateral value increases
     *   1 = borrow             → borrow value increases
     *   2 = repay              → borrow value decreases
     *   3 = withdrawCollateral → collateral value decreases
     *
     * Returns:
     * ┌───────────────────┬──────────────────────────────────────────────────┐
     * │ currentRiskStatus │ current tier (0/1/2/3) before action            │
     * │ newRiskStatus     │ projected tier after action                     │
     * │ currentHF         │ current health factor (RAY)                     │
     * │ newHF             │ projected HF after action (RAY)                 │
     * │ currentLTV        │ current LTV (basis points)                      │
     * │ newLTV            │ projected LTV after action (basis points)       │
     * │ currentBorrowValue│ current total debt (satoshis)                   │
     * │ newBorrowValue    │ projected total debt after action (satoshis)    │
     * └───────────────────┴──────────────────────────────────────────────────┘
     *
     * Note: action=1 (borrow) uses the same safe-borrow enforcement as the
     * real borrow() function. If the simulated borrow would drop HF below 1.2
     * the newRiskStatus will return RISK_LIQUIDATABLE (3) as a warning.
     */
    @method(
        { name: 'action', type: ABIDataTypes.UINT8   },
        { name: 'token',  type: ABIDataTypes.UINT8   },
        { name: 'amount', type: ABIDataTypes.UINT256  }
    )
    @returns(
        { name: 'currentRiskStatus',  type: ABIDataTypes.UINT256 },
        { name: 'newRiskStatus',      type: ABIDataTypes.UINT256 },
        { name: 'currentHF',          type: ABIDataTypes.UINT256 },
        { name: 'newHF',              type: ABIDataTypes.UINT256 },
        { name: 'currentLTV',         type: ABIDataTypes.UINT256 },
        { name: 'newLTV',             type: ABIDataTypes.UINT256 },
        { name: 'currentBorrowValue', type: ABIDataTypes.UINT256 },
        { name: 'newBorrowValue',     type: ABIDataTypes.UINT256 }
    )
    private _previewRisk2(calldata: Calldata): BytesWriter {
        const action: u8      = calldata.readU8();
        const token: u8       = calldata.readU8();
        const amount: u256    = calldata.readU256();
        const caller: Address = Blockchain.tx.sender;

        const collatValue: u256 = this._totalCollateralValue(caller);
        const borrowValue: u256 = this._totalBorrowValue(caller);
        const currentHF: u256   = this._computeHF(caller);

        // Current state
        let currentLTV: u256;
        if (u256.eq(collatValue, u256.Zero)) {
            currentLTV = u256.Zero;
        } else {
            currentLTV = SafeMath.div(SafeMath.mul(borrowValue, BASIS_POINTS), collatValue);
        }
        const hasBorrows: boolean = !u256.eq(borrowValue, u256.Zero);
        const liqThresholdCaller: u256 = this._liquidationThreshold(caller);
        const currentStatus: u256 = this._classifyRisk(currentHF, hasBorrows, liqThresholdCaller);

        // Simulate projected collateral and borrow values based on action
        const tokenPrice: u256 = this._price(token);
        // Convert the token amount to its satoshi value
        const amountInSats: u256 = u256.eq(tokenPrice, u256.Zero)
            ? u256.Zero
            : SafeMath.div(SafeMath.mul(amount, tokenPrice), SAT_SCALE);

        let newCollatValue: u256;
        let newBorrowValue: u256;

        if (action === ACTION_ADD_COLLATERAL) {
            newCollatValue = SafeMath.add(collatValue, amountInSats);
            newBorrowValue = borrowValue;
        } else if (action === ACTION_BORROW) {
            newCollatValue = collatValue;
            newBorrowValue = SafeMath.add(borrowValue, amountInSats);
        } else if (action === ACTION_REPAY) {
            newCollatValue = collatValue;
            newBorrowValue = u256.gt(borrowValue, amountInSats)
                ? SafeMath.sub(borrowValue, amountInSats)
                : u256.Zero;
        } else {
            // ACTION_WITHDRAW_COLLATERAL
            newCollatValue = u256.gt(collatValue, amountInSats)
                ? SafeMath.sub(collatValue, amountInSats)
                : u256.Zero;
            newBorrowValue = borrowValue;
        }

        // Compute projected HF
        let newHF: u256;
        if (u256.eq(newBorrowValue, u256.Zero)) {
            newHF = u256.Max;
        } else {
            newHF = SafeMath.div(
                SafeMath.mul(SafeMath.mul(newCollatValue, LIQUIDATION_THRESHOLD_BPS), RAY),
                SafeMath.mul(newBorrowValue, BASIS_POINTS),
            );
        }

        // Projected LTV
        let newLTV: u256;
        if (u256.eq(newCollatValue, u256.Zero)) {
            newLTV = u256.Zero;
        } else {
            newLTV = SafeMath.div(SafeMath.mul(newBorrowValue, BASIS_POINTS), newCollatValue);
        }

        const newHasBorrows: boolean = !u256.eq(newBorrowValue, u256.Zero);
        const newStatus: u256 = this._classifyRisk(newHF, newHasBorrows, liqThresholdCaller);

        const writer = new BytesWriter(32 * 8);
        writer.writeU256(currentStatus);
        writer.writeU256(newStatus);
        writer.writeU256(currentHF);
        writer.writeU256(newHF);
        writer.writeU256(currentLTV);
        writer.writeU256(newLTV);
        writer.writeU256(borrowValue);
        writer.writeU256(newBorrowValue);
        return writer;
    }

    /**
     * getRiskParameters() → 6 uint256 values (no arguments)
     *
     * Returns all protocol-level risk constants. Lets the frontend and
     * any third-party risk monitors read the live parameters without
     * hard-coding them.
     *
     * ┌───────────────────────┬─────────────────────────────────────────────┐
     * │ liquidationThreshold  │ 8 000 bp (80% of collateral counts toward HF│
     * │ hfLiquidationFloor    │ 1.2 × 10^18 — HF below this = liquidatable  │
     * │ hfSafeThreshold       │ 1.5 × 10^18 — HF above this = SAFE          │
     * │ liquidationBonus      │ 500 bp (5% bonus to liquidators)            │
     * │ maxLiquidationPct     │ 5 000 bp (50% of debt per liquidation call)  │
     * │ collateralRatioBps    │ 15 000 bp (150% minimum collateral ratio)    │
     * └───────────────────────┴─────────────────────────────────────────────┘
     */
    @returns(
        { name: 'liquidationThreshold', type: ABIDataTypes.UINT256 },
        { name: 'hfLiquidationFloor',   type: ABIDataTypes.UINT256 },
        { name: 'hfSafeThreshold',      type: ABIDataTypes.UINT256 },
        { name: 'liquidationBonus',     type: ABIDataTypes.UINT256 },
        { name: 'maxLiquidationPct',    type: ABIDataTypes.UINT256 },
        { name: 'collateralRatioBps',   type: ABIDataTypes.UINT256 }
    )
    private _getRiskParameters(_calldata: Calldata): BytesWriter {
        const writer = new BytesWriter(32 * 6);
        writer.writeU256(LIQUIDATION_THRESHOLD_BPS);
        writer.writeU256(HF_LIQUIDATION_THRESHOLD);
        writer.writeU256(HF_SAFE_THRESHOLD);
        writer.writeU256(LIQUIDATION_BONUS_BPS);
        writer.writeU256(MAX_LIQUIDATION_BPS);
        writer.writeU256(COLLATERAL_RATIO_BPS);
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL — RISK ENGINE CORE
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * _computeLiquidationResult — pure liquidation math, no state writes.
     *
     * Shared by _liquidate() and _previewLiquidation(). Performs all checks and
     * arithmetic, returning a LiquidationResult struct. The caller decides
     * whether to apply the state changes or just read the result.
     *
     * Computation steps:
     *   1. HF check — must be < 1.2 × RAY
     *   2. Debt lookup — borrower must have debt in borrowToken pool
     *   3. Collateral balance check — borrower must have enough to cover seizure
     *   4. Cap debtAmount to 50% (MAX_LIQUIDATION_BPS) of compounded debt
     *   5. collatBase = actualRepaid × borrowPrice / collatPrice
     *   6. bonus     = collatBase × 500 / 10000  (5%)
     *   7. seized    = collatBase + bonus
     *   8. Simulate post-liquidation HF and risk tier
     *
     * Reject codes (rejectReason):
     *   0 = ok    1 = healthy (HF ≥ 1.2)    2 = no debt    3 = low collateral
     */
    private _computeLiquidationResult(
        borrower: Address, collatToken: u8, borrowToken: u8, debtAmount: u256,
    ): LiquidationResult {
        const result = new LiquidationResult();

        // ── CHECK 1: position must be liquidatable ───────────────────────────
        // Use the borrower's effective threshold — PILL protection raises it to 1.1×RAY
        const hf: u256           = this._computeHF(borrower);
        const liqThresh: u256    = this._liquidationThreshold(borrower);
        if (u256.ge(hf, liqThresh)) {
            result.rejectReason = u256.One;
            return result;
        }

        // ── CHECK 2: borrower must have debt in this pool ────────────────────
        const liqCheckPrincipal: u256 = this._borrowMap(borrowToken).get(borrower);
        const liqCheckIdxSnap: u256   = this._borrowIdxMap(borrowToken).get(borrower);
        if (u256.eq(liqCheckPrincipal, u256.Zero) || u256.eq(liqCheckIdxSnap, u256.Zero)) {
            result.rejectReason = u256.fromU32(2);
            return result;
        }

        // Compounded debt at current index
        const currentIdx: u256     = this._borrowIndex(borrowToken).value;
        const compoundedDebt: u256 = SafeMath.div(
            SafeMath.mul(liqCheckPrincipal, currentIdx), liqCheckIdxSnap,
        );

        // Cap to 50% of outstanding debt
        const maxLiq: u256        = SafeMath.div(SafeMath.mul(compoundedDebt, MAX_LIQUIDATION_BPS), BASIS_POINTS);
        const actualRepaid: u256  = u256.lt(debtAmount, maxLiq) ? debtAmount : maxLiq;

        // ── COMPUTE SEIZURE ──────────────────────────────────────────────────
        const borrowPrice: u256 = this._price(borrowToken);
        const collatPrice: u256 = this._price(collatToken);

        // collatBase: collateral equivalent of repaid debt (in collateral token units)
        let collatBase: u256;
        if (u256.eq(collatPrice, u256.Zero)) {
            collatBase = u256.Zero;
        } else {
            collatBase = SafeMath.div(SafeMath.mul(actualRepaid, borrowPrice), collatPrice);
        }

        // bonus: 5% of collatBase
        const bonus: u256        = SafeMath.div(SafeMath.mul(collatBase, LIQUIDATION_BONUS_BPS), BASIS_POINTS);
        const collatSeized: u256 = SafeMath.add(collatBase, bonus);

        // ── CHECK 3: borrower has enough collateral balance ──────────────────
        const collatBal: u256 = this._userTokenBalance(borrower, collatToken);
        if (u256.lt(collatBal, collatSeized)) {
            result.rejectReason = u256.fromU32(3);
            return result;
        }

        // ── SIMULATE POST-LIQUIDATION HF ─────────────────────────────────────
        // After liquidation:
        //   - borrower's total collateral value decreases by (collatSeized × collatPrice / SAT_SCALE)
        //   - borrower's total borrow value decreases by (actualRepaid × borrowPrice / SAT_SCALE)
        const collatReduction: u256 = SafeMath.div(SafeMath.mul(collatSeized, collatPrice), SAT_SCALE);
        const debtReduction: u256   = SafeMath.div(SafeMath.mul(actualRepaid, borrowPrice), SAT_SCALE);

        const collatValueNow: u256  = this._totalCollateralValue(borrower);
        const borrowValueNow: u256  = this._totalBorrowValue(borrower);

        const collatAfter: u256 = u256.gt(collatValueNow, collatReduction)
            ? SafeMath.sub(collatValueNow, collatReduction) : u256.Zero;
        const borrowAfter: u256 = u256.gt(borrowValueNow, debtReduction)
            ? SafeMath.sub(borrowValueNow, debtReduction) : u256.Zero;

        let hfAfter: u256;
        if (u256.eq(borrowAfter, u256.Zero)) {
            hfAfter = u256.Max;
        } else {
            hfAfter = SafeMath.div(
                SafeMath.mul(SafeMath.mul(collatAfter, LIQUIDATION_THRESHOLD_BPS), RAY),
                SafeMath.mul(borrowAfter, BASIS_POINTS),
            );
        }

        result.isAllowed        = u256.One;
        result.rejectReason     = u256.Zero;
        result.actualDebtRepaid = actualRepaid;
        result.collatBase       = collatBase;
        result.bonusAmount      = bonus;
        result.collateralSeized = collatSeized;
        result.hfAfter          = hfAfter;
        result.riskAfter        = this._classifyRisk(hfAfter, !u256.eq(borrowAfter, u256.Zero), this._liquidationThreshold(borrower));
        return result;
    }

    /**
     * Classify a vault into one of four risk tiers based on current health factor.
     *
     * Called internally after every vault state change (deposit, withdraw,
     * borrow, repay) so the return value always reflects post-action risk.
     *
     *   0 = NONE        — vault has no debt; outside risk monitoring
     *   1 = SAFE        — HF > 1.5 × RAY; comfortable safety buffer
     *   2 = WARNING     — 1.2 ≤ HF ≤ 1.5 × RAY; approaching threshold
     *   3 = LIQUIDATABLE— HF < 1.2 × RAY; open to liquidators
     *
     * The WARNING tier signals that the position is approaching the
     * liquidation boundary and the user should add collateral or repay debt.
     * The protocol does NOT block actions that enter the WARNING zone — it
     * only blocks actions that would cross into LIQUIDATABLE (HF < 1.2).
     */
    /**
     * _classifyRisk — three-tier risk classification.
     *
     * liqThreshold is caller-supplied so PILL-protected users use
     * HF_PROTECTION_THRESHOLD (1.1×RAY) instead of HF_LIQUIDATION_THRESHOLD (1.2×RAY).
     * Pass `this._liquidationThreshold(user)` at every call site.
     */
    private _classifyRisk(hf: u256, hasBorrows: boolean, liqThreshold: u256): u256 {
        if (!hasBorrows)                    return RISK_NONE;
        if (u256.lt(hf, liqThreshold))      return RISK_LIQUIDATABLE;
        if (u256.le(hf, HF_SAFE_THRESHOLD)) return RISK_WARNING;
        return RISK_SAFE;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL — PILL PROTECTION HELPERS
    // ─────────────────────────────────────────────────────────────────────────

    /** Returns true when the user has staked ≥ PILL_MIN_STAKE and protection is active. */
    private _hasProtection(user: Address): boolean {
        return u256.ge(this.userPillStake.get(user), PILL_MIN_STAKE);
    }

    /**
     * Returns the effective liquidation HF threshold for a user.
     *   Protected (≥100 PILL staked) → 1.1×RAY
     *   Unprotected                  → 1.2×RAY
     */
    private _liquidationThreshold(user: Address): u256 {
        return this._hasProtection(user) ? HF_PROTECTION_THRESHOLD : HF_LIQUIDATION_THRESHOLD;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL — VAULT VIEW
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * getVault(user: address)
     *
     * Complete snapshot of a user's vault state in a single call.
     * Designed for the frontend vault dashboard — covers every number needed
     * to render collateral positions, debt positions, risk indicators, and
     * available credit without further RPC calls.
     *
     * Returns 17 uint256 values (17 × 32 = 544 bytes):
     * ┌──────────────────────────┬──────────────────────────────────────────────┐
     * │ Field                    │ Description                                  │
     * ├──────────────────────────┼──────────────────────────────────────────────┤
     * │ totalCollateralValue     │ All enabled collateral → satoshis            │
     * │ totalBorrowValue         │ All compounded debt    → satoshis            │
     * │ healthFactor             │ RAY precision; ≥ 1.2×RAY = healthy           │
     * │ loanToValueRatio         │ totalBorrow / collateral × 10000 (bp)        │
     * │                          │ Max 6 666 bp (66.67%) at 150% ratio          │
     * │ liquidationThreshold     │ Constant: 8 000 bp (80%)                     │
     * │ liquidationHFThreshold   │ Constant: 1.2 × 10^18 (RAY)                 │
     * │ availableCredit          │ Remaining borrow capacity in satoshis        │
     * │                          │ = max(0, collateral×10000/15000 − borrowed)  │
     * │ isLiquidatable           │ 1 if HF < 1.2×RAY and user has debt         │
     * │ btcCollateralBalance     │ BTC shares redeemable value (token units)    │
     * │ motoCollateralBalance    │ MOTO shares redeemable value                 │
     * │ pillCollateralBalance    │ PILL shares redeemable value                 │
     * │ btcDebtBalance           │ Compounded BTC debt (token units)            │
     * │ motoDebtBalance          │ Compounded MOTO debt                         │
     * │ pillDebtBalance          │ Compounded PILL debt                         │
     * │ btcCollateralEnabled     │ 1 if BTC pool is flagged as collateral       │
     * │ motoCollateralEnabled    │ 1 if MOTO pool is flagged as collateral      │
     * │ pillCollateralEnabled    │ 1 if PILL pool is flagged as collateral      │
     * └──────────────────────────┴──────────────────────────────────────────────┘
     */
    @method({ name: 'user', type: ABIDataTypes.ADDRESS })
    @returns(
        { name: 'totalCollateralValue',   type: ABIDataTypes.UINT256 },
        { name: 'totalBorrowValue',       type: ABIDataTypes.UINT256 },
        { name: 'healthFactor',           type: ABIDataTypes.UINT256 },
        { name: 'loanToValueRatio',       type: ABIDataTypes.UINT256 },
        { name: 'liquidationThreshold',   type: ABIDataTypes.UINT256 },
        { name: 'liquidationHFThreshold', type: ABIDataTypes.UINT256 },
        { name: 'availableCredit',        type: ABIDataTypes.UINT256 },
        { name: 'isLiquidatable',         type: ABIDataTypes.UINT256 },
        { name: 'btcCollateralBalance',   type: ABIDataTypes.UINT256 },
        { name: 'motoCollateralBalance',  type: ABIDataTypes.UINT256 },
        { name: 'pillCollateralBalance',  type: ABIDataTypes.UINT256 },
        { name: 'btcDebtBalance',         type: ABIDataTypes.UINT256 },
        { name: 'motoDebtBalance',        type: ABIDataTypes.UINT256 },
        { name: 'pillDebtBalance',        type: ABIDataTypes.UINT256 },
        { name: 'btcCollateralEnabled',   type: ABIDataTypes.UINT256 },
        { name: 'motoCollateralEnabled',  type: ABIDataTypes.UINT256 },
        { name: 'pillCollateralEnabled',  type: ABIDataTypes.UINT256 }
    )
    private _getVault(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();

        // ── Global risk metrics ──────────────────────────────────────────────
        const totalCollat: u256 = this._totalCollateralValue(user);
        const totalDebt: u256   = this._totalBorrowValue(user);
        const hf: u256          = this._computeHF(user);

        // LTV = totalDebt / totalCollateral × BASIS_POINTS
        let ltv: u256;
        if (u256.eq(totalCollat, u256.Zero)) {
            ltv = u256.Zero;
        } else {
            ltv = SafeMath.div(SafeMath.mul(totalDebt, BASIS_POINTS), totalCollat);
        }

        // Available credit = max(0, maxDebtCapacity − totalDebt)
        // maxDebtCapacity = collateral × BASIS_POINTS / COLLATERAL_RATIO_BPS
        let availableCredit: u256;
        if (u256.eq(totalCollat, u256.Zero)) {
            availableCredit = u256.Zero;
        } else {
            const maxDebt: u256 = SafeMath.div(
                SafeMath.mul(totalCollat, BASIS_POINTS),
                COLLATERAL_RATIO_BPS,
            );
            availableCredit = u256.gt(maxDebt, totalDebt)
                ? SafeMath.sub(maxDebt, totalDebt)
                : u256.Zero;
        }

        // isLiquidatable: 1 if user has debt AND HF below their effective threshold
        const effectiveLiqThresh: u256 = this._liquidationThreshold(user);
        const isLiquidatable: u256 = (
            !u256.eq(totalDebt, u256.Zero) &&
            u256.lt(hf, effectiveLiqThresh)
        ) ? u256.One : u256.Zero;

        // ── Per-pool collateral balances (redeemable token value of LP shares) ──
        const btcCollatBal:  u256 = this._userTokenBalance(user, POOL_BTC);
        const motoCollatBal: u256 = this._userTokenBalance(user, POOL_MOTO);
        const pillCollatBal: u256 = this._userTokenBalance(user, POOL_PILL);

        // ── Per-pool debt balances (compounded) ──────────────────────────────
        const btcDebt:  u256 = this._compoundedDebt(user, POOL_BTC);
        const motoDebt: u256 = this._compoundedDebt(user, POOL_MOTO);
        const pillDebt: u256 = this._compoundedDebt(user, POOL_PILL);

        // ── Collateral enabled flags ─────────────────────────────────────────
        const btcEnabled:  u256 = this.userBtcCollateral.get(user);
        const motoEnabled: u256 = this.userMotoCollateral.get(user);
        const pillEnabled: u256 = this.userPillCollateral.get(user);

        const writer = new BytesWriter(32 * 17);
        writer.writeU256(totalCollat);
        writer.writeU256(totalDebt);
        writer.writeU256(hf);
        writer.writeU256(ltv);
        writer.writeU256(LIQUIDATION_THRESHOLD_BPS);  // 8000 (80%)
        writer.writeU256(effectiveLiqThresh);          // 1.1×RAY (protected) or 1.2×RAY
        writer.writeU256(availableCredit);
        writer.writeU256(isLiquidatable);
        writer.writeU256(btcCollatBal);
        writer.writeU256(motoCollatBal);
        writer.writeU256(pillCollatBal);
        writer.writeU256(btcDebt);
        writer.writeU256(motoDebt);
        writer.writeU256(pillDebt);
        writer.writeU256(btcEnabled);
        writer.writeU256(motoEnabled);
        writer.writeU256(pillEnabled);
        return writer;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  PILL PROTECTION SYSTEM — PUBLIC ACTIONS & VIEWS
    // ═════════════════════════════════════════════════════════════════════════

    /**
     * stakePill(amount: uint256) → (totalStaked, protectionActive, liqThreshold)
     *
     * Lock PILL tokens to activate (or strengthen) liquidation protection.
     * Once staked balance ≥ PILL_MIN_STAKE (100 PILL), the user's effective
     * liquidation HF threshold drops from 1.2×RAY → 1.1×RAY.
     *
     * Staked PILL earns NO yield (it is not deposited into the lending pool).
     * It can be reclaimed at any time via unstakePill(), subject to the vault
     * remaining above the new threshold post-withdrawal.
     *
     * Returns:
     *   totalStaked      — user's total staked PILL after this call
     *   protectionActive — 1 if threshold now lowered, 0 otherwise
     *   liqThreshold     — effective HF threshold (1.1 or 1.2 × RAY)
     */
    @method({ name: 'amount', type: ABIDataTypes.UINT256 })
    @returns(
        { name: 'totalStaked',      type: ABIDataTypes.UINT256 },
        { name: 'protectionActive', type: ABIDataTypes.UINT256 },
        { name: 'liqThreshold',     type: ABIDataTypes.UINT256 },
    )
    private _stakePill(calldata: Calldata): BytesWriter {
        this._requireNotPaused();
        const amount: u256    = calldata.readU256();
        const caller: Address = Blockchain.tx.sender;
        if (u256.eq(amount, u256.Zero)) throw new Revert('LEND: zero stake amount');

        // Pull PILL from caller (PILL pool must be configured)
        this._pullOP20(POOL_PILL, caller, amount);

        // Update staked balance
        const current: u256  = this.userPillStake.get(caller);
        const newStaked: u256 = SafeMath.add(current, amount);
        this.userPillStake.set(caller, newStaked);

        const isProtected: boolean = u256.ge(newStaked, PILL_MIN_STAKE);
        const liqThresh: u256 = isProtected ? HF_PROTECTION_THRESHOLD : HF_LIQUIDATION_THRESHOLD;

        const writer = new BytesWriter(32 * 3);
        writer.writeU256(newStaked);
        writer.writeU256(isProtected ? u256.One : u256.Zero);
        writer.writeU256(liqThresh);
        return writer;
    }

    /**
     * unstakePill(amount: uint256) → (totalStaked, protectionActive, liqThreshold, healthFactor)
     *
     * Withdraw previously staked PILL back to caller's wallet.
     *
     * Safety check: if the caller has open borrows AND removing this PILL would
     * de-activate protection (staked drops below 100), the resulting unprotected
     * threshold (1.2×RAY) is checked against the current HF.  If HF < 1.2 the
     * call reverts — the position would immediately become liquidatable.
     *
     * Returns:
     *   totalStaked      — remaining staked PILL after withdrawal
     *   protectionActive — 1 if still protected, 0 if protection removed
     *   liqThreshold     — new effective HF threshold
     *   healthFactor     — current HF (RAY) so frontend can update immediately
     */
    @method({ name: 'amount', type: ABIDataTypes.UINT256 })
    @returns(
        { name: 'totalStaked',      type: ABIDataTypes.UINT256 },
        { name: 'protectionActive', type: ABIDataTypes.UINT256 },
        { name: 'liqThreshold',     type: ABIDataTypes.UINT256 },
        { name: 'healthFactor',     type: ABIDataTypes.UINT256 },
    )
    private _unstakePill(calldata: Calldata): BytesWriter {
        this._requireNotPaused();
        const amount: u256    = calldata.readU256();
        const caller: Address = Blockchain.tx.sender;
        if (u256.eq(amount, u256.Zero)) throw new Revert('LEND: zero unstake amount');

        const current: u256 = this.userPillStake.get(caller);
        if (u256.lt(current, amount)) throw new Revert('LEND: insufficient staked PILL');

        const newStaked: u256 = SafeMath.sub(current, amount);

        // Safety: if user has borrows and protection is being removed, verify HF
        // would still be above the stricter (unprotected) 1.2×RAY threshold.
        if (this._hasBorrows(caller)) {
            const wouldBeProtected: boolean = u256.ge(newStaked, PILL_MIN_STAKE);
            if (!wouldBeProtected) {
                // Protection will be lost — check HF against 1.2×RAY
                const hf: u256 = this._computeHF(caller);
                if (u256.lt(hf, HF_LIQUIDATION_THRESHOLD)) {
                    throw new Revert('LEND: unstaking PILL would make position immediately liquidatable');
                }
            }
        }

        this.userPillStake.set(caller, newStaked);
        this._pushOP20(POOL_PILL, caller, amount);

        const isProtected: boolean = u256.ge(newStaked, PILL_MIN_STAKE);
        const liqThresh: u256 = isProtected ? HF_PROTECTION_THRESHOLD : HF_LIQUIDATION_THRESHOLD;
        const hfNow: u256     = this._computeHF(caller);

        const writer = new BytesWriter(32 * 4);
        writer.writeU256(newStaked);
        writer.writeU256(isProtected ? u256.One : u256.Zero);
        writer.writeU256(liqThresh);
        writer.writeU256(hfNow);
        return writer;
    }

    /**
     * getPillProtection(user: address) → 6 uint256 values
     *
     * Full protection dashboard for the given address.
     *
     * ┌───────────────────────┬──────────────────────────────────────────────┐
     * │ pillStaked            │ PILL tokens locked in protection contract    │
     * │ protectionActive      │ 1 if staked ≥ 100 PILL, 0 otherwise         │
     * │ liqThreshold          │ 1.1×RAY (protected) or 1.2×RAY (standard)   │
     * │ minStakeRequired      │ 100 PILL (10 000 000 000 raw) — constant     │
     * │ pillToActivate        │ PILL still needed to reach min stake (0=ok)  │
     * │ healthFactor          │ Current HF (RAY) — live risk indicator       │
     * └───────────────────────┴──────────────────────────────────────────────┘
     */
    @method({ name: 'user', type: ABIDataTypes.ADDRESS })
    @returns(
        { name: 'pillStaked',       type: ABIDataTypes.UINT256 },
        { name: 'protectionActive', type: ABIDataTypes.UINT256 },
        { name: 'liqThreshold',     type: ABIDataTypes.UINT256 },
        { name: 'minStakeRequired', type: ABIDataTypes.UINT256 },
        { name: 'pillToActivate',   type: ABIDataTypes.UINT256 },
        { name: 'healthFactor',     type: ABIDataTypes.UINT256 },
    )
    private _getPillProtection(calldata: Calldata): BytesWriter {
        const user: Address    = calldata.readAddress();
        const staked: u256     = this.userPillStake.get(user);
        const isProtected: boolean = u256.ge(staked, PILL_MIN_STAKE);
        const liqThresh: u256  = isProtected ? HF_PROTECTION_THRESHOLD : HF_LIQUIDATION_THRESHOLD;
        const hf: u256         = this._computeHF(user);

        const pillToActivate: u256 = isProtected ? u256.Zero
            : (u256.gt(PILL_MIN_STAKE, staked) ? SafeMath.sub(PILL_MIN_STAKE, staked) : u256.Zero);

        const writer = new BytesWriter(32 * 6);
        writer.writeU256(staked);
        writer.writeU256(isProtected ? u256.One : u256.Zero);
        writer.writeU256(liqThresh);
        writer.writeU256(PILL_MIN_STAKE);
        writer.writeU256(pillToActivate);
        writer.writeU256(hf);
        return writer;
    }

    // ═════════════════════════════════════════════════════════════════════════
    //  BTC YIELD LOOP STRATEGY
    // ═════════════════════════════════════════════════════════════════════════
    //
    //  The loop amplifies BTC exposure through a single MOTO borrow:
    //
    //   1x  — no borrow; just records the user's current BTC deposit.
    //   2x  — borrows MOTO worth 1× the user's current BTC balance;
    //          the relayer swaps MOTO for BTC and calls creditBtcDeposit(),
    //          adding ~1× more BTC collateral → total ~2× exposure.
    //   3x  — borrows MOTO worth 2× the user's current BTC balance;
    //          relayer credits ~2× more BTC → total ~3× exposure.
    //
    //  Math (all SAT-precision, using u256 safe arithmetic):
    //    motoBorrow = (level - 1) × btcBalance × priceBtc / priceMoto
    //    projectedCollatSats = level × btcBalance × priceBtc / SAT_SCALE
    //    projectedBorrowSats = motoBorrow × priceMoto / SAT_SCALE
    //    projectedHF = projectedCollatSats × LIQUIDATION_THRESHOLD_BPS × RAY
    //                  / (projectedBorrowSats × BASIS_POINTS)
    //
    //  Safety gates:
    //    • User must have BTC collateral (non-zero BTC LP shares).
    //    • Projected HF must stay above the user's effective liquidation threshold.
    //    • For 3x, projected HF ≈ 1.2×RAY — triggers WARNING risk tier. The
    //      caller is warned via riskStatus; the transaction is still allowed if
    //      HF >= effective threshold so PILL-protected users can use 3x safely.
    //    • A loop cannot be opened twice; call closeLoop() first.
    //
    //  On-chain vs off-chain boundary:
    //    _openLoop() executes the MOTO borrow in the same tx.
    //    The MOTO → BTC swap and re-deposit happen off-chain via the relayer.
    //    The contract tracks intent (level + initial BTC snapshot); the relayer
    //    closes the loop by calling creditBtcDeposit(user, addedBtc).
    //
    //  closeLoop() clears the loop tracking flags.  It does NOT auto-repay MOTO
    //  (the user calls repay() separately when they want to unwind).

    @method(
        { name: 'loopLevel', type: ABIDataTypes.UINT8 }
    )
    @returns(
        { name: 'loopLevel',          type: ABIDataTypes.UINT8   },
        { name: 'initialBtcDeposit',  type: ABIDataTypes.UINT256 },
        { name: 'motoBorrowed',       type: ABIDataTypes.UINT256 },
        { name: 'totalBtcExposure',   type: ABIDataTypes.UINT256 },
        { name: 'totalCollatSats',    type: ABIDataTypes.UINT256 },
        { name: 'healthFactor',       type: ABIDataTypes.UINT256 },
        { name: 'riskStatus',         type: ABIDataTypes.UINT256 }
    )
    private _openLoop(calldata: Calldata): BytesWriter {
        this._requireNotPaused();
        const loopLevel: u8    = calldata.readU8();
        const caller: Address  = Blockchain.tx.sender;

        if (loopLevel < 1 || loopLevel > 3) {
            throw new Revert('LEND: loopLevel must be 1, 2, or 3');
        }

        // Cannot stack loops — close the existing one first
        if (!u256.eq(this.userLoopActive.get(caller), u256.Zero)) {
            throw new Revert('LEND: loop already active — call closeLoop() first');
        }

        // User must have BTC deposited as collateral
        const btcShares: u256 = this.userBtcShares.get(caller);
        if (u256.eq(btcShares, u256.Zero)) {
            throw new Revert('LEND: no BTC deposit — deposit BTC first');
        }

        // Snapshot the current BTC token balance (shares → token amount)
        const initialBtcBalance: u256 = this._userTokenBalance(caller, POOL_BTC);
        if (u256.eq(initialBtcBalance, u256.Zero)) {
            throw new Revert('LEND: BTC balance is zero');
        }

        const btcPrice: u256  = this.priceBtc.value;
        const motoPrice: u256 = this.priceMoto.value;
        if (u256.eq(motoPrice, u256.Zero)) {
            throw new Revert('LEND: MOTO price not set');
        }

        // 1x: no borrow — record state and return
        if (loopLevel === 1) {
            this.userLoopActive.set(caller, u256.One);
            this.userLoopLevel.set(caller, u256.fromU32(1));
            this.userLoopInitialBtc.set(caller, initialBtcBalance);

            const hf: u256         = this._computeHF(caller);
            const collatSats: u256 = this._totalCollateralValue(caller);
            const status: u256     = this._classifyRisk(hf, this._hasBorrows(caller), this._liquidationThreshold(caller));

            const writer = new BytesWriter(32 * 6 + 1);
            writer.writeU8(1);
            writer.writeU256(initialBtcBalance);
            writer.writeU256(u256.Zero);          // no MOTO borrowed
            writer.writeU256(initialBtcBalance);  // total exposure = initial
            writer.writeU256(collatSats);
            writer.writeU256(hf);
            writer.writeU256(status);
            return writer;
        }

        // 2x: borrow MOTO worth 1× initial BTC value
        // 3x: borrow MOTO worth 2× initial BTC value
        const multiplier: u256 = u256.fromU32(<u32>(loopLevel - 1));

        // motoBorrow = multiplier × btcBalance × priceBtc / priceMoto
        const motoBorrow: u256 = SafeMath.div(
            SafeMath.mul(SafeMath.mul(multiplier, initialBtcBalance), btcPrice),
            motoPrice,
        );
        if (u256.eq(motoBorrow, u256.Zero)) {
            throw new Revert('LEND: computed MOTO borrow is zero — price mismatch');
        }

        // Validate: enough MOTO liquidity
        this._accrueInterest(POOL_MOTO);
        const availMoto: u256 = this._availableLiquidity(POOL_MOTO);
        if (u256.lt(availMoto, motoBorrow)) {
            throw new Revert('LEND: insufficient MOTO liquidity for loop');
        }

        // Validate: BTC collateral can back MOTO borrow (collateral rules)
        const btcCollateralFlag: u256 = this.userBtcCollateral.get(caller);
        if (u256.eq(btcCollateralFlag, u256.Zero)) {
            throw new Revert('LEND: BTC collateral not enabled');
        }

        // Simulate post-borrow HF (uses current BTC collateral, not projected looped amount)
        const hfAfterBorrow: u256 = this._simulatedHFAfterBorrow(caller, POOL_MOTO, motoBorrow);
        if (u256.lt(hfAfterBorrow, this._liquidationThreshold(caller))) {
            throw new Revert('LEND: loop would undercollateralise vault');
        }

        // ── EXECUTE MOTO BORROW (inline — same as _borrow without calldata) ──
        const discountBps: u256      = this._loyaltyDiscountBps(caller);
        let effectiveMoto: u256;
        if (u256.eq(discountBps, u256.Zero)) {
            effectiveMoto = motoBorrow;
        } else {
            const disc: u256 = SafeMath.div(SafeMath.mul(motoBorrow, discountBps), BASIS_POINTS);
            effectiveMoto = SafeMath.sub(motoBorrow, disc);
        }

        const curPrincipal: u256 = this._borrowMap(POOL_MOTO).get(caller);
        const curIdxSnap: u256   = this._borrowIdxMap(POOL_MOTO).get(caller);
        const curIndex: u256     = this._borrowIndex(POOL_MOTO).value;

        let newPrincipal: u256;
        if (u256.eq(curPrincipal, u256.Zero)) {
            newPrincipal = effectiveMoto;
        } else {
            const compounded: u256 = SafeMath.div(
                SafeMath.mul(curPrincipal, curIndex),
                curIdxSnap,
            );
            newPrincipal = SafeMath.add(compounded, effectiveMoto);
        }

        this._borrowMap(POOL_MOTO).set(caller, newPrincipal);
        this._borrowIdxMap(POOL_MOTO).set(caller, curIndex);

        const totalBorrowedStore: StoredU256 = this._totalBorrowed(POOL_MOTO);
        totalBorrowedStore.set(SafeMath.add(totalBorrowedStore.value, motoBorrow));

        // Send MOTO to caller (relayer will swap and call creditBtcDeposit)
        this._pushOP20(POOL_MOTO, caller, motoBorrow);

        // ── RECORD LOOP STATE ────────────────────────────────────────────────
        this.userLoopActive.set(caller, u256.One);
        this.userLoopLevel.set(caller, u256.fromU32(<u32>loopLevel));
        this.userLoopInitialBtc.set(caller, initialBtcBalance);

        // ── BUILD RETURN DATA ────────────────────────────────────────────────
        // totalBtcExposure = level × initialBtc (projected after relayer re-deposit)
        const totalBtcExposure: u256 = SafeMath.mul(u256.fromU32(<u32>loopLevel), initialBtcBalance);
        const collatSats: u256 = this._totalCollateralValue(caller);
        const riskStatus: u256 = this._classifyRisk(hfAfterBorrow, true, this._liquidationThreshold(caller));

        const writer = new BytesWriter(32 * 6 + 1);
        writer.writeU8(loopLevel);
        writer.writeU256(initialBtcBalance);
        writer.writeU256(motoBorrow);
        writer.writeU256(totalBtcExposure);
        writer.writeU256(collatSats);
        writer.writeU256(hfAfterBorrow);
        writer.writeU256(riskStatus);
        return writer;
    }

    @method()
    @returns(
        { name: 'wasActive',    type: ABIDataTypes.UINT256 },
        { name: 'motoDebt',     type: ABIDataTypes.UINT256 },
        { name: 'btcBalance',   type: ABIDataTypes.UINT256 },
        { name: 'healthFactor', type: ABIDataTypes.UINT256 }
    )
    private _closeLoop(calldata: Calldata): BytesWriter {
        this._requireNotPaused();
        const caller: Address = Blockchain.tx.sender;

        const wasActive: u256 = this.userLoopActive.get(caller);

        // Clear loop tracking state (MOTO debt remains — user repays separately)
        this.userLoopActive.set(caller, u256.Zero);
        this.userLoopLevel.set(caller, u256.Zero);
        this.userLoopInitialBtc.set(caller, u256.Zero);

        // Current MOTO debt (compounded to now)
        const motoDebt: u256     = this._compoundedDebt(caller, POOL_MOTO);
        const btcBalance: u256   = this._userTokenBalance(caller, POOL_BTC);
        const hf: u256           = this._computeHF(caller);

        const writer = new BytesWriter(32 * 4);
        writer.writeU256(wasActive);
        writer.writeU256(motoDebt);
        writer.writeU256(btcBalance);
        writer.writeU256(hf);
        return writer;
    }

    @method(
        { name: 'user', type: ABIDataTypes.ADDRESS }
    )
    @returns(
        { name: 'loopLevel',        type: ABIDataTypes.UINT8   },
        { name: 'isActive',         type: ABIDataTypes.UINT256 },
        { name: 'initialBtcDeposit',type: ABIDataTypes.UINT256 },
        { name: 'currentBtcBalance',type: ABIDataTypes.UINT256 },
        { name: 'loopedBtcAdded',   type: ABIDataTypes.UINT256 },
        { name: 'motoBorrowed',     type: ABIDataTypes.UINT256 },
        { name: 'totalCollatSats',  type: ABIDataTypes.UINT256 },
        { name: 'healthFactor',     type: ABIDataTypes.UINT256 }
    )
    private _getLoopMetrics(calldata: Calldata): BytesWriter {
        const user: Address = calldata.readAddress();

        const isActive: u256      = this.userLoopActive.get(user);
        const level: u256         = this.userLoopLevel.get(user);
        const initialBtc: u256    = this.userLoopInitialBtc.get(user);
        const currentBtc: u256    = this._userTokenBalance(user, POOL_BTC);
        const motoDebt: u256      = this._compoundedDebt(user, POOL_MOTO);
        const collatSats: u256    = this._totalCollateralValue(user);
        const hf: u256            = this._computeHF(user);

        // loopedBtcAdded = max(0, currentBtc − initialBtc)
        const loopedBtcAdded: u256 = u256.gt(currentBtc, initialBtc)
            ? SafeMath.sub(currentBtc, initialBtc)
            : u256.Zero;

        // level stored as u256, write as u8 for ABI consistency
        const levelU8: u8 = <u8>level.lo1;

        const writer = new BytesWriter(32 * 7 + 1);
        writer.writeU8(levelU8);
        writer.writeU256(isActive);
        writer.writeU256(initialBtc);
        writer.writeU256(currentBtc);
        writer.writeU256(loopedBtcAdded);
        writer.writeU256(motoDebt);
        writer.writeU256(collatSats);
        writer.writeU256(hf);
        return writer;
    }

    @method(
        { name: 'loopLevel', type: ABIDataTypes.UINT8 }
    )
    @returns(
        { name: 'projectedMotoToBorrow',  type: ABIDataTypes.UINT256 },
        { name: 'projectedBtcToAdd',      type: ABIDataTypes.UINT256 },
        { name: 'projectedTotalCollatSats',type: ABIDataTypes.UINT256 },
        { name: 'projectedBorrowSats',    type: ABIDataTypes.UINT256 },
        { name: 'projectedHF',            type: ABIDataTypes.UINT256 },
        { name: 'projectedRiskStatus',    type: ABIDataTypes.UINT256 },
        { name: 'isSafe',                 type: ABIDataTypes.UINT256 }
    )
    private _previewLoop(calldata: Calldata): BytesWriter {
        const loopLevel: u8    = calldata.readU8();
        const caller: Address  = Blockchain.tx.sender;

        if (loopLevel < 1 || loopLevel > 3) {
            throw new Revert('LEND: loopLevel must be 1, 2, or 3');
        }

        const btcBalance: u256 = this._userTokenBalance(caller, POOL_BTC);
        const btcPrice: u256   = this.priceBtc.value;
        const motoPrice: u256  = this.priceMoto.value;

        // 1x: no borrow simulation
        if (loopLevel === 1) {
            const collatSats: u256 = this._totalCollateralValue(caller);
            const borrowSats: u256 = this._totalBorrowValue(caller);
            const hf: u256         = this._computeHF(caller);
            const status: u256     = this._classifyRisk(hf, this._hasBorrows(caller), this._liquidationThreshold(caller));
            const isSafe: u256     = u256.ge(hf, this._liquidationThreshold(caller)) ? u256.One : u256.Zero;

            const writer = new BytesWriter(32 * 7);
            writer.writeU256(u256.Zero);   // no borrow
            writer.writeU256(u256.Zero);   // no BTC added
            writer.writeU256(collatSats);
            writer.writeU256(borrowSats);
            writer.writeU256(hf);
            writer.writeU256(status);
            writer.writeU256(isSafe);
            return writer;
        }

        const multiplier: u256 = u256.fromU32(<u32>(loopLevel - 1));

        // motoBorrow = (level-1) × btcBalance × priceBtc / priceMoto
        let projectedMoto: u256 = u256.Zero;
        if (!u256.eq(btcBalance, u256.Zero) && !u256.eq(motoPrice, u256.Zero)) {
            projectedMoto = SafeMath.div(
                SafeMath.mul(SafeMath.mul(multiplier, btcBalance), btcPrice),
                motoPrice,
            );
        }

        // projectedBtcToAdd = motoBorrow × priceMoto / priceBtc
        //   (what the relayer converts back to BTC)
        let projectedBtcToAdd: u256 = u256.Zero;
        if (!u256.eq(projectedMoto, u256.Zero) && !u256.eq(btcPrice, u256.Zero)) {
            projectedBtcToAdd = SafeMath.div(
                SafeMath.mul(projectedMoto, motoPrice),
                btcPrice,
            );
        }

        // Projected total collateral after relayer re-deposits BTC
        const projectedBtcTotal: u256  = SafeMath.add(btcBalance, projectedBtcToAdd);
        const currentCollatSats: u256  = this._totalCollateralValue(caller);
        const addedCollatSats: u256    = u256.eq(btcPrice, u256.Zero)
            ? u256.Zero
            : SafeMath.div(SafeMath.mul(projectedBtcToAdd, btcPrice), SAT_SCALE);
        const projectedCollatSats: u256 = SafeMath.add(currentCollatSats, addedCollatSats);

        // Projected borrow sats = current borrow sats + new MOTO borrow sats
        const currentBorrowSats: u256   = this._totalBorrowValue(caller);
        const newMotoBorrowSats: u256   = u256.eq(btcPrice, u256.Zero)
            ? u256.Zero
            : SafeMath.div(SafeMath.mul(projectedMoto, motoPrice), SAT_SCALE);
        const projectedBorrowSats: u256 = SafeMath.add(currentBorrowSats, newMotoBorrowSats);

        // Projected HF = projectedCollatSats × LIQUIDATION_THRESHOLD_BPS × RAY
        //                / (projectedBorrowSats × BASIS_POINTS)
        let projectedHF: u256 = u256.Zero;
        if (!u256.eq(projectedBorrowSats, u256.Zero) && !u256.eq(projectedCollatSats, u256.Zero)) {
            projectedHF = SafeMath.div(
                SafeMath.mul(
                    SafeMath.mul(projectedCollatSats, LIQUIDATION_THRESHOLD_BPS),
                    RAY,
                ),
                SafeMath.mul(projectedBorrowSats, BASIS_POINTS),
            );
        }

        const liqThresh: u256     = this._liquidationThreshold(caller);
        const hasBorrowsAfter: boolean = !u256.eq(projectedBorrowSats, u256.Zero);
        const projStatus: u256    = this._classifyRisk(projectedHF, hasBorrowsAfter, liqThresh);
        const isSafe: u256        = u256.ge(projectedHF, liqThresh) ? u256.One : u256.Zero;

        const writer = new BytesWriter(32 * 7);
        writer.writeU256(projectedMoto);
        writer.writeU256(projectedBtcToAdd);
        writer.writeU256(projectedCollatSats);
        writer.writeU256(projectedBorrowSats);
        writer.writeU256(projectedHF);
        writer.writeU256(projStatus);
        writer.writeU256(isSafe);
        return writer;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL — SHARED DEPOSIT / WITHDRAW CORE LOGIC
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * __doDeposit — shared deposit logic called by both deposit() and addCollateral().
     *
     * Steps:
     *   1. Accrue interest so exchange rate is current before share calculation.
     *   2. Compute shares to mint (1:1 if pool empty; else proportional).
     *   3. Update pool globals: totalDeposits ↑, totalShares ↑.
     *   4. Update user shares and net-deposit principal tracker.
     *   5. Record first-deposit block for historical APY.
     *   6. Enable pool as collateral on first deposit (vault flag).
     *   7. Pull OP-20 tokens for MOTO/PILL pools (CEI: effects before interaction).
     *
     * Returns: shares minted.
     */
    private __doDeposit(caller: Address, token: u8, amount: u256): u256 {
        // Bring exchange rate to current block before minting shares
        this._accrueInterest(token);

        // ── COMPUTE SHARES ───────────────────────────────────────────────────
        const totalSharesStore: StoredU256   = this._totalShares(token);
        const totalDepositsStore: StoredU256 = this._totalDeposits(token);

        let sharesToMint: u256;
        if (u256.eq(totalSharesStore.value, u256.Zero) ||
            u256.eq(totalDepositsStore.value, u256.Zero)) {
            sharesToMint = amount; // 1:1 init — prevents share-inflation attack
        } else {
            sharesToMint = SafeMath.div(
                SafeMath.mul(amount, totalSharesStore.value),
                totalDepositsStore.value,
            );
        }
        if (u256.eq(sharesToMint, u256.Zero)) throw new Revert('LEND: dust deposit, zero shares');

        // ── EFFECTS — pool globals ───────────────────────────────────────────
        totalDepositsStore.set(SafeMath.add(totalDepositsStore.value, amount));
        totalSharesStore.set(SafeMath.add(totalSharesStore.value, sharesToMint));

        // ── EFFECTS — user shares ────────────────────────────────────────────
        const currentUserShares: u256 = this._sharesMap(token).get(caller);
        this._sharesMap(token).set(caller, SafeMath.add(currentUserShares, sharesToMint));

        // ── EFFECTS — net principal tracker ─────────────────────────────────
        const currentNetDeposit: u256 = this._netDepositMap(token).get(caller);
        this._netDepositMap(token).set(caller, SafeMath.add(currentNetDeposit, amount));

        // ── EFFECTS — first-deposit block (historical APY denominator) ───────
        const currentDepositBlock: u256 = this._depositBlockMap(token).get(caller);
        if (u256.eq(currentDepositBlock, u256.Zero)) {
            this._depositBlockMap(token).set(caller, u256.fromU64(Blockchain.block.number));
        }

        // ── EFFECTS — vault collateral flag ─────────────────────────────────
        // Mark this pool as active collateral for the user's vault on first deposit.
        const currentCollatFlag: u256 = this._collateralMap(token).get(caller);
        if (u256.eq(currentCollatFlag, u256.Zero)) {
            this._collateralMap(token).set(caller, u256.One);
        }

        // ── INTERACTIONS (after all state mutations per CEI) ─────────────────
        if (token === POOL_MOTO || token === POOL_PILL) {
            this._pullOP20(token, caller, amount);
        }
        // BTC: credited off-chain via creditBtcDeposit(); no pull here.

        return sharesToMint;
    }

    /**
     * __doWithdraw — shared withdrawal logic called by both withdraw() and withdrawCollateral().
     *
     * Steps:
     *   1. Accrue interest so exchange rate is current before share burn.
     *   2. Compute shares to burn (proportional to amount requested).
     *   3. Verify caller owns enough shares.
     *   4. Verify pool has free liquidity (not fully borrowed out).
     *   5. If user has active debt: simulate vault health factor post-withdrawal.
     *      Revert if HF would drop below 1.2 — vault must remain healthy.
     *   6. Burn shares, reduce pool totals, reduce net-deposit tracker.
     *   7. Clear first-deposit block if position is fully closed.
     *   8. Push OP-20 tokens for MOTO/PILL; BTC handled by backend.
     */
    private __doWithdraw(caller: Address, token: u8, amount: u256): void {
        this._accrueInterest(token);

        const totalSharesStore: StoredU256   = this._totalShares(token);
        const totalDepositsStore: StoredU256 = this._totalDeposits(token);

        if (u256.eq(totalSharesStore.value, u256.Zero) ||
            u256.eq(totalDepositsStore.value, u256.Zero)) {
            throw new Revert('LEND: pool is empty');
        }

        const sharesToBurn: u256 = SafeMath.div(
            SafeMath.mul(amount, totalSharesStore.value),
            totalDepositsStore.value,
        );
        if (u256.eq(sharesToBurn, u256.Zero)) throw new Revert('LEND: zero shares to burn');

        const withdrawUserShares: u256 = this._sharesMap(token).get(caller);
        if (u256.lt(withdrawUserShares, sharesToBurn)) {
            throw new Revert('LEND: insufficient deposit shares');
        }

        const avail: u256 = this._availableLiquidity(token);
        if (u256.lt(avail, amount)) {
            throw new Revert('LEND: insufficient pool liquidity — funds are borrowed');
        }

        // ── VAULT HEALTH CHECK ───────────────────────────────────────────────
        // If the user has active borrows, withdrawal reduces collateral value
        // and therefore the health factor. Simulate the post-withdrawal vault
        // state and revert if HF would breach the liquidation threshold.
        if (this._hasBorrows(caller)) {
            const currentTokenBal: u256 = SafeMath.div(
                SafeMath.mul(withdrawUserShares, totalDepositsStore.value),
                totalSharesStore.value,
            );
            const newTokenBalance: u256 = u256.gt(currentTokenBal, amount)
                ? SafeMath.sub(currentTokenBal, amount)
                : u256.Zero;
            const simulatedHF: u256 = this._simulatedHF(caller, token, newTokenBalance);
            if (u256.lt(simulatedHF, this._liquidationThreshold(caller))) {
                throw new Revert('LEND: vault health factor would drop below liquidation threshold');
            }
        }

        // ── EFFECTS — pool globals ───────────────────────────────────────────
        totalSharesStore.set(SafeMath.sub(totalSharesStore.value, sharesToBurn));
        totalDepositsStore.set(SafeMath.sub(totalDepositsStore.value, amount));

        // ── EFFECTS — user shares ────────────────────────────────────────────
        const withdrawSharesAfter: u256 = SafeMath.sub(withdrawUserShares, sharesToBurn);
        this._sharesMap(token).set(caller, withdrawSharesAfter);

        // ── EFFECTS — net-principal tracker ─────────────────────────────────
        // Clamped to 0: a user who earned interest withdraws more than they deposited,
        // but the "principal" tracker is never allowed to go negative.
        const currentNetDeposit: u256 = this._netDepositMap(token).get(caller);
        if (u256.gt(currentNetDeposit, amount)) {
            this._netDepositMap(token).set(caller, SafeMath.sub(currentNetDeposit, amount));
        } else {
            this._netDepositMap(token).set(caller, u256.Zero);
        }

        // ── EFFECTS — clear deposit block if vault position fully closed ─────
        if (u256.eq(withdrawSharesAfter, u256.Zero)) {
            this._depositBlockMap(token).set(caller, u256.Zero);
            // Clear vault collateral flag — this pool is no longer backing any debt.
            this._collateralMap(token).set(caller, u256.Zero);
        }

        // ── INTERACTIONS ─────────────────────────────────────────────────────
        if (token === POOL_MOTO || token === POOL_PILL) {
            this._pushOP20(token, caller, amount);
        }
        // BTC: backend constructs the L1 return transaction.
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL — DEPOSIT POSITION COMPUTATION
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Compute all display fields for a user's deposit position in one pool.
     *
     * earnedInterest:
     *   The difference between current token balance and net principal deposited.
     *   Reflects actual yield earned from interest accrual.
     *
     * currentAPR:
     *   The pool's current annual borrow rate (= depositor earn rate × utilization).
     *   Frontend multiplies by utilization to get depositor APR:
     *     depositorAPR = currentAPR × utilizationRate / BASIS_POINTS
     *
     * estimatedAPY:
     *   Approximate compound APY from currentAPR.
     *   Integer approximation: APY ≈ APR × (1 + APR / (BLOCKS_PER_YEAR × BASIS_POINTS))^52
     *   Simplified here to APR (accurate for small rates, compounding handled off-chain).
     *
     * historicalAPYBps:
     *   Actual annualised return the user has earned since their first deposit.
     *   Formula: (earnedInterest / netDeposited) / (blocksElapsed / BLOCKS_PER_YEAR) × BASIS_POINTS
     *   Returns 0 if no time has elapsed or no principal.
     */
    private _computeDepositPosition(user: Address, token: u8): DepositPosition {
        const shares: u256       = this._sharesMap(token).get(user);
        const netDeposited: u256 = this._netDepositMap(token).get(user);
        const firstBlock: u256   = this._depositBlockMap(token).get(user);

        const tokenBalance: u256 = this._userTokenBalance(user, token);

        // Earned interest = current value − original principal (clamped to 0)
        let earnedInterest: u256;
        if (u256.gt(tokenBalance, netDeposited)) {
            earnedInterest = SafeMath.sub(tokenBalance, netDeposited);
        } else {
            earnedInterest = u256.Zero;
        }

        // Current pool APR (borrow rate)
        const utilBps: u256    = this._utilizationRate(token);
        const currentAPR: u256 = this._interestRate(utilBps);

        // estimatedAPY (simplified: same as APR for display; frontend compounds weekly)
        const estimatedAPY: u256 = currentAPR;

        // Historical APY = (earned / principal) / (elapsed / BLOCKS_PER_YEAR) × BASIS_POINTS
        let historicalAPYBps: u256 = u256.Zero;
        const currentBlock: u256   = u256.fromU64(Blockchain.block.number);

        if (!u256.eq(netDeposited, u256.Zero) &&
            !u256.eq(firstBlock, u256.Zero) &&
            u256.gt(currentBlock, firstBlock) &&
            !u256.eq(earnedInterest, u256.Zero)) {

            const blocksElapsed: u256 = SafeMath.sub(currentBlock, firstBlock);

            // historicalAPY = earnedInterest × BLOCKS_PER_YEAR × BASIS_POINTS
            //                 / (netDeposited × blocksElapsed)
            const numerator: u256 = SafeMath.mul(
                SafeMath.mul(earnedInterest, BLOCKS_PER_YEAR),
                BASIS_POINTS,
            );
            const denominator: u256 = SafeMath.mul(netDeposited, blocksElapsed);
            if (!u256.eq(denominator, u256.Zero)) {
                historicalAPYBps = SafeMath.div(numerator, denominator);
            }
        }

        return {
            netDeposited,
            shares,
            tokenBalance,
            earnedInterest,
            currentAPR,
            estimatedAPY,
            historicalAPYBps,
            firstDepositBlock: firstBlock,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL — BORROW POSITION COMPUTATION
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Compute all display fields for a user's borrow position in one pool.
     * Pure read — no state mutations.
     *
     * userDebt:             compounded debt tokens owed in this pool
     * userCollateral:       total collateral value in satoshis (all enabled pools)
     * debtValueInSats:      this pool's debt expressed in satoshis
     * totalBorrowValueSats: all-pool debt combined in satoshis
     * loanToValueRatio:     totalBorrowValue / collateralValue × BASIS_POINTS (max ~6 666 bp)
     * interestRate:         pool's current annual APR in basis points
     * healthFactor:         overall HF in RAY precision (1.2×10^18 = liquidation threshold)
     * maxBorrowable:        additional token units borrowable from this pool
     * isLiquidatable:       1 if HF < 1.2×RAY and user has debt, 0 otherwise
     */
    private _computeBorrowPosition(user: Address, token: u8): BorrowPosition {
        // Compounded debt in this pool
        const userDebt: u256 = this._compoundedDebt(user, token);

        // Total collateral value across all enabled pools (satoshis)
        const collatValue: u256 = this._totalCollateralValue(user);

        // This pool's debt value in satoshis
        const tokenPrice: u256      = this._price(token);
        const debtValueInSats: u256 = u256.eq(tokenPrice, u256.Zero)
            ? u256.Zero
            : SafeMath.div(SafeMath.mul(userDebt, tokenPrice), SAT_SCALE);

        // All-pool combined borrow value in satoshis
        const totalBorrowValueSats: u256 = this._totalBorrowValue(user);

        // LTV = totalBorrowValue / collateralValue × BASIS_POINTS
        let loanToValueRatio: u256;
        if (u256.eq(collatValue, u256.Zero)) {
            loanToValueRatio = u256.Zero;
        } else {
            loanToValueRatio = SafeMath.div(
                SafeMath.mul(totalBorrowValueSats, BASIS_POINTS),
                collatValue,
            );
        }

        // Pool's current borrow APR
        const utilBps: u256      = this._utilizationRate(token);
        const interestRate: u256 = this._interestRate(utilBps);

        // Overall health factor (RAY precision)
        const healthFactor: u256 = this._computeHF(user);

        // Max additional tokens borrowable from this pool
        // = (collateralValue × BASIS_POINTS / COLLATERAL_RATIO_BPS − totalBorrowValue) / tokenPrice
        let maxBorrowable: u256;
        if (u256.eq(collatValue, u256.Zero) || u256.eq(tokenPrice, u256.Zero)) {
            maxBorrowable = u256.Zero;
        } else {
            const maxDebtValue: u256 = SafeMath.div(
                SafeMath.mul(collatValue, BASIS_POINTS),
                COLLATERAL_RATIO_BPS,
            );
            if (u256.ge(totalBorrowValueSats, maxDebtValue)) {
                maxBorrowable = u256.Zero;
            } else {
                const remainingCapacitySats: u256 = SafeMath.sub(maxDebtValue, totalBorrowValueSats);
                maxBorrowable = SafeMath.div(
                    SafeMath.mul(remainingCapacitySats, SAT_SCALE),
                    tokenPrice,
                );
                // Cap by pool's available liquidity
                const poolAvail: u256 = this._availableLiquidity(token);
                if (u256.lt(poolAvail, maxBorrowable)) {
                    maxBorrowable = poolAvail;
                }
            }
        }

        // isLiquidatable: 1 if user has debt and HF is below their effective threshold
        const isLiquidatable: u256 = (
            !u256.eq(totalBorrowValueSats, u256.Zero) &&
            u256.lt(healthFactor, this._liquidationThreshold(user))
        ) ? u256.One : u256.Zero;

        return {
            userDebt,
            userCollateral:       collatValue,
            debtValueInSats,
            totalBorrowValueSats,
            loanToValueRatio,
            interestRate,
            healthFactor,
            maxBorrowable,
            isLiquidatable,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL — INTEREST ACCRUAL
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Compound the borrow index and distribute earned interest to the pool.
     *
     * Steps (only runs if totalBorrowed > 0 and block has advanced):
     *   1. Compute ratePerBlock from current utilisation
     *   2. indexDelta = oldIndex × ratePerBlock × Δblocks / RAY
     *   3. interestEarned = totalBorrowed × indexDelta / oldIndex
     *   4. totalDeposits += interestEarned  (depositors earn)
     *   5. totalBorrowed += interestEarned  (borrowers owe more)
     *   6. borrowIndex += indexDelta
     *   7. lastUpdate = currentBlock
     */
    private _accrueInterest(token: u8): void {
        const currentBlock: u256       = u256.fromU64(Blockchain.block.number);
        const lastUpdateStore: StoredU256   = this._lastUpdate(token);
        const borrowIndexStore: StoredU256  = this._borrowIndex(token);

        if (u256.ge(lastUpdateStore.value, currentBlock)) return; // same block, skip

        const totalBorrowedStore: StoredU256 = this._totalBorrowed(token);

        if (!u256.eq(totalBorrowedStore.value, u256.Zero)) {
            const blocksDelta: u256     = SafeMath.sub(currentBlock, lastUpdateStore.value);
            const utilBps: u256         = this._utilizationRate(token);
            const rateBps: u256         = this._interestRate(utilBps);

            // ratePerBlockRay = annualRate × RAY / (BASIS_POINTS × BLOCKS_PER_YEAR)
            const ratePerBlockRay: u256 = SafeMath.div(
                SafeMath.mul(rateBps, RAY),
                SafeMath.mul(BASIS_POINTS, BLOCKS_PER_YEAR),
            );

            // indexDelta = oldIndex × ratePerBlockRay × Δblocks / RAY
            const oldIndex: u256   = borrowIndexStore.value;
            const indexDelta: u256 = SafeMath.div(
                SafeMath.mul(SafeMath.mul(oldIndex, ratePerBlockRay), blocksDelta),
                RAY,
            );

            // interestEarned = totalBorrowed × indexDelta / oldIndex
            const interestEarned: u256 = SafeMath.div(
                SafeMath.mul(totalBorrowedStore.value, indexDelta),
                oldIndex,
            );

            // Distribute to pool (depositors)
            const totalDepositsStore: StoredU256 = this._totalDeposits(token);
            totalDepositsStore.set(SafeMath.add(totalDepositsStore.value, interestEarned));

            // Charge borrowers
            totalBorrowedStore.set(SafeMath.add(totalBorrowedStore.value, interestEarned));

            // Advance global borrow index
            borrowIndexStore.set(SafeMath.add(oldIndex, indexDelta));
        }

        lastUpdateStore.set(currentBlock);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL — THREE-SLOPE INTEREST RATE MODEL
    // ─────────────────────────────────────────────────────────────────────────

    private _interestRate(utilBps: u256): u256 {
        if (u256.le(utilBps, KINK1_UTIL)) {
            // Slope 1: 2% → 6%   (util 0–50%)
            return SafeMath.add(
                RATE_AT_ZERO,
                SafeMath.div(SafeMath.mul(utilBps, SLOPE1_DELTA), KINK1_UTIL),
            );
        }
        if (u256.le(utilBps, KINK2_UTIL)) {
            // Slope 2: 6% → 12%  (util 50–80%)
            const excess: u256 = SafeMath.sub(utilBps, KINK1_UTIL);
            return SafeMath.add(
                RATE_AT_KINK1,
                SafeMath.div(SafeMath.mul(excess, SLOPE2_DELTA), SLOPE2_RANGE),
            );
        }
        // Slope 3: 12% → 30%+ (util > 80%)
        const excess: u256 = SafeMath.sub(utilBps, KINK2_UTIL);
        return SafeMath.add(
            RATE_AT_KINK2,
            SafeMath.div(SafeMath.mul(excess, SLOPE3_DELTA), SLOPE3_RANGE),
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL — RISK ENGINE
    // ─────────────────────────────────────────────────────────────────────────

    private _computeHF(user: Address): u256 {
        const borrowVal: u256 = this._totalBorrowValue(user);
        if (u256.eq(borrowVal, u256.Zero)) return u256.Max;
        return SafeMath.div(
            SafeMath.mul(SafeMath.mul(this._totalCollateralValue(user), LIQUIDATION_THRESHOLD_BPS), RAY),
            SafeMath.mul(borrowVal, BASIS_POINTS),
        );
    }

    private _simulatedHF(user: Address, overrideToken: u8, newTokenBalance: u256): u256 {
        const borrowVal: u256 = this._totalBorrowValue(user);
        if (u256.eq(borrowVal, u256.Zero)) return u256.Max;
        return SafeMath.div(
            SafeMath.mul(
                SafeMath.mul(this._simulatedCollateralValue(user, overrideToken, newTokenBalance), LIQUIDATION_THRESHOLD_BPS),
                RAY,
            ),
            SafeMath.mul(borrowVal, BASIS_POINTS),
        );
    }

    private _simulatedHFAfterBorrow(user: Address, extraToken: u8, extraAmount: u256): u256 {
        const collatVal: u256  = this._totalCollateralValue(user);
        const extraValue: u256 = SafeMath.div(
            SafeMath.mul(extraAmount, this._price(extraToken)),
            u256.fromU32(100000000),
        );
        const newBorrowVal: u256 = SafeMath.add(this._totalBorrowValue(user), extraValue);
        if (u256.eq(newBorrowVal, u256.Zero)) return u256.Max;
        return SafeMath.div(
            SafeMath.mul(SafeMath.mul(collatVal, LIQUIDATION_THRESHOLD_BPS), RAY),
            SafeMath.mul(newBorrowVal, BASIS_POINTS),
        );
    }

    private _totalCollateralValue(user: Address): u256 {
        let total: u256 = u256.Zero;
        const scale: u256 = u256.fromU32(100000000);
        if (u256.eq(this.userBtcCollateral.get(user), u256.One)) {
            total = SafeMath.add(total,
                SafeMath.div(SafeMath.mul(this._userTokenBalance(user, POOL_BTC), this.priceBtc.value), scale));
        }
        if (u256.eq(this.userMotoCollateral.get(user), u256.One)) {
            total = SafeMath.add(total,
                SafeMath.div(SafeMath.mul(this._userTokenBalance(user, POOL_MOTO), this.priceMoto.value), scale));
        }
        if (u256.eq(this.userPillCollateral.get(user), u256.One)) {
            total = SafeMath.add(total,
                SafeMath.div(SafeMath.mul(this._userTokenBalance(user, POOL_PILL), this.pricePill.value), scale));
        }
        return total;
    }

    private _simulatedCollateralValue(user: Address, overrideToken: u8, overrideBal: u256): u256 {
        let total: u256 = u256.Zero;
        const scale: u256 = u256.fromU32(100000000);
        const btcBal: u256  = overrideToken === POOL_BTC  ? overrideBal : this._userTokenBalance(user, POOL_BTC);
        const motoBal: u256 = overrideToken === POOL_MOTO ? overrideBal : this._userTokenBalance(user, POOL_MOTO);
        const pillBal: u256 = overrideToken === POOL_PILL ? overrideBal : this._userTokenBalance(user, POOL_PILL);
        if (u256.eq(this.userBtcCollateral.get(user),  u256.One)) {
            total = SafeMath.add(total, SafeMath.div(SafeMath.mul(btcBal,  this.priceBtc.value),  scale));
        }
        if (u256.eq(this.userMotoCollateral.get(user), u256.One)) {
            total = SafeMath.add(total, SafeMath.div(SafeMath.mul(motoBal, this.priceMoto.value), scale));
        }
        if (u256.eq(this.userPillCollateral.get(user), u256.One)) {
            total = SafeMath.add(total, SafeMath.div(SafeMath.mul(pillBal, this.pricePill.value), scale));
        }
        return total;
    }

    private _totalBorrowValue(user: Address): u256 {
        let total: u256 = u256.Zero;
        const scale: u256 = u256.fromU32(100000000);
        total = SafeMath.add(total, SafeMath.div(SafeMath.mul(this._compoundedDebt(user, POOL_BTC),  this.priceBtc.value),  scale));
        total = SafeMath.add(total, SafeMath.div(SafeMath.mul(this._compoundedDebt(user, POOL_MOTO), this.priceMoto.value), scale));
        total = SafeMath.add(total, SafeMath.div(SafeMath.mul(this._compoundedDebt(user, POOL_PILL), this.pricePill.value), scale));
        return total;
    }

    private _compoundedDebt(user: Address, token: u8): u256 {
        const principal: u256 = this._borrowMap(token).get(user);
        if (u256.eq(principal, u256.Zero)) return u256.Zero;
        const idxSnap: u256   = this._borrowIdxMap(token).get(user);
        if (u256.eq(idxSnap, u256.Zero)) return u256.Zero;
        return SafeMath.div(SafeMath.mul(principal, this._borrowIndex(token).value), idxSnap);
    }

    private _hasBorrows(user: Address): boolean {
        return (
            !u256.eq(this.userBtcBorrow.get(user),  u256.Zero) ||
            !u256.eq(this.userMotoBorrow.get(user), u256.Zero) ||
            !u256.eq(this.userPillBorrow.get(user), u256.Zero)
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL — COLLATERAL VALIDATION
    // ─────────────────────────────────────────────────────────────────────────

    private _requireValidCollateral(caller: Address, borrowToken: u8): void {
        let hasValidCollateral: boolean = false;
        if (borrowToken === POOL_BTC) {
            hasValidCollateral =
                (u256.eq(this.userMotoCollateral.get(caller), u256.One) &&
                 !u256.eq(this._userTokenBalance(caller, POOL_MOTO), u256.Zero)) ||
                (u256.eq(this.userPillCollateral.get(caller), u256.One) &&
                 !u256.eq(this._userTokenBalance(caller, POOL_PILL), u256.Zero));
        } else {
            hasValidCollateral =
                u256.eq(this.userBtcCollateral.get(caller), u256.One) &&
                !u256.eq(this._userTokenBalance(caller, POOL_BTC), u256.Zero);
        }
        if (!hasValidCollateral) throw new Revert('LEND: no valid collateral for this borrow');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL — INTEREST RATE MODEL COMPUTATION
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * _computePoolRates — compute all 8 interest rate metrics for one pool.
     *
     * Pure read — no state mutations. Results are live (computed from current
     * storage) so they automatically reflect any preceding deposit, borrow,
     * repay, or withdrawal in the same block.
     *
     * Formulas:
     *   utilizationRate  = totalBorrowed / totalDeposits  [basis points]
     *   borrowAPR        = _interestRate(utilizationRate)  [basis points]
     *   supplyAPR        = borrowAPR × utilization / 10 000
     *   borrowAPY        = _approximateAPY(borrowAPR)
     *   supplyAPY        = _approximateAPY(supplyAPR)
     *
     * supplyAPR derivation:
     *   Every block, interest earned = totalBorrowed × ratePerBlock.
     *   Depositors receive that interest, but it is spread across ALL deposits
     *   (both lent and idle). So the depositor's effective rate is:
     *     supplyAPR = borrowAPR × (totalBorrowed / totalDeposits)
     *               = borrowAPR × utilization / 10 000
     */
    private _computePoolRates(token: u8): PoolRates {
        const rates = new PoolRates();

        const totalDep: u256 = this._totalDeposits(token).value;
        const totalBor: u256 = this._totalBorrowed(token).value;

        rates.totalDeposits  = totalDep;
        rates.totalBorrowed  = totalBor;
        rates.availLiquidity = this._availableLiquidity(token);

        // Utilization: 0 if pool empty; capped at 10 000 bp (100%)
        if (u256.eq(totalDep, u256.Zero)) {
            rates.utilizationRate = u256.Zero;
            rates.borrowAPR       = RATE_AT_ZERO; // base rate even when empty
            rates.supplyAPR       = u256.Zero;    // no depositors earning
        } else {
            const util: u256 = u256.ge(totalBor, totalDep)
                ? BASIS_POINTS
                : SafeMath.div(SafeMath.mul(totalBor, BASIS_POINTS), totalDep);

            rates.utilizationRate = util;
            rates.borrowAPR       = this._interestRate(util);

            // supplyAPR = borrowAPR × utilization / 10 000
            rates.supplyAPR = SafeMath.div(
                SafeMath.mul(rates.borrowAPR, util),
                BASIS_POINTS,
            );
        }

        rates.borrowAPY = this._approximateAPY(rates.borrowAPR);
        rates.supplyAPY = this._approximateAPY(rates.supplyAPR);

        return rates;
    }

    /**
     * _approximateAPY — convert an annual rate in basis points to its
     * approximate compound APY using a quadratic Taylor approximation.
     *
     * Continuous compounding: APY = e^(APR/10000) − 1
     * First two Taylor terms: APY ≈ APR/10000 + (APR/10000)²/2
     * Back to basis points:   APY_bp ≈ APR + APR² / (2 × 10000)
     *
     * Error vs exact continuous compounding:
     *   APR =  200 bp (2%)  → error < 0.002%
     *   APR =  600 bp (6%)  → error < 0.02%
     *   APR = 1200 bp (12%) → error < 0.07%
     *   APR = 3000 bp (30%) → error < 0.5%
     *
     * Example:
     *   borrowAPR = 1200 bp (12%)
     *   quadTerm  = 1200 × 1200 / 20 000 = 1 440 000 / 20 000 = 72 bp
     *   borrowAPY ≈ 1200 + 72 = 1272 bp (12.72%)
     *   Exact continuous: e^0.12 − 1 = 12.75% ✓
     *
     *   supplyAPR = 1200 × 8000/10000 = 960 bp (9.6%)
     *   quadTerm  = 960 × 960 / 20 000 = 46 bp
     *   supplyAPY ≈ 960 + 46 = 1006 bp (10.06%)
     */
    private _approximateAPY(aprBps: u256): u256 {
        if (u256.eq(aprBps, u256.Zero)) return u256.Zero;
        // quadTerm = APR² / (2 × BASIS_POINTS)
        const quadTerm: u256 = SafeMath.div(
            SafeMath.mul(aprBps, aprBps),
            SafeMath.mul(u256.fromU32(2), BASIS_POINTS),
        );
        return SafeMath.add(aprBps, quadTerm);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL — POOL MATHS
    // ─────────────────────────────────────────────────────────────────────────

    private _utilizationRate(token: u8): u256 {
        const deposits: u256 = this._totalDeposits(token).value;
        if (u256.eq(deposits, u256.Zero)) return u256.Zero;
        const borrowed: u256 = this._totalBorrowed(token).value;
        if (u256.ge(borrowed, deposits)) return BASIS_POINTS; // cap at 100%
        return SafeMath.div(SafeMath.mul(borrowed, BASIS_POINTS), deposits);
    }

    private _availableLiquidity(token: u8): u256 {
        const deposits: u256 = this._totalDeposits(token).value;
        const borrowed: u256 = this._totalBorrowed(token).value;
        if (u256.ge(borrowed, deposits)) return u256.Zero;
        return SafeMath.sub(deposits, borrowed);
    }

    /** tokenBalance = userShares × totalDeposits / totalShares */
    private _userTokenBalance(user: Address, token: u8): u256 {
        const shares: u256   = this._sharesMap(token).get(user);
        const totalSh: u256  = this._totalShares(token).value;
        const totalDep: u256 = this._totalDeposits(token).value;
        if (u256.eq(shares, u256.Zero) || u256.eq(totalSh, u256.Zero)) return u256.Zero;
        return SafeMath.div(SafeMath.mul(shares, totalDep), totalSh);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL — OP-20 CROSS-CONTRACT STUBS
    // ─────────────────────────────────────────────────────────────────────────

    private _pullOP20(token: u8, from: Address, amount: u256): void {
        const tokenAddr: string = token === POOL_MOTO
            ? this.motoAddress.value : this.pillAddress.value;
        if (tokenAddr === '') throw new Revert('LEND: token address not configured');
        // TODO: Blockchain.callContract(Address.fromHexString(tokenAddr),
        //         encodeSelector('transferFrom(address,address,uint256)'), [from, contractAddress, amount])
    }

    private _pushOP20(token: u8, to: Address, amount: u256): void {
        const tokenAddr: string = token === POOL_MOTO
            ? this.motoAddress.value : this.pillAddress.value;
        if (tokenAddr === '') throw new Revert('LEND: token address not configured');
        // TODO: Blockchain.callContract(Address.fromHexString(tokenAddr),
        //         encodeSelector('transfer(address,uint256)'), [to, amount])
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL — STORAGE DISPATCHERS
    // ─────────────────────────────────────────────────────────────────────────

    private _totalDeposits(token: u8): StoredU256 {
        if (token === POOL_BTC)       return this.btcTotalDeposits;
        else if (token === POOL_MOTO) return this.motoTotalDeposits;
        else                          return this.pillTotalDeposits;
    }
    private _totalBorrowed(token: u8): StoredU256 {
        if (token === POOL_BTC)       return this.btcTotalBorrowed;
        else if (token === POOL_MOTO) return this.motoTotalBorrowed;
        else                          return this.pillTotalBorrowed;
    }
    private _lastUpdate(token: u8): StoredU256 {
        if (token === POOL_BTC)       return this.btcLastUpdate;
        else if (token === POOL_MOTO) return this.motoLastUpdate;
        else                          return this.pillLastUpdate;
    }
    private _borrowIndex(token: u8): StoredU256 {
        if (token === POOL_BTC)       return this.btcBorrowIndex;
        else if (token === POOL_MOTO) return this.motoBorrowIndex;
        else                          return this.pillBorrowIndex;
    }
    private _totalShares(token: u8): StoredU256 {
        if (token === POOL_BTC)       return this.btcTotalShares;
        else if (token === POOL_MOTO) return this.motoTotalShares;
        else                          return this.pillTotalShares;
    }
    private _sharesMap(token: u8): AddressMemoryMap {
        if (token === POOL_BTC)       return this.userBtcShares;
        else if (token === POOL_MOTO) return this.userMotoShares;
        else                          return this.userPillShares;
    }
    private _borrowMap(token: u8): AddressMemoryMap {
        if (token === POOL_BTC)       return this.userBtcBorrow;
        else if (token === POOL_MOTO) return this.userMotoBorrow;
        else                          return this.userPillBorrow;
    }
    private _borrowIdxMap(token: u8): AddressMemoryMap {
        if (token === POOL_BTC)       return this.userBtcBorrowIdx;
        else if (token === POOL_MOTO) return this.userMotoBorrowIdx;
        else                          return this.userPillBorrowIdx;
    }
    private _collateralMap(token: u8): AddressMemoryMap {
        if (token === POOL_BTC)       return this.userBtcCollateral;
        else if (token === POOL_MOTO) return this.userMotoCollateral;
        else                          return this.userPillCollateral;
    }
    private _netDepositMap(token: u8): AddressMemoryMap {
        if (token === POOL_BTC)       return this.userBtcNetDeposit;
        else if (token === POOL_MOTO) return this.userMotoNetDeposit;
        else                          return this.userPillNetDeposit;
    }
    private _depositBlockMap(token: u8): AddressMemoryMap {
        if (token === POOL_BTC)       return this.userBtcDepositBlock;
        else if (token === POOL_MOTO) return this.userMotoDepositBlock;
        else                          return this.userPillDepositBlock;
    }
    private _price(token: u8): u256 {
        if (token === POOL_BTC)       return this.priceBtc.value;
        else if (token === POOL_MOTO) return this.priceMoto.value;
        else                          return this.pricePill.value;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // INTERNAL — ACCESS CONTROL & VALIDATION
    // ─────────────────────────────────────────────────────────────────────────

    private _requireNotPaused(): void {
        if (this.paused.value) throw new Revert('LEND: protocol paused');
    }
    private _requireAdmin(): void {
        if (this.adminAddress.value !== Blockchain.tx.sender.toHex()) {
            throw new Revert('LEND: caller is not admin');
        }
    }
    private _requireValidPool(token: u8): void {
        if (token !== POOL_BTC && token !== POOL_MOTO && token !== POOL_PILL) {
            throw new Revert('LEND: invalid pool token id');
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// VALUE OBJECT — DepositPosition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-memory struct returned by _computeDepositPosition.
 * AssemblyScript classes without constructors that reference `this` work as
 * plain value holders for intermediate computation results.
 */
class DepositPosition {
    netDeposited:     u256 = u256.Zero;
    shares:           u256 = u256.Zero;
    tokenBalance:     u256 = u256.Zero;
    earnedInterest:   u256 = u256.Zero;
    currentAPR:       u256 = u256.Zero;
    estimatedAPY:     u256 = u256.Zero;
    historicalAPYBps: u256 = u256.Zero;
    firstDepositBlock:u256 = u256.Zero;
}

// ─────────────────────────────────────────────────────────────────────────────
// VALUE OBJECT — BorrowPosition
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-memory struct returned by _computeBorrowPosition.
 * All monetary values are in raw token units (debt) or satoshis (value fields).
 *
 * Fields:
 *   userDebt             — compounded debt tokens in this pool
 *   userCollateral       — total collateral value in satoshis (all pools)
 *   debtValueInSats      — this pool's debt converted to satoshis at oracle price
 *   totalBorrowValueSats — all-pool combined debt in satoshis
 *   loanToValueRatio     — totalBorrowValue / collateral × 10 000 (max ~6 666 bp)
 *   interestRate         — pool's current annual APR in basis points
 *   healthFactor         — overall HF in RAY precision (1.2×10^18 = boundary)
 *   maxBorrowable        — additional token units the user can borrow from this pool
 *   isLiquidatable       — 1 if HF < 1.2×RAY and user has open debt, 0 otherwise
 */
class BorrowPosition {
    userDebt:             u256 = u256.Zero;
    userCollateral:       u256 = u256.Zero;
    debtValueInSats:      u256 = u256.Zero;
    totalBorrowValueSats: u256 = u256.Zero;
    loanToValueRatio:     u256 = u256.Zero;
    interestRate:         u256 = u256.Zero;
    healthFactor:         u256 = u256.Zero;
    maxBorrowable:        u256 = u256.Zero;
    isLiquidatable:       u256 = u256.Zero;
}

// ─────────────────────────────────────────────────────────────────────────────
// VALUE OBJECT — LiquidationResult
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Intermediate computation result produced by _computeLiquidationResult().
 * Used by both _liquidate() (to apply state changes) and _previewLiquidation()
 * (to return data without touching state).
 *
 * rejectReason codes:
 *   0 = ok — liquidation can proceed
 *   1 = borrower is healthy (HF ≥ 1.2) — not liquidatable
 *   2 = borrower has no debt in the specified borrow pool
 *   3 = borrower has insufficient collateral balance to cover seizure
 */
class LiquidationResult {
    isAllowed:        u256 = u256.Zero; // 1 = proceed, 0 = blocked
    rejectReason:     u256 = u256.Zero; // 0=ok 1=healthy 2=no-debt 3=low-collat
    actualDebtRepaid: u256 = u256.Zero; // debt tokens repaid (≤ 50% of compounded)
    collatBase:       u256 = u256.Zero; // collateral equiv of debt (before bonus)
    bonusAmount:      u256 = u256.Zero; // 5% liquidation bonus
    collateralSeized: u256 = u256.Zero; // collatBase + bonusAmount
    hfAfter:          u256 = u256.Zero; // borrower HF after liquidation (RAY)
    riskAfter:        u256 = u256.Zero; // borrower risk tier after liquidation
}

// ─────────────────────────────────────────────────────────────────────────────
// VALUE OBJECT — PoolRates
// ─────────────────────────────────────────────────────────────────────────────

/**
 * In-memory struct returned by _computePoolRates(token).
 * Holds all interest rate model outputs for one lending pool.
 *
 * All rate fields are in basis points (10 000 = 100%).
 *
 * borrowAPR:       Annual borrow rate from three-slope curve.
 *                  Automatically adjusts as utilization changes.
 *
 * supplyAPR:       Annual earn rate for depositors.
 *                  = borrowAPR × utilization / 10 000
 *                  Lower than borrowAPR because idle deposits dilute the rate.
 *
 * borrowAPY:       Compound annual borrow yield (continuous approximation).
 *                  ≈ borrowAPR + borrowAPR² / (2 × 10 000)
 *
 * supplyAPY:       Compound annual depositor yield.
 *                  ≈ supplyAPR + supplyAPR² / (2 × 10 000)
 *
 * utilizationRate: totalBorrowed / totalDeposits × 10 000 (basis points).
 *                  0 = empty pool; 10 000 = fully utilised.
 *                  Higher utilization → higher rates → attracts more liquidity.
 *
 * totalDeposits:   Pool size (original deposits + accrued interest).
 * totalBorrowed:   Outstanding compounded debt.
 * availLiquidity:  totalDeposits − totalBorrowed (immediately borrowable).
 */
class PoolRates {
    borrowAPR:       u256 = u256.Zero;
    supplyAPR:       u256 = u256.Zero;
    borrowAPY:       u256 = u256.Zero;
    supplyAPY:       u256 = u256.Zero;
    utilizationRate: u256 = u256.Zero;
    totalDeposits:   u256 = u256.Zero;
    totalBorrowed:   u256 = u256.Zero;
    availLiquidity:  u256 = u256.Zero;
}
