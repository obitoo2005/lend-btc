// frontend/src/contract.js
import { CONTRACT_ADDRESS, POOL_BTC, POOL_MOTO, POOL_PILL, RAY, SAT_SCALE } from './config.js';
import { selector, concat, encodeU8, encodeU256, encodeBool, encodeAddress, toHex, Decoder } from './encode.js';
import { callContract } from './rpc.js';
import { walletService } from './wallet.js';

// Selector cache
const _selectors = {};

async function sel(sig) {
  if (!_selectors[sig]) _selectors[sig] = toHex(await selector(sig));
  return _selectors[sig];
}

async function readCall(sig, params = new Uint8Array(0)) {
  const s = await sel(sig);
  const calldata = s + toHex(params);
  const from = walletService.address ?? '0x0000000000000000000000000000000000000000000000000000000000000000';
  const result = await callContract(CONTRACT_ADDRESS, calldata, from);
  if (!result || result.error) throw new Error(result?.error ?? 'RPC call failed');
  // result.result is hex of returned bytes
  return new Decoder(result.result ?? result);
}

// Helper: bps to percentage (e.g. 420n → 4.2)
export function bpsToPercent(bps) { return Number(bps) / 100; }
// Helper: RAY to float (e.g. 1_847_000_000_000_000_000n → 1.847)
export function rayToFloat(ray) { return Number(ray) / 1e18; }
// Helper: sats to BTC
export function satsToBtc(sats) { return Number(sats) / 1e8; }
// Helper: token units (8 decimals) to display number
export function unitsToToken(u) { return Number(u) / 1e8; }

