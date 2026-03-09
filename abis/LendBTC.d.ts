import { Address, AddressMap, ExtendedAddressMap, SchnorrSignature } from '@btc-vision/transaction';
import { CallResult, OPNetEvent, IOP_NETContract } from 'opnet';

// ------------------------------------------------------------------
// Event Definitions
// ------------------------------------------------------------------

// ------------------------------------------------------------------
// Call Results
// ------------------------------------------------------------------

/**
 * @description Represents the result of the _deposit function call.
 */
export type deposit = CallResult<
    {
        sharesReceived: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _addCollateral function call.
 */
export type addCollateral = CallResult<
    {
        sharesReceived: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _withdrawCollateral function call.
 */
export type withdrawCollateral = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _withdraw function call.
 */
export type withdraw = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _getDepositPosition function call.
 */
export type getDepositPosition = CallResult<
    {
        netDeposited: bigint;
        shares: bigint;
        tokenBalance: bigint;
        earnedInterest: bigint;
        currentAPR: bigint;
        estimatedAPY: bigint;
        historicalAPYBps: bigint;
        firstDepositBlock: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _getAllDepositPositions function call.
 */
export type getAllDepositPositions = CallResult<
    {
        btcNetDeposited: bigint;
        btcShares: bigint;
        btcTokenBalance: bigint;
        btcEarned: bigint;
        btcCurrentAPR: bigint;
        btcEstimatedAPY: bigint;
        btcHistoricalAPY: bigint;
        btcDepositBlock: bigint;
        motoNetDeposited: bigint;
        motoShares: bigint;
        motoTokenBalance: bigint;
        motoEarned: bigint;
        motoCurrentAPR: bigint;
        motoEstimatedAPY: bigint;
        motoHistoricalAPY: bigint;
        motoDepositBlock: bigint;
        pillNetDeposited: bigint;
        pillShares: bigint;
        pillTokenBalance: bigint;
        pillEarned: bigint;
        pillCurrentAPR: bigint;
        pillEstimatedAPY: bigint;
        pillHistoricalAPY: bigint;
        pillDepositBlock: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _getInterestRates function call.
 */
export type getInterestRates = CallResult<
    {
        borrowAPR: bigint;
        supplyAPR: bigint;
        borrowAPY: bigint;
        supplyAPY: bigint;
        utilizationRate: bigint;
        totalDeposits: bigint;
        totalBorrowed: bigint;
        availLiquidity: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _getAllPoolRates function call.
 */
export type getAllPoolRates = CallResult<
    {
        btcBorrowAPR: bigint;
        btcSupplyAPR: bigint;
        btcBorrowAPY: bigint;
        btcSupplyAPY: bigint;
        btcUtilizationRate: bigint;
        btcTotalDeposits: bigint;
        btcTotalBorrowed: bigint;
        btcAvailLiquidity: bigint;
        motoBorrowAPR: bigint;
        motoSupplyAPR: bigint;
        motoBorrowAPY: bigint;
        motoSupplyAPY: bigint;
        motoUtilizationRate: bigint;
        motoTotalDeposits: bigint;
        motoTotalBorrowed: bigint;
        motoAvailLiquidity: bigint;
        pillBorrowAPR: bigint;
        pillSupplyAPR: bigint;
        pillBorrowAPY: bigint;
        pillSupplyAPY: bigint;
        pillUtilizationRate: bigint;
        pillTotalDeposits: bigint;
        pillTotalBorrowed: bigint;
        pillAvailLiquidity: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _getPoolInfo function call.
 */
export type getPoolInfo = CallResult<
    {
        totalDeposits: bigint;
        totalBorrowed: bigint;
        availableLiquidity: bigint;
        utilizationRate: bigint;
        interestRate: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _getExchangeRate function call.
 */
export type getExchangeRate = CallResult<
    {
        exchangeRate: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _borrow function call.
 */
export type borrow = CallResult<
    {
        collateralValue: bigint;
        borrowValue: bigint;
        ltvAfterBorrow: bigint;
        healthFactorAfter: bigint;
        riskStatus: bigint;
        loyaltyDiscountBps: bigint;
        loyaltyTier: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _repay function call.
 */
export type repay = CallResult<
    {
        actualRepaid: bigint;
        remainingDebt: bigint;
        healthFactor: bigint;
        riskStatus: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _getBorrowPosition function call.
 */
export type getBorrowPosition = CallResult<
    {
        userDebt: bigint;
        userCollateral: bigint;
        debtValueInSats: bigint;
        totalBorrowValueSats: bigint;
        loanToValueRatio: bigint;
        interestRate: bigint;
        healthFactor: bigint;
        maxBorrowable: bigint;
        isLiquidatable: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _getAllBorrowPositions function call.
 */
export type getAllBorrowPositions = CallResult<
    {
        btcDebt: bigint;
        btcCollateral: bigint;
        btcDebtValueSats: bigint;
        btcTotalBorrowSats: bigint;
        btcLTV: bigint;
        btcInterestRate: bigint;
        btcHealthFactor: bigint;
        btcMaxBorrowable: bigint;
        btcIsLiquidatable: bigint;
        motoDebt: bigint;
        motoCollateral: bigint;
        motoDebtValueSats: bigint;
        motoTotalBorrowSats: bigint;
        motoLTV: bigint;
        motoInterestRate: bigint;
        motoHealthFactor: bigint;
        motoMaxBorrowable: bigint;
        motoIsLiquidatable: bigint;
        pillDebt: bigint;
        pillCollateral: bigint;
        pillDebtValueSats: bigint;
        pillTotalBorrowSats: bigint;
        pillLTV: bigint;
        pillInterestRate: bigint;
        pillHealthFactor: bigint;
        pillMaxBorrowable: bigint;
        pillIsLiquidatable: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _previewBorrow function call.
 */
export type previewBorrow = CallResult<
    {
        isAllowed: bigint;
        rejectReason: bigint;
        collateralValue: bigint;
        currentBorrowValue: bigint;
        newBorrowValue: bigint;
        newHealthFactor: bigint;
        newLTV: bigint;
        maxBorrowable: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _liquidate function call.
 */
export type liquidate = CallResult<
    {
        collateralSeized: bigint;
        debtRepaid: bigint;
        liquidationBonus: bigint;
        borrowerHFAfter: bigint;
        borrowerRiskAfter: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _getLiquidationInfo function call.
 */
export type getLiquidationInfo = CallResult<
    {
        isLiquidatable: bigint;
        healthFactor: bigint;
        collateralValue: bigint;
        borrowValue: bigint;
        btcDebt: bigint;
        motoDebt: bigint;
        pillDebt: bigint;
        btcCollateral: bigint;
        motoCollateral: bigint;
        pillCollateral: bigint;
        maxLiquidatableBtc: bigint;
        maxLiquidatableMoto: bigint;
        maxLiquidatablePill: bigint;
        liquidationBonusBps: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _previewLiquidation function call.
 */
export type previewLiquidation = CallResult<
    {
        isAllowed: bigint;
        rejectReason: bigint;
        actualDebtRepaid: bigint;
        collatBase: bigint;
        bonusAmount: bigint;
        collateralSeized: bigint;
        borrowerHFAfter: bigint;
        borrowerRiskAfter: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _creditBtcDeposit function call.
 */
export type creditBtcDeposit = CallResult<
    {
        sharesReceived: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _getUserVault function call.
 */
export type getUserVault = CallResult<
    {
        collateralValue: bigint;
        borrowValue: bigint;
        healthFactor: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _getHealthFactor function call.
 */
export type getHealthFactor = CallResult<
    {
        healthFactor: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _setTokenAddresses function call.
 */
export type setTokenAddresses = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _setPrice function call.
 */
export type setPrice = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _setPaused function call.
 */
export type setPaused = CallResult<
    {
        success: boolean;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _getLoyaltyInfo function call.
 */
export type getLoyaltyInfo = CallResult<
    {
        motoBalance: bigint;
        loyaltyTier: bigint;
        discountBps: bigint;
        nextTierThreshold: bigint;
        nextTierDiscountBps: bigint;
        motoToNextTier: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _getEffectiveBorrowRate function call.
 */
export type getEffectiveBorrowRate = CallResult<
    {
        baseBorrowAPR: bigint;
        effectiveBorrowAPR: bigint;
        effectiveBorrowAPY: bigint;
        discountBps: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _getRiskStatus function call.
 */
export type getRiskStatus = CallResult<
    {
        collateralValue: bigint;
        borrowValue: bigint;
        healthFactor: bigint;
        loanToValueRatio: bigint;
        riskStatus: bigint;
        safeMaxBorrow: bigint;
        warningMaxBorrow: bigint;
        liquidationCollatValue: bigint;
        distanceToLiquidationBps: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _previewRisk2 function call.
 */
export type previewRisk2 = CallResult<
    {
        currentRiskStatus: bigint;
        newRiskStatus: bigint;
        currentHF: bigint;
        newHF: bigint;
        currentLTV: bigint;
        newLTV: bigint;
        currentBorrowValue: bigint;
        newBorrowValue: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _getRiskParameters function call.
 */
export type getRiskParameters = CallResult<
    {
        liquidationThreshold: bigint;
        hfLiquidationFloor: bigint;
        hfSafeThreshold: bigint;
        liquidationBonus: bigint;
        maxLiquidationPct: bigint;
        collateralRatioBps: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _getVault function call.
 */
export type getVault = CallResult<
    {
        totalCollateralValue: bigint;
        totalBorrowValue: bigint;
        healthFactor: bigint;
        loanToValueRatio: bigint;
        liquidationThreshold: bigint;
        liquidationHFThreshold: bigint;
        availableCredit: bigint;
        isLiquidatable: bigint;
        btcCollateralBalance: bigint;
        motoCollateralBalance: bigint;
        pillCollateralBalance: bigint;
        btcDebtBalance: bigint;
        motoDebtBalance: bigint;
        pillDebtBalance: bigint;
        btcCollateralEnabled: bigint;
        motoCollateralEnabled: bigint;
        pillCollateralEnabled: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _stakePill function call.
 */
export type stakePill = CallResult<
    {
        totalStaked: bigint;
        protectionActive: bigint;
        liqThreshold: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _unstakePill function call.
 */
export type unstakePill = CallResult<
    {
        totalStaked: bigint;
        protectionActive: bigint;
        liqThreshold: bigint;
        healthFactor: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _getPillProtection function call.
 */
export type getPillProtection = CallResult<
    {
        pillStaked: bigint;
        protectionActive: bigint;
        liqThreshold: bigint;
        minStakeRequired: bigint;
        pillToActivate: bigint;
        healthFactor: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _openLoop function call.
 */
export type openLoop = CallResult<
    {
        loopLevel: number;
        initialBtcDeposit: bigint;
        motoBorrowed: bigint;
        totalBtcExposure: bigint;
        totalCollatSats: bigint;
        healthFactor: bigint;
        riskStatus: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _closeLoop function call.
 */
export type closeLoop = CallResult<
    {
        wasActive: bigint;
        motoDebt: bigint;
        btcBalance: bigint;
        healthFactor: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _getLoopMetrics function call.
 */
export type getLoopMetrics = CallResult<
    {
        loopLevel: number;
        isActive: bigint;
        initialBtcDeposit: bigint;
        currentBtcBalance: bigint;
        loopedBtcAdded: bigint;
        motoBorrowed: bigint;
        totalCollatSats: bigint;
        healthFactor: bigint;
    },
    OPNetEvent<never>[]
>;

/**
 * @description Represents the result of the _previewLoop function call.
 */
export type previewLoop = CallResult<
    {
        projectedMotoToBorrow: bigint;
        projectedBtcToAdd: bigint;
        projectedTotalCollatSats: bigint;
        projectedBorrowSats: bigint;
        projectedHF: bigint;
        projectedRiskStatus: bigint;
        isSafe: bigint;
    },
    OPNetEvent<never>[]
>;

// ------------------------------------------------------------------
// ILendBTC
// ------------------------------------------------------------------
export interface ILendBTC extends IOP_NETContract {
    _deposit(token: number, amount: bigint): Promise<deposit>;
    _addCollateral(token: number, amount: bigint): Promise<addCollateral>;
    _withdrawCollateral(token: number, amount: bigint): Promise<withdrawCollateral>;
    _withdraw(token: number, amount: bigint): Promise<withdraw>;
    _getDepositPosition(user: Address, token: number): Promise<getDepositPosition>;
    _getAllDepositPositions(user: Address): Promise<getAllDepositPositions>;
    _getInterestRates(token: number): Promise<getInterestRates>;
    _getAllPoolRates(): Promise<getAllPoolRates>;
    _getPoolInfo(token: number): Promise<getPoolInfo>;
    _getExchangeRate(token: number): Promise<getExchangeRate>;
    _borrow(token: number, amount: bigint): Promise<borrow>;
    _repay(token: number, amount: bigint): Promise<repay>;
    _getBorrowPosition(user: Address, token: number): Promise<getBorrowPosition>;
    _getAllBorrowPositions(user: Address): Promise<getAllBorrowPositions>;
    _previewBorrow(token: number, amount: bigint): Promise<previewBorrow>;
    _liquidate(borrower: Address, collateralToken: number, borrowToken: number, debtAmount: bigint): Promise<liquidate>;
    _getLiquidationInfo(borrower: Address): Promise<getLiquidationInfo>;
    _previewLiquidation(
        borrower: Address,
        collateralToken: number,
        borrowToken: number,
        debtAmount: bigint,
    ): Promise<previewLiquidation>;
    _creditBtcDeposit(user: Address, amount: bigint): Promise<creditBtcDeposit>;
    _getUserVault(user: Address): Promise<getUserVault>;
    _getHealthFactor(user: Address): Promise<getHealthFactor>;
    _setTokenAddresses(motoAddress: Address, pillAddress: Address): Promise<setTokenAddresses>;
    _setPrice(token: number, price: bigint): Promise<setPrice>;
    _setPaused(paused: boolean): Promise<setPaused>;
    _getLoyaltyInfo(user: Address): Promise<getLoyaltyInfo>;
    _getEffectiveBorrowRate(token: number): Promise<getEffectiveBorrowRate>;
    _getRiskStatus(user: Address): Promise<getRiskStatus>;
    _previewRisk2(action: number, token: number, amount: bigint): Promise<previewRisk2>;
    _getRiskParameters(): Promise<getRiskParameters>;
    _getVault(user: Address): Promise<getVault>;
    _stakePill(amount: bigint): Promise<stakePill>;
    _unstakePill(amount: bigint): Promise<unstakePill>;
    _getPillProtection(user: Address): Promise<getPillProtection>;
    _openLoop(loopLevel: number): Promise<openLoop>;
    _closeLoop(): Promise<closeLoop>;
    _getLoopMetrics(user: Address): Promise<getLoopMetrics>;
    _previewLoop(loopLevel: number): Promise<previewLoop>;
}