export const contract = {
  // ── Pool views ──────────────────────────────────────────────────────────────
  async getAllPoolRates() {
    const d = await readCall('getAllPoolRates()');
    return {
      btc:  { borrowAPR: bpsToPercent(d.readU256()), supplyAPR: bpsToPercent(d.readU256()), borrowAPY: bpsToPercent(d.readU256()), supplyAPY: bpsToPercent(d.readU256()), utilization: bpsToPercent(d.readU256()), totalDeposits: unitsToToken(d.readU256()), totalBorrowed: unitsToToken(d.readU256()), availLiquidity: unitsToToken(d.readU256()) },
      moto: { borrowAPR: bpsToPercent(d.readU256()), supplyAPR: bpsToPercent(d.readU256()), borrowAPY: bpsToPercent(d.readU256()), supplyAPY: bpsToPercent(d.readU256()), utilization: bpsToPercent(d.readU256()), totalDeposits: unitsToToken(d.readU256()), totalBorrowed: unitsToToken(d.readU256()), availLiquidity: unitsToToken(d.readU256()) },
      pill: { borrowAPR: bpsToPercent(d.readU256()), supplyAPR: bpsToPercent(d.readU256()), borrowAPY: bpsToPercent(d.readU256()), supplyAPY: bpsToPercent(d.readU256()), utilization: bpsToPercent(d.readU256()), totalDeposits: unitsToToken(d.readU256()), totalBorrowed: unitsToToken(d.readU256()), availLiquidity: unitsToToken(d.readU256()) },
    };
  },

  async getAllDepositPositions(userAddress) {
    const params = encodeAddress(userAddress);
    const d = await readCall('getAllDepositPositions(address)', params);
    const readPos = () => ({
      netDeposited: unitsToToken(d.readU256()),
      shares: d.readU256(),
      tokenBalance: unitsToToken(d.readU256()),
      earnedInterest: unitsToToken(d.readU256()),
      currentAPR: bpsToPercent(d.readU256()),
      estimatedAPY: bpsToPercent(d.readU256()),
      historicalAPY: bpsToPercent(d.readU256()),
      firstDepositBlock: d.readU256(),
    });
    return { btc: readPos(), moto: readPos(), pill: readPos() };
  },

  async getAllBorrowPositions(userAddress) {
    const params = encodeAddress(userAddress);
    const d = await readCall('getAllBorrowPositions(address)', params);
    const readPos = () => ({
      principal: unitsToToken(d.readU256()),
      compoundedDebt: unitsToToken(d.readU256()),
      borrowIndex: d.readU256(),
      indexSnapshot: d.readU256(),
      accruedInterest: unitsToToken(d.readU256()),
      collateralValueSats: Number(d.readU256()),
      borrowValueSats: Number(d.readU256()),
      ltv: bpsToPercent(d.readU256()),
      healthFactor: rayToFloat(d.readU256()),
    });
    return { btc: readPos(), moto: readPos(), pill: readPos() };
  },

  async getVault(userAddress) {
    const params = encodeAddress(userAddress);
    const d = await readCall('getVault(address)', params);
    return {
      btcBalance:            unitsToToken(d.readU256()),
      motoBalance:           unitsToToken(d.readU256()),
      pillBalance:           unitsToToken(d.readU256()),
      btcDebt:               unitsToToken(d.readU256()),
      motoDebt:              unitsToToken(d.readU256()),
      pillDebt:              unitsToToken(d.readU256()),
      totalCollatSats:       Number(d.readU256()),
      totalBorrowSats:       Number(d.readU256()),
      healthFactor:          rayToFloat(d.readU256()),
      ltv:                   bpsToPercent(d.readU256()),
      maxBorrowable:         Number(d.readU256()),
      isLiquidatable:        d.readU256() === 1n,
      btcCollateralEnabled:  d.readU256() !== 0n,
      motoCollateralEnabled: d.readU256() !== 0n,
      pillCollateralEnabled: d.readU256() !== 0n,
      effectiveLiqThresh:    rayToFloat(d.readU256()),
      riskStatus:            Number(d.readU256()),
    };
  },

  async getHealthFactor(userAddress) {
    const params = encodeAddress(userAddress);
    const d = await readCall('getHealthFactor(address)', params);
    return rayToFloat(d.readU256());
  },

  async getRiskStatus(userAddress) {
    const params = encodeAddress(userAddress);
    const d = await readCall('getRiskStatus(address)', params);
    return {
      riskStatus:             Number(d.readU256()),
      healthFactor:           rayToFloat(d.readU256()),
      collateralValue:        Number(d.readU256()),
      borrowValue:            Number(d.readU256()),
      ltv:                    bpsToPercent(d.readU256()),
      safeMaxBorrowable:      Number(d.readU256()),
      distanceToliqBps:       Number(d.readU256()),
      liquidationCollatValue: Number(d.readU256()),
      liqThreshold:           rayToFloat(d.readU256()),
    };
  },

  async getLoyaltyInfo(userAddress) {
    const params = encodeAddress(userAddress);
    const d = await readCall('getLoyaltyInfo(address)', params);
    return {
      tier:        Number(d.readU256()),
      motoBalance: unitsToToken(d.readU256()),
      discountBps: bpsToPercent(d.readU256()),
      tier1Min:    unitsToToken(d.readU256()),
      tier2Min:    unitsToToken(d.readU256()),
      tier3Min:    unitsToToken(d.readU256()),
    };
  },

  async getPillProtection(userAddress) {
    const params = encodeAddress(userAddress);
    const d = await readCall('getPillProtection(address)', params);
    return {
      pillStaked:       unitsToToken(d.readU256()),
      protectionActive: d.readU256() !== 0n,
      liqThreshold:     rayToFloat(d.readU256()),
      minStakeRequired: unitsToToken(d.readU256()),
      pillToActivate:   unitsToToken(d.readU256()),
      healthFactor:     rayToFloat(d.readU256()),
    };
  },

  async getLoopMetrics(userAddress) {
    const params = encodeAddress(userAddress);
    const d = await readCall('getLoopMetrics(address)', params);
    return {
      loopLevel:         d.readU8(),
      isActive:          d.readU256() !== 0n,
      initialBtcDeposit: unitsToToken(d.readU256()),
      currentBtcBalance: unitsToToken(d.readU256()),
      loopedBtcAdded:    unitsToToken(d.readU256()),
      motoBorrowed:      unitsToToken(d.readU256()),
      totalCollatSats:   Number(d.readU256()),
      healthFactor:      rayToFloat(d.readU256()),
    };
  },

  async previewLoop(loopLevel) {
    const params = encodeU8(loopLevel);
    const d = await readCall('previewLoop(uint8)', params);
    return {
      projectedMotoToBorrow:    unitsToToken(d.readU256()),
      projectedBtcToAdd:        unitsToToken(d.readU256()),
      projectedTotalCollatSats: Number(d.readU256()),
      projectedBorrowSats:      Number(d.readU256()),
      projectedHF:              rayToFloat(d.readU256()),
      projectedRiskStatus:      Number(d.readU256()),
      isSafe:                   d.readU256() !== 0n,
    };
  },

  async previewBorrow(token, amount) {
    const params = concat(encodeU8(token), encodeU256(amount));
    const d = await readCall('previewBorrow(uint8,uint256)', params);
    return {
      success:        d.readU256() !== 0n,
      rejectReason:   Number(d.readU256()),
      collatValue:    Number(d.readU256()),
      currentDebtVal: Number(d.readU256()),
      newDebtVal:     Number(d.readU256()),
      newHF:          rayToFloat(d.readU256()),
      newLTV:         bpsToPercent(d.readU256()),
      maxBorrowable:  unitsToToken(d.readU256()),
    };
  },

  async getLiquidationInfo(userAddress) {
    const params = encodeAddress(userAddress);
    const d = await readCall('getLiquidationInfo(address)', params);
    return {
      isLiquidatable:    d.readU256() !== 0n,
      healthFactor:      rayToFloat(d.readU256()),
      totalCollatSats:   Number(d.readU256()),
      totalBorrowSats:   Number(d.readU256()),
      btcDebt:           unitsToToken(d.readU256()),
      motoDebt:          unitsToToken(d.readU256()),
      pillDebt:          unitsToToken(d.readU256()),
      maxLiquidateBTC:   unitsToToken(d.readU256()),
      maxLiquidateMOTO:  unitsToToken(d.readU256()),
      maxLiquidatePILL:  unitsToToken(d.readU256()),
      liqThreshold:      rayToFloat(d.readU256()),
      riskStatus:        Number(d.readU256()),
      btcCollateralBal:  unitsToToken(d.readU256()),
      motoCollateralBal: unitsToToken(d.readU256()),
    };
  },

  async getRiskParameters() {
    const d = await readCall('getRiskParameters()');
    return {
      liquidationThresholdBps: Number(d.readU256()),
      hfLiquidationThreshold:  rayToFloat(d.readU256()),
      hfSafeThreshold:         rayToFloat(d.readU256()),
      liquidationBonusBps:     Number(d.readU256()),
      maxLiquidationBps:       Number(d.readU256()),
      collateralRatioBps:      Number(d.readU256()),
    };
  },

  // ── Write methods — encoded calldata, returned for wallet to sign ────────────
  // These return { selector, calldata } for building a tx outside this module.
  // The actual transaction building (PSBT construction) requires UTXOs and fees.
  // Here we expose the encoded calldata. The wallet module handles signing.

  async encodeDeposit(token, amountUnits) {
    const s = await sel('deposit(uint8,uint256)');
    const params = concat(encodeU8(token), encodeU256(amountUnits));
    return { selector: s, calldata: s + toHex(params) };
  },

  async encodeWithdraw(token, amountUnits) {
    const s = await sel('withdraw(uint8,uint256)');
    const params = concat(encodeU8(token), encodeU256(amountUnits));
    return { selector: s, calldata: s + toHex(params) };
  },

  async encodeBorrow(token, amountUnits) {
    const s = await sel('borrow(uint8,uint256)');
    const params = concat(encodeU8(token), encodeU256(amountUnits));
    return { selector: s, calldata: s + toHex(params) };
  },

  async encodeRepay(token, amountUnits) {
    const s = await sel('repay(uint8,uint256)');
    const params = concat(encodeU8(token), encodeU256(amountUnits));
    return { selector: s, calldata: s + toHex(params) };
  },

  async encodeStakePill(amountUnits) {
    const s = await sel('stakePill(uint256)');
    return { selector: s, calldata: s + toHex(encodeU256(amountUnits)) };
  },

  async encodeUnstakePill(amountUnits) {
    const s = await sel('unstakePill(uint256)');
    return { selector: s, calldata: s + toHex(encodeU256(amountUnits)) };
  },

  async encodeOpenLoop(loopLevel) {
    const s = await sel('openLoop(uint8)');
    return { selector: s, calldata: s + toHex(encodeU8(loopLevel)) };
  },

  async encodeCloseLoop() {
    const s = await sel('closeLoop()');
    return { selector: s, calldata: s };
  },
};
