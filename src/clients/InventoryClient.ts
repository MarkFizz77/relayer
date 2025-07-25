import { utils as sdkUtils } from "@across-protocol/sdk";
import WETH_ABI from "../common/abi/Weth.json";
import {
  bnZero,
  BigNumber,
  winston,
  toBN,
  getNetworkName,
  createFormatFunction,
  blockExplorerLink,
  Contract,
  formatUnits,
  runTransaction,
  isDefined,
  DefaultLogLevels,
  TransactionResponse,
  AnyObject,
  ERC20,
  TOKEN_SYMBOLS_MAP,
  formatFeePct,
  fixedPointAdjustment,
  bnComparatorDescending,
  MAX_UINT_VAL,
  toBNWei,
  assert,
  Profiler,
  getNativeTokenSymbol,
  getL1TokenAddress,
  depositForcesOriginChainRepayment,
  getRemoteTokenForL1Token,
  getTokenInfo,
  isEVMSpokePoolClient,
  EvmAddress,
  Address,
  toAddressType,
  repaymentChainCanBeQuicklyRebalanced,
} from "../utils";
import { HubPoolClient, TokenClient, BundleDataClient } from ".";
import { Deposit, ProposedRootBundle } from "../interfaces";
import { InventoryConfig, isAliasConfig, TokenBalanceConfig } from "../interfaces/InventoryManagement";
import lodash from "lodash";
import { SLOW_WITHDRAWAL_CHAINS } from "../common";
import { CombinedRefunds } from "../dataworker/DataworkerUtils";
import { AdapterManager, CrossChainTransferClient } from "./bridges";

type TokenDistribution = { [l2Token: string]: BigNumber };
type TokenDistributionPerL1Token = { [l1Token: string]: { [chainId: number]: TokenDistribution } };

export type Rebalance = {
  chainId: number;
  l1Token: EvmAddress;
  l2Token: Address;
  thresholdPct: BigNumber;
  targetPct: BigNumber;
  currentAllocPct: BigNumber;
  balance: BigNumber;
  cumulativeBalance: BigNumber;
  amount: BigNumber;
};

const DEFAULT_TOKEN_OVERAGE = toBNWei("1.5");

export class InventoryClient {
  private logDisabledManagement = false;
  private readonly scalar: BigNumber;
  private readonly formatWei: ReturnType<typeof createFormatFunction>;
  private bundleRefundsPromise: Promise<CombinedRefunds[]> = undefined;
  private excessRunningBalancePromises: { [l1Token: string]: Promise<{ [chainId: number]: BigNumber }> } = {};
  private profiler: InstanceType<typeof Profiler>;

  constructor(
    readonly relayer: EvmAddress,
    readonly logger: winston.Logger,
    readonly inventoryConfig: InventoryConfig,
    readonly tokenClient: TokenClient,
    readonly chainIdList: number[],
    readonly hubPoolClient: HubPoolClient,
    readonly bundleDataClient: BundleDataClient,
    readonly adapterManager: AdapterManager,
    readonly crossChainTransferClient: CrossChainTransferClient,
    readonly simMode = false,
    readonly prioritizeLpUtilization = true
  ) {
    this.scalar = sdkUtils.fixedPointAdjustment;
    this.formatWei = createFormatFunction(2, 4, false, 18);
    this.profiler = new Profiler({
      logger: this.logger,
      at: "InventoryClient",
    });
  }

  /**
   * Resolve the token balance configuration for `l1Token` on `chainId`. If `l1Token` maps to multiple tokens on
   * `chainId` then `l2Token` must be supplied.
   * @param l1Token L1 token address to query.
   * @param chainId Chain ID to query on
   * @param l2Token Optional L2 token address when l1Token maps to multiple l2Token addresses.
   */
  getTokenConfig(l1Token: EvmAddress, chainId: number, l2Token?: Address): TokenBalanceConfig | undefined {
    const tokenConfig = this.inventoryConfig.tokenConfig[l1Token.toEvmAddress()];
    if (!isDefined(tokenConfig)) {
      return;
    }

    if (isAliasConfig(tokenConfig)) {
      assert(isDefined(l2Token), `Cannot resolve ambiguous ${getNetworkName(chainId)} token config for ${l1Token}`);
      return tokenConfig[l2Token.toNative()]?.[chainId];
    } else {
      return tokenConfig[chainId];
    }
  }

  /*
   * Get the total balance for an L1 token across all chains, considering any outstanding cross chain transfers as a
   * virtual balance on that chain.
   * @notice Returns the balance in the decimals of the L1 token.
   * @param l1Token L1 token address to query.
   * returns Cumulative balance of l1Token across all inventory-managed chains.
   */
  getCumulativeBalance(l1Token: EvmAddress): BigNumber {
    return this.getEnabledChains()
      .map((chainId) => this.getBalanceOnChain(chainId, l1Token))
      .reduce((acc, curr) => acc.add(curr), bnZero);
  }

  /**
   * Determine the effective/virtual balance of an l1 token that has been deployed to another chain.
   * Includes both the actual balance on the chain and any pending inbound transfers to the target chain.
   * If l2Token is supplied, return its balance on the specified chain. Otherwise, return the total allocation
   * of l1Token on the specified chain.
   * @notice Returns the balance of the tokens normalized to the L1 token decimals, which matters if the L2 token
   * decimals differs from the L1 token decimals.
   * @param chainId Chain to query token balance on.
   * @param l1Token L1 token to query on chainId (after mapping).
   * @param l2Token Optional l2 token address to narrow the balance reporting.
   * @returns Balance of l1Token on chainId.
   */
  protected getBalanceOnChain(chainId: number, l1Token: EvmAddress, l2Token?: Address): BigNumber {
    const { crossChainTransferClient, relayer, tokenClient } = this;
    let balance: BigNumber;

    const { decimals: l1TokenDecimals } = getTokenInfo(l1Token, this.hubPoolClient.chainId);

    // Return the balance for a specific l2 token on the remote chain.
    if (isDefined(l2Token)) {
      const { decimals: l2TokenDecimals } = this.hubPoolClient.getTokenInfoForAddress(l2Token, chainId);
      balance = sdkUtils.ConvertDecimals(l2TokenDecimals, l1TokenDecimals)(tokenClient.getBalance(chainId, l2Token));
      return balance.add(
        crossChainTransferClient.getOutstandingCrossChainTransferAmount(relayer, chainId, l1Token, l2Token)
      );
    }

    const l2Tokens = this.getRemoteTokensForL1Token(l1Token, chainId);
    balance = l2Tokens
      .map((l2Token) => {
        const { decimals: l2TokenDecimals } = this.hubPoolClient.getTokenInfoForAddress(l2Token, chainId);
        return sdkUtils.ConvertDecimals(l2TokenDecimals, l1TokenDecimals)(tokenClient.getBalance(chainId, l2Token));
      })
      .reduce((acc, curr) => acc.add(curr), bnZero);

    return balance.add(crossChainTransferClient.getOutstandingCrossChainTransferAmount(this.relayer, chainId, l1Token));
  }

  /**
   * Determine the allocation of an l1 token across all configured remote chain IDs.
   * @param l1Token L1 token to query.
   * @returns Distribution of l1Token by chain ID and l2Token.
   */
  private getChainDistribution(l1Token: EvmAddress): { [chainId: number]: TokenDistribution } {
    const cumulativeBalance = this.getCumulativeBalance(l1Token);
    const distribution: { [chainId: number]: TokenDistribution } = {};

    this.getEnabledChains().forEach((chainId) => {
      // If token doesn't have entry on chain, skip creating an entry for it since we'll likely run into an error
      // later trying to grab the chain equivalent of the L1 token via the HubPoolClient.
      if (chainId === this.hubPoolClient.chainId || this._l1TokenEnabledForChain(l1Token, chainId)) {
        if (cumulativeBalance.eq(bnZero)) {
          return;
        }

        distribution[chainId] ??= {};
        const l2Tokens = this.getRemoteTokensForL1Token(l1Token, chainId);
        l2Tokens.forEach((l2Token) => {
          // The effective balance is the current balance + inbound bridge transfers.
          const effectiveBalance = this.getBalanceOnChain(chainId, l1Token, l2Token);
          distribution[chainId][l2Token.toNative()] = effectiveBalance.mul(this.scalar).div(cumulativeBalance);
        });
      }
    });
    return distribution;
  }

  /**
   * Determine the allocation of an l1 token across all configured remote chain IDs.
   * @param l1Token L1 token to query.
   * @returns Distribution of l1Token by chain ID and l2Token.
   */
  getTokenDistributionPerL1Token(): TokenDistributionPerL1Token {
    const distributionPerL1Token: TokenDistributionPerL1Token = {};
    this.getL1Tokens().forEach(
      (l1Token) => (distributionPerL1Token[l1Token.toNative()] = this.getChainDistribution(l1Token))
    );
    return distributionPerL1Token;
  }

  // Get the balance of a given token on a given chain, including shortfalls and any pending cross chain transfers.
  getCurrentAllocationPct(l1Token: EvmAddress, chainId: number, l2Token: Address): BigNumber {
    // If there is nothing over all chains, return early.
    const cumulativeBalance = this.getCumulativeBalance(l1Token);
    if (cumulativeBalance.eq(bnZero)) {
      return bnZero;
    }

    const { decimals: l2TokenDecimals } = this.hubPoolClient.getTokenInfoForAddress(l2Token, chainId);
    const { decimals: l1TokenDecimals } = getTokenInfo(l1Token, this.hubPoolClient.chainId);
    const shortfall = sdkUtils.ConvertDecimals(
      l2TokenDecimals,
      l1TokenDecimals
    )(this.tokenClient.getShortfallTotalRequirement(chainId, l2Token));
    const currentBalance = this.getBalanceOnChain(chainId, l1Token, l2Token).sub(shortfall);

    // Multiply by scalar to avoid rounding errors.
    return currentBalance.mul(this.scalar).div(cumulativeBalance);
  }

  protected getRemoteTokenForL1Token(l1Token: EvmAddress, chainId: number | string): Address | undefined {
    return chainId === this.hubPoolClient.chainId
      ? l1Token
      : getRemoteTokenForL1Token(l1Token, chainId, this.hubPoolClient.chainId);
  }

  /**
   * From an L1Token and remote chain ID, resolve all supported corresponding tokens.
   * This should include at least the relevant repayment token on the relevant chain, but may also include other
   * "equivalent" tokens (i.e. as with Bridged & Native USDC) as defined by a custom token configuration.
   * @param l1Token Mainnet token to query.
   * @param chainId Remove chain to query.
   * @returns An array of supported tokens on chainId that map back to l1Token on mainnet.
   */
  getRemoteTokensForL1Token(l1Token: EvmAddress, chainId: number): Address[] {
    if (chainId === this.hubPoolClient.chainId) {
      return [l1Token];
    }

    const tokenConfig = this.inventoryConfig.tokenConfig[l1Token.toNative()];
    if (!isDefined(tokenConfig)) {
      return [];
    }

    if (isAliasConfig(tokenConfig)) {
      return Object.keys(tokenConfig)
        .filter((k) => isDefined(tokenConfig[k][chainId]))
        .map((token) => toAddressType(token, chainId));
    }

    const destinationToken = this.getRemoteTokenForL1Token(l1Token, chainId);
    if (!isDefined(destinationToken)) {
      return [];
    }

    return [destinationToken];
  }

  getEnabledChains(): number[] {
    return this.chainIdList;
  }

  getEnabledL2Chains(): number[] {
    const hubPoolChainId = this.hubPoolClient.chainId;
    return this.getEnabledChains().filter((chainId) => chainId !== hubPoolChainId);
  }

  getL1Tokens(): EvmAddress[] {
    return (
      Object.keys(this.inventoryConfig.tokenConfig ?? {}).map((token) => EvmAddress.from(token)) ||
      this.hubPoolClient.getL1Tokens().map((l1Token) => l1Token.address)
    );
  }

  // Decrement Tokens Balance And Increment Cross Chain Transfer
  trackCrossChainTransfer(l1Token: EvmAddress, l2Token: Address, rebalance: BigNumber, chainId: number): void {
    this.tokenClient.decrementLocalBalance(this.hubPoolClient.chainId, l1Token, rebalance);
    this.crossChainTransferClient.increaseOutstandingTransfer(this.relayer, l1Token, l2Token, rebalance, chainId);
  }

  async getAllBundleRefunds(): Promise<CombinedRefunds[]> {
    const refunds: CombinedRefunds[] = [];
    const [pendingRefunds, nextBundleRefunds] = await Promise.all([
      this.bundleDataClient.getPendingRefundsFromValidBundles(),
      this.bundleDataClient.getNextBundleRefunds(),
    ]);
    refunds.push(...pendingRefunds, ...nextBundleRefunds);
    this.logger.debug({
      at: "InventoryClient#getAllBundleRefunds",
      message: "Remaining refunds from last validated bundle (excludes already executed refunds)",
      refunds: pendingRefunds[0],
    });
    if (nextBundleRefunds.length === 2) {
      this.logger.debug({
        at: "InventoryClient#getAllBundleRefunds",
        message: "Refunds from pending bundle",
        refunds: nextBundleRefunds[0],
      });
      this.logger.debug({
        at: "InventoryClient#getAllBundleRefunds",
        message: "Refunds from upcoming bundle",
        refunds: nextBundleRefunds[1],
      });
    } else {
      this.logger.debug({
        at: "InventoryClient#getAllBundleRefunds",
        message: "Refunds from upcoming bundle",
        refunds: nextBundleRefunds[0],
      });
    }
    return refunds;
  }

  // Return the upcoming refunds (in pending and next bundles) on each chain.
  // @notice Returns refunds using decimals of the l1Token.
  private async getBundleRefunds(l1Token: EvmAddress): Promise<{ [chainId: string]: BigNumber }> {
    let refundsToConsider: CombinedRefunds[] = [];
    const { decimals: l1TokenDecimals } = getTokenInfo(l1Token, this.hubPoolClient.chainId);

    let mark: ReturnType<typeof this.profiler.start>;
    // Increase virtual balance by pending relayer refunds from the latest valid bundle and the
    // upcoming bundle. We can assume that all refunds from the second latest valid bundle have already
    // been executed.
    if (!isDefined(this.bundleRefundsPromise)) {
      // @dev Save this as a promise so that other parallel calls to this function don't make the same call.
      mark = this.profiler.start(`bundleRefunds for ${l1Token}`);
      this.bundleRefundsPromise = this.getAllBundleRefunds();
    }
    refundsToConsider = lodash.cloneDeep(await this.bundleRefundsPromise);
    const totalRefundsPerChain = this.getEnabledChains().reduce(
      (refunds: { [chainId: string]: BigNumber }, chainId) => {
        const destinationToken = this.getRemoteTokenForL1Token(l1Token, chainId);
        if (!destinationToken) {
          refunds[chainId] = bnZero;
        } else {
          const { decimals: l2TokenDecimals } = this.hubPoolClient.getTokenInfoForAddress(destinationToken, chainId);
          refunds[chainId] = sdkUtils.ConvertDecimals(
            l2TokenDecimals,
            l1TokenDecimals
          )(this.bundleDataClient.getTotalRefund(refundsToConsider, this.relayer, chainId, destinationToken));
          return refunds;
        }
        return refunds;
      },
      {}
    );

    mark?.stop({
      message: "Time to calculate total refunds per chain",
      l1Token,
    });

    return totalRefundsPerChain;
  }

  /**
   * Returns possible repayment chain options for a deposit. This is designed to be called by the relayer
   * so that it can batch compute LP fees for all possible repayment chains. By locating this function
   * here it ensures that the relayer and the inventory client are in sync as to which chains are possible
   * repayment chains for a given deposit.
   * @param deposit Deposit
   * @returns list of chain IDs that are possible repayment chains for the deposit.
   */
  getPossibleRepaymentChainIds(deposit: Deposit): number[] {
    // Origin chain is always included in the repayment chain list.
    const { originChainId, destinationChainId, inputToken } = deposit;
    const chainIds = new Set<number>();
    chainIds.add(originChainId);
    if (depositForcesOriginChainRepayment(deposit, this.hubPoolClient)) {
      return [...chainIds];
    }

    if (this.canTakeDestinationChainRepayment(deposit)) {
      chainIds.add(destinationChainId);
    }

    if (this.isInventoryManagementEnabled()) {
      const l1Token = this.getL1TokenAddress(inputToken, originChainId);
      this.getSlowWithdrawalRepaymentChains(l1Token).forEach((chainId) => {
        if (this.hubPoolClient.l2TokenEnabledForL1Token(l1Token, chainId)) {
          chainIds.add(chainId);
        }
      });
    }
    chainIds.add(this.hubPoolClient.chainId);
    return [...chainIds];
  }

  getL1TokenAddress(l2Token: Address, chainId: number): EvmAddress {
    return getL1TokenAddress(l2Token, chainId);
  }

  /**
   * Returns true if the depositor-specified output token is supported by this inventory client.
   * @param deposit Deposit to consider
   * @returns boolean True if output and input tokens are equivalent or if input token is USDC and output token
   * is Bridged USDC.
   */
  validateOutputToken(deposit: Deposit): boolean {
    const { inputToken, outputToken, originChainId, destinationChainId } = deposit;

    // Return true if input and output tokens are mapped to the same L1 token via PoolRebalanceRoutes
    const equivalentTokens = this.hubPoolClient.areTokensEquivalent(
      inputToken,
      originChainId,
      outputToken,
      destinationChainId
    );
    if (equivalentTokens) {
      return true;
    }

    // Return true if the input and output token are defined as equivalent according to a hardcoded mapping
    // of equivalent tokens. This should allow relayer to define which tokens it should be able to fill despite them
    // not being linked via a PoolRebalanceRoute.
    try {
      const l1TokenMappedToInputToken = this.getL1TokenAddress(inputToken, originChainId);
      const l1TokenMappedToOutputToken = this.getL1TokenAddress(outputToken, destinationChainId);
      return l1TokenMappedToInputToken.eq(l1TokenMappedToOutputToken);
    } catch (e) {
      // @dev getL1TokenAddress will throw if a token is not found in the TOKEN_SYMBOLS_MAP.
      return false;
    }
  }

  /**
   * @notice Returns true if the deposit has an output token PoolRebalanceRoute mapping equivalent to the input token's
   * PoolRebalanceRoute mapping.
   */
  canTakeDestinationChainRepayment(
    deposit: Pick<Deposit, "inputToken" | "originChainId" | "outputToken" | "destinationChainId" | "fromLiteChain">
  ): boolean {
    if (depositForcesOriginChainRepayment(deposit, this.hubPoolClient)) {
      return false;
    }
    const hubPoolBlock = this.hubPoolClient.latestHeightSearched;
    if (!this.hubPoolClient.l2TokenHasPoolRebalanceRoute(deposit.inputToken, deposit.originChainId, hubPoolBlock)) {
      return false;
    }
    const l1Token = this.hubPoolClient.getL1TokenForL2TokenAtBlock(
      deposit.inputToken,
      deposit.originChainId,
      hubPoolBlock
    );
    return this.hubPoolClient.l2TokenEnabledForL1TokenAtBlock(l1Token, deposit.destinationChainId, hubPoolBlock);
  }

  /*
   * Return all eligible repayment chains for a deposit. If inventory management is enabled, then this function will
   * only choose chains where the post-relay balance allocation for a potential repayment chain is under the maximum
   * allowed allocation on that chain. Origin, Destination, and HubChains are always evaluated as potential
   * repayment chains in addition to  "Slow Withdrawal chains" such as Base, Optimism and Arbitrum for which
   * taking repayment would reduce HubPool utilization. Post-relay allocation percentages take into
   * account pending cross-chain inventory-management transfers, upcoming bundle refunds, token shortfalls
   * needed to cover other unfilled deposits in addition to current token balances. Slow withdrawal chains are only
   * selected if the SpokePool's running balance for that chain is over the system's desired target.
   * @dev The HubChain is always evaluated as a fallback option if the inventory management is enabled and all other
   * chains are over-allocated, unless the origin chain is a lite chain, in which case
   * there is no fallback if the origin chain is not an eligible repayment chain.
   * @dev If the origin chain is a lite chain, then only the origin chain is evaluated as a potential repayment chain.
   * @dev If inventory management is disabled, then destinationChain is used as a default unless the
   * originChain is a lite chain, then originChain is the default used.
   * @param deposit Deposit to determine repayment chains for.
   * @param l1Token L1Token linked with deposited inputToken and repayment chain refund token.
   * @returns list of chain IDs that are possible repayment chains for the deposit, sorted from highest
   * to lowest priority.
   */
  async determineRefundChainId(deposit: Deposit, l1Token?: EvmAddress): Promise<number[]> {
    const { originChainId, destinationChainId, inputToken, outputToken, inputAmount } = deposit;
    const hubChainId = this.hubPoolClient.chainId;

    if (sdkUtils.invalidOutputToken(deposit)) {
      return [];
    }

    const forceOriginRepayment = depositForcesOriginChainRepayment(deposit, this.hubPoolClient);
    if (!this.isInventoryManagementEnabled()) {
      return [!this.canTakeDestinationChainRepayment(deposit) ? originChainId : destinationChainId];
    }

    // The InventoryClient assumes 1:1 equivalency between input and output tokens. At the moment there is no support
    // for disparate output tokens (unless the output token is USDC.e and the input token is USDC),
    // so if one appears here then something is wrong. Throw hard and fast in that case.
    // In future, fills for disparate output tokens should probably just take refunds on the destination chain and
    // outsource inventory management to the operator.
    if (!this.validateOutputToken(deposit)) {
      const [srcChain, dstChain] = [getNetworkName(originChainId), getNetworkName(destinationChainId)];
      throw new Error(
        `Unexpected ${dstChain} output token on ${srcChain} deposit ${deposit.depositId.toString()}` +
          ` (${inputToken} != ${outputToken})`
      );
    }

    // If the deposit forces origin chain repayment but the origin chain is one we can easily rebalance inventory from,
    // then don't ignore this deposit based on perceived over-allocation. For example, the hub chain and chains connected
    // to the user's Binance API are easy to move inventory from so we should never skip filling these deposits.
    if (forceOriginRepayment && repaymentChainCanBeQuicklyRebalanced(deposit, this.hubPoolClient)) {
      return [deposit.originChainId];
    }

    l1Token ??= this.getL1TokenAddress(inputToken, originChainId);
    const { decimals: l1TokenDecimals } = getTokenInfo(l1Token, this.hubPoolClient.chainId);
    const { decimals: inputTokenDecimals } = this.hubPoolClient.getTokenInfoForAddress(inputToken, originChainId);
    const inputAmountInL1TokenDecimals = sdkUtils.ConvertDecimals(inputTokenDecimals, l1TokenDecimals)(inputAmount);

    // Consider any refunds from executed and to-be executed bundles. If bundle data client doesn't return in
    // time, return an object with zero refunds for all chains.
    const totalRefundsPerChain: { [chainId: string]: BigNumber } = await this.getBundleRefunds(l1Token);
    const cumulativeRefunds = Object.values(totalRefundsPerChain).reduce((acc, curr) => acc.add(curr), bnZero);
    const cumulativeVirtualBalance = this.getCumulativeBalance(l1Token);

    // @dev: The following async call to `getExcessRunningBalancePcts` should be very fast compared to the above
    // getBundleRefunds async call. Therefore, we choose not to compute them in parallel.

    // Build list of chains we want to evaluate for repayment:
    const chainsToEvaluate: number[] = [];
    // Add optimistic rollups to front of evaluation list because these are chains with long withdrawal periods
    // that we want to prioritize taking repayment on if the chain is going to end up sending funds back to the
    // hub in the next root bundle over the slow canonical bridge.
    // We need to calculate the latest running balance for each optimistic rollup chain.
    // We'll add the last proposed running balance plus new deposits and refunds.
    if (!forceOriginRepayment && this.prioritizeLpUtilization) {
      const excessRunningBalancePcts = await this.getExcessRunningBalancePcts(
        l1Token,
        inputAmountInL1TokenDecimals,
        this.getSlowWithdrawalRepaymentChains(l1Token)
      );
      // Sort chains by highest excess percentage over the spoke target, so we can prioritize
      // taking repayment on chains with the most excess balance.
      const chainsWithExcessSpokeBalances = Object.entries(excessRunningBalancePcts)
        .filter(([, pct]) => pct.gt(0))
        .sort(([, pctx], [, pcty]) => bnComparatorDescending(pctx, pcty))
        .map(([chainId]) => Number(chainId));
      chainsToEvaluate.push(...chainsWithExcessSpokeBalances);
    }
    // Add origin chain to take higher priority than destination chain if the destination chain
    // is a lite chain, which should allow the relayer to take more repayments away from the lite chain. Because
    // lite chain deposits force repayment on origin, we end up taking lots of repayment on the lite chain so
    // we should take repayment away from the lite chain where possible.
    if (
      deposit.toLiteChain &&
      !chainsToEvaluate.includes(originChainId) &&
      this._l1TokenEnabledForChain(l1Token, Number(originChainId))
    ) {
      chainsToEvaluate.push(originChainId);
    }
    // Add destination and origin chain if they are not already added.
    // Prioritize destination chain repayment over origin chain repayment but prefer both over
    // hub chain repayment if they are under allocated. We don't include hub chain
    // since its the fallback chain if both destination and origin chain are over allocated.
    // If destination chain is hub chain, we still want to evaluate it before the origin chain.
    if (
      this.canTakeDestinationChainRepayment(deposit) &&
      !chainsToEvaluate.includes(destinationChainId) &&
      this._l1TokenEnabledForChain(l1Token, Number(destinationChainId))
    ) {
      chainsToEvaluate.push(destinationChainId);
    }
    if (
      !chainsToEvaluate.includes(originChainId) &&
      originChainId !== hubChainId &&
      this._l1TokenEnabledForChain(l1Token, Number(originChainId))
    ) {
      chainsToEvaluate.push(originChainId);
    }

    // Sanity check that the possible chains used to pre-compute LP fees by the relayer are a subset of the
    // chains that are actually eligible for repayment.
    const possibleRepaymentChainIds = this.getPossibleRepaymentChainIds(deposit);
    if (chainsToEvaluate.some((_chain) => !possibleRepaymentChainIds.includes(_chain))) {
      throw new Error(
        `InventoryClient.getPossibleRepaymentChainIds (${possibleRepaymentChainIds})and determineRefundChainId (${chainsToEvaluate}) disagree on eligible repayment chains`
      );
    }
    const eligibleRefundChains: number[] = [];
    // At this point, all chains to evaluate have defined token configs and are sorted in order of
    // highest priority to take repayment on, assuming the chain is under-allocated.
    for (const chainId of chainsToEvaluate) {
      assert(this._l1TokenEnabledForChain(l1Token, chainId), `Token ${l1Token} not enabled for chain ${chainId}`);

      // Destination chain:
      const repaymentToken = this.getRemoteTokenForL1Token(l1Token, chainId);
      if (chainId !== originChainId) {
        assert(
          this.hubPoolClient.l2TokenHasPoolRebalanceRoute(repaymentToken, chainId),
          `Token ${repaymentToken} not enabled as PoolRebalanceRoute for chain ${chainId} for l1 token ${l1Token}`
        );
      }
      const { decimals: l2TokenDecimals } = this.hubPoolClient.getTokenInfoForAddress(repaymentToken, chainId);
      const chainShortfall = sdkUtils.ConvertDecimals(
        l2TokenDecimals,
        l1TokenDecimals
      )(this.tokenClient.getShortfallTotalRequirement(chainId, repaymentToken));
      const chainVirtualBalance = this.getBalanceOnChain(chainId, l1Token, repaymentToken);
      const chainVirtualBalanceWithShortfall = chainVirtualBalance.sub(chainShortfall);
      // @dev Do not subtract outputAmount from virtual balance if output token and input token are not equivalent.
      // This is possible when the output token is USDC.e and the input token is USDC which would still cause
      // validateOutputToken() to return true above.
      let chainVirtualBalanceWithShortfallPostRelay =
        chainId === destinationChainId &&
        this.hubPoolClient.areTokensEquivalent(inputToken, originChainId, outputToken, destinationChainId)
          ? chainVirtualBalanceWithShortfall
          : chainVirtualBalanceWithShortfall.add(inputAmountInL1TokenDecimals);

      // Add upcoming refunds:
      chainVirtualBalanceWithShortfallPostRelay = chainVirtualBalanceWithShortfallPostRelay.add(
        totalRefundsPerChain[chainId] ?? bnZero
      );
      // To correctly compute the allocation % for this destination chain, we need to add all upcoming refunds for the
      // equivalents of l1Token on all chains.
      const cumulativeVirtualBalancePostRefunds = cumulativeVirtualBalance.add(cumulativeRefunds);

      // Compute what the balance will be on the target chain, considering this relay and the finalization of the
      // transfers that are currently flowing through the canonical bridge.
      const expectedPostRelayAllocation = chainVirtualBalanceWithShortfallPostRelay
        .mul(this.scalar)
        .div(cumulativeVirtualBalancePostRefunds);

      // Consider configured buffer for target to allow relayer to support slight overages.
      const tokenConfig = this.getTokenConfig(l1Token, chainId, repaymentToken);
      if (!isDefined(tokenConfig)) {
        const repaymentChain = getNetworkName(chainId);
        this.logger.debug({
          at: "InventoryClient#determineRefundChainId",
          message: `No token config for ${repaymentToken} on ${repaymentChain}.`,
        });
        if (chainId === destinationChainId) {
          this.logger.debug({
            at: "InventoryClient#determineRefundChainId",
            message: `Will consider to take repayment on ${repaymentChain} as destination chain.`,
          });
          eligibleRefundChains.push(chainId);
        }
        continue;
      }

      // It's undesirable to accrue excess balances on a Lite chain because the relayer relies on additional deposits
      // destined for that chain in order to offload its excess.
      const { targetOverageBuffer = DEFAULT_TOKEN_OVERAGE } = tokenConfig;
      const effectiveTargetPct =
        deposit.toLiteChain && chainId === destinationChainId
          ? tokenConfig.targetPct
          : tokenConfig.targetPct.mul(targetOverageBuffer).div(fixedPointAdjustment);

      this.log(
        `Evaluated taking repayment on ${
          chainId === originChainId ? "origin" : chainId === destinationChainId ? "destination" : "slow withdrawal"
        } chain ${chainId} for deposit ${deposit.depositId.toString()}: ${
          expectedPostRelayAllocation.lte(effectiveTargetPct) ? "UNDERALLOCATED ✅" : "OVERALLOCATED ❌"
        }`,
        {
          l1Token,
          originChainId,
          destinationChainId,
          chainShortfall,
          chainVirtualBalance,
          chainVirtualBalanceWithShortfall,
          chainVirtualBalanceWithShortfallPostRelay,
          cumulativeVirtualBalance,
          cumulativeVirtualBalancePostRefunds,
          targetPct: formatUnits(tokenConfig.targetPct, 18),
          targetOverage: formatUnits(targetOverageBuffer, 18),
          effectiveTargetPct: formatUnits(effectiveTargetPct, 18),
          expectedPostRelayAllocation,
          chainsToEvaluate,
        }
      );
      if (expectedPostRelayAllocation.lte(effectiveTargetPct)) {
        eligibleRefundChains.push(chainId);
      }
    }

    // At this point, if the deposit originated on a lite chain, which forces fillers to take repayment on the origin
    // chain, and the origin chain is not an eligible repayment chain, then we shouldn't fill this deposit otherwise
    // the filler will be forced to be over-allocated on the origin chain, which could be very difficult to withdraw
    // funds from.
    // @dev The RHS of this conditional is essentially true if eligibleRefundChains does NOT deep equal [originChainId].
    if (forceOriginRepayment && (eligibleRefundChains.length !== 1 || !eligibleRefundChains.includes(originChainId))) {
      return [];
    }

    // Always add hubChain as a fallback option if inventory management is enabled and origin chain is not a lite chain.
    // If none of the chainsToEvaluate were selected, then this function will return just the hub chain as a fallback option.
    if (!depositForcesOriginChainRepayment(deposit, this.hubPoolClient) && !eligibleRefundChains.includes(hubChainId)) {
      eligibleRefundChains.push(hubChainId);
    }
    return eligibleRefundChains;
  }

  /**
   * Returns running balances for l1Tokens on all slow withdrawal chains that are enabled for this l1Token.
   * @param l1Token
   * @returns Dictionary keyed by chain ID of the absolute value of the latest running balance for the l1Token.
   */
  private async _getLatestRunningBalances(
    l1Token: EvmAddress,
    chainsToEvaluate: number[]
  ): Promise<{ [chainId: number]: BigNumber }> {
    const mark = this.profiler.start("getLatestRunningBalances");
    const chainIds = this.hubPoolClient.configStoreClient.getChainIdIndicesForBlock();
    const l1TokenDecimals = getTokenInfo(l1Token, this.hubPoolClient.chainId).decimals;
    const runningBalances = Object.fromEntries(
      await sdkUtils.mapAsync(chainsToEvaluate, async (chainId) => {
        const chainIdIndex = chainIds.indexOf(chainId);

        // We need to find the latest validated running balance for this chain and token.
        const lastValidatedRunningBalance = this.hubPoolClient.getRunningBalanceBeforeBlockForChain(
          this.hubPoolClient.latestHeightSearched,
          chainId,
          l1Token
        ).runningBalance;

        // Approximate latest running balance for a chain as last known validated running balance...
        // - minus total deposit amount on chain since the latest validated end block
        // - plus total refund amount on chain since the latest validated end block
        const latestValidatedBundle = this.hubPoolClient.getLatestExecutedRootBundleContainingL1Token(
          this.hubPoolClient.latestHeightSearched,
          chainId,
          l1Token
        );
        const l2Token = this.hubPoolClient.getL2TokenForL1TokenAtBlock(l1Token, Number(chainId));
        const l2TokenDecimals = this.hubPoolClient.getTokenInfoForAddress(l2Token, chainId).decimals;
        const l2AmountToL1Amount = sdkUtils.ConvertDecimals(l2TokenDecimals, l1TokenDecimals);

        // If there is no ExecutedRootBundle event in the hub pool client's lookback for the token and chain, then
        // default the bundle end block to 0. This will force getUpcomingDepositAmount to count any deposit
        // seen in the spoke pool client's lookback. It would be very odd however for there to be deposits or refunds
        // for a token and chain without there being a validated root bundle containing the token, so really the
        // following check will be hit if the chain's running balance is very stale. The best way to check
        // its running balance at that point is to query the token balance directly but this is still potentially
        // inaccurate if someone sent tokens directly to the contract, and it incurs an extra RPC call so we avoid
        // it for now. The default running balance will be 0, and this function is primarily designed to choose
        // which chains have too many running balances and therefore should be selected for repayment, so returning
        // 0 here means this chain will never be selected for repayment as a "slow withdrawal" chain.
        let lastValidatedBundleEndBlock = 0;
        let proposedRootBundle: ProposedRootBundle | undefined;
        if (latestValidatedBundle) {
          proposedRootBundle = this.hubPoolClient.getLatestFullyExecutedRootBundle(
            latestValidatedBundle.blockNumber // The ProposeRootBundle event must precede the ExecutedRootBundle
            // event we grabbed above. However, it might not exist if the ExecutedRootBundle event is old enough
            // that the preceding ProposeRootBundle is older than the lookback. In this case, leave the
            // last validated bundle end block as 0, since it must be before the earliest lookback block since it was
            // before the ProposeRootBundle event and we can't even find that.
          );
          if (proposedRootBundle) {
            lastValidatedBundleEndBlock = proposedRootBundle.bundleEvaluationBlockNumbers[chainIdIndex].toNumber();
          }
        }
        const upcomingDepositsAfterLastValidatedBundle = l2AmountToL1Amount(
          this.bundleDataClient.getUpcomingDepositAmount(chainId, l2Token, lastValidatedBundleEndBlock)
        );

        // Grab refunds that are not included in any bundle proposed on-chain. These are refunds that have not
        // been accounted for in the latest running balance set in `runningBalanceForToken`.
        const allBundleRefunds = lodash.cloneDeep(await this.bundleRefundsPromise);
        // @dev upcoming refunds are always pushed last into this list, that's why we can pop() it.
        // If a chain didn't exist in the last bundle or a spoke pool client isn't defined, then
        // one of the refund entries for a chain can be undefined.
        const upcomingRefundsAfterLastValidatedBundle = Object.values(
          allBundleRefunds.pop()?.[chainId]?.[l2Token.toNative()] ?? {}
        ).reduce((acc, curr) => acc.add(l2AmountToL1Amount(curr)), bnZero);

        // Updated running balance is last known running balance minus deposits plus upcoming refunds.
        const latestRunningBalance = lastValidatedRunningBalance
          .sub(upcomingDepositsAfterLastValidatedBundle)
          .add(upcomingRefundsAfterLastValidatedBundle);
        // A negative running balance means that the spoke has a balance. If the running balance is positive, then the hub
        // owes it funds and its below target so we don't want to take additional repayment.
        const absLatestRunningBalance = latestRunningBalance.lt(0) ? latestRunningBalance.abs() : toBN(0);
        return [
          chainId,
          {
            absLatestRunningBalance,
            lastValidatedRunningBalance,
            upcomingDeposits: upcomingDepositsAfterLastValidatedBundle,
            upcomingRefunds: upcomingRefundsAfterLastValidatedBundle,
            bundleEndBlock: lastValidatedBundleEndBlock,
            proposedRootBundle: proposedRootBundle?.txnRef,
          },
        ];
      })
    );
    mark.stop({
      message: `Time to get running balances for ${l1Token}`,
      chainsToEvaluate,
      runningBalances,
    });
    return Object.fromEntries(Object.entries(runningBalances).map(([k, v]) => [k, v.absLatestRunningBalance]));
  }

  /**
   * @param excessRunningBalances Dictionary of "excess" running balances per chain. Running balances
   * are recorded in PoolRebalanceLeaves and are positive if the Hub owes the Spoke funds and negative otherwise.
   * Therefore, running balances can only be considered "excess" if the running balance as recorded in the
   * PoolRebalanceLeaf is negative. This is denoting that the Hub is over-allocated on the Spoke.
   * @param l1Token Token we are comparing running balances for against spoke pool targets.
   * @param refundAmount Amount that will be refunded to the relayer. This value gets subtracted from running
   * balance excesses before comparing with the spoke pool target, since refunds are taken out of spoke pool balances.
   * @returns Dictionary of excess percentages for each chain. The excess percentage is the percentage of the
   * excess running balance over the spoke pool target balance. If the absolute running balance is 0, then
   * the excess percentage is 0. If the target is 0, then the excess percentage is infinite.
   */
  private _getExcessRunningBalancePcts(
    excessRunningBalances: { [chainId: number]: BigNumber },
    l1Token: EvmAddress,
    refundAmountInL1TokenDecimals: BigNumber
  ): { [chainId: number]: BigNumber } {
    const pcts = Object.fromEntries(
      Object.entries(excessRunningBalances).map(([_chainId, excess]) => {
        const chainId = Number(_chainId);
        const target = this.hubPoolClient.configStoreClient.getSpokeTargetBalancesForBlock(
          l1Token.toNative(),
          chainId
        ).target;
        const excessPostRelay = excess.sub(refundAmountInL1TokenDecimals);
        const returnObj = {
          pct: toBN(0),
          target,
          excess,
          excessPostRelay,
        };
        // If target is greater than excess running balance, then pct will
        // be set to 0. If target is 0 then pct is infinite.
        if (target.gte(excessPostRelay)) {
          returnObj.pct = toBN(0);
        } else {
          if (target.eq(0)) {
            returnObj.pct = MAX_UINT_VAL;
          } else {
            // @dev If target is negative, then the denominator will be negative,
            // so we use the .abs() of the denominator to ensure the pct is positive. The
            // numerator will always be positive because in this branch, excessPostRelay > target.
            returnObj.pct = excessPostRelay.sub(target).mul(this.scalar).div(target.abs());
          }
        }
        return [chainId, returnObj];
      })
    );
    this.log(`Computed excess running balances for ${l1Token}`, {
      refundAmountInL1TokenDecimals,
      excessRunningBalancePcts: Object.fromEntries(
        Object.entries(pcts).map(([k, v]) => [
          k,
          {
            ...v,
            pct: formatFeePct(v.pct) + "%",
          },
        ])
      ),
    });
    return Object.fromEntries(Object.entries(pcts).map(([k, v]) => [k, v.pct]));
  }

  async getExcessRunningBalancePcts(
    l1Token: EvmAddress,
    refundAmountInL1TokenDecimals: BigNumber,
    chainsToEvaluate: number[]
  ): Promise<{ [chainId: number]: BigNumber }> {
    if (!isDefined(this.excessRunningBalancePromises[l1Token.toNative()])) {
      // @dev Save this as a promise so that other parallel calls to this function don't make the same call.
      this.excessRunningBalancePromises[l1Token.toNative()] = this._getLatestRunningBalances(l1Token, chainsToEvaluate);
    }
    const excessRunningBalances = lodash.cloneDeep(await this.excessRunningBalancePromises[l1Token.toNative()]);
    return this._getExcessRunningBalancePcts(excessRunningBalances, l1Token, refundAmountInL1TokenDecimals);
  }

  getPossibleRebalances(): Rebalance[] {
    const chainIds = this.getEnabledL2Chains();
    const rebalancesRequired: Rebalance[] = [];

    for (const l1Token of this.getL1Tokens()) {
      const cumulativeBalance = this.getCumulativeBalance(l1Token);
      if (cumulativeBalance.eq(bnZero)) {
        continue;
      }

      chainIds.forEach((chainId) => {
        // Skip if there's no configuration for l1Token on chainId.
        if (!this._l1TokenEnabledForChain(l1Token, chainId)) {
          return;
        }

        const l2Tokens = this.getRemoteTokensForL1Token(l1Token, chainId);
        l2Tokens.forEach((l2Token) => {
          const currentAllocPct = this.getCurrentAllocationPct(l1Token, chainId, l2Token);
          const tokenConfig = this.getTokenConfig(l1Token, chainId, l2Token);
          if (!isDefined(tokenConfig)) {
            return;
          }

          const { thresholdPct, targetPct } = tokenConfig;
          if (currentAllocPct.gte(thresholdPct)) {
            return;
          }

          const deltaPct = targetPct.sub(currentAllocPct);
          const amount = deltaPct.mul(cumulativeBalance).div(this.scalar);
          const balance = this.tokenClient.getBalance(this.hubPoolClient.chainId, l1Token);
          rebalancesRequired.push({
            chainId,
            l1Token,
            l2Token,
            currentAllocPct,
            thresholdPct,
            targetPct,
            balance,
            cumulativeBalance,
            amount,
          });
        });
      });
    }

    return rebalancesRequired;
  }

  // Trigger a rebalance if the current balance on any L2 chain, including shortfalls, is less than the threshold
  // allocation.
  async rebalanceInventoryIfNeeded(): Promise<void> {
    // Note: these types are just used inside this method, so they are declared in-line.
    type ExecutedRebalance = Rebalance & { hash: string };

    const possibleRebalances: Rebalance[] = [];
    const unexecutedRebalances: Rebalance[] = [];
    const executedTransactions: ExecutedRebalance[] = [];
    try {
      if (!this.isInventoryManagementEnabled()) {
        return;
      }
      const tokenDistributionPerL1Token = this.getTokenDistributionPerL1Token();
      this.constructConsideringRebalanceDebugLog(tokenDistributionPerL1Token);

      const rebalancesRequired = this.getPossibleRebalances();
      if (rebalancesRequired.length === 0) {
        this.log("No rebalances required");
        return;
      }

      // Next, evaluate if we have enough tokens on L1 to actually do these rebalances.
      for (const rebalance of rebalancesRequired) {
        const { balance, amount, l1Token, l2Token, chainId } = rebalance;

        // This is the balance left after any assumed rebalances from earlier loop iterations.
        const unallocatedBalance = this.tokenClient.getBalance(this.hubPoolClient.chainId, l1Token);

        // If the amount required in the rebalance is less than the total amount of this token on L1 then we can execute
        // the rebalance to this particular chain. Note that if the sum of all rebalances required exceeds the l1
        // balance then this logic ensures that we only fill the first n number of chains where we can.
        if (amount.lte(unallocatedBalance)) {
          // As a precautionary step before proceeding, check that the token balance for the token we're about to send
          // hasn't changed on L1. It's possible its changed since we updated the inventory due to one or more of the
          // RPC's returning slowly, leading to concurrent/overlapping instances of the bot running.
          const tokenContract = new Contract(l1Token.toNative(), ERC20.abi, this.hubPoolClient.hubPool.signer);
          const currentBalance = await tokenContract.balanceOf(this.relayer.toNative());

          const balanceChanged = !balance.eq(currentBalance);
          const [message, log] = balanceChanged
            ? ["🚧 Token balance on mainnet changed, skipping rebalance", this.logger.warn]
            : ["Token balance in relayer on mainnet is as expected, sending cross chain transfer", this.logger.debug];
          log({
            at: "InventoryClient",
            message,
            l1Token: l1Token.toNative(),
            l2Token: l2Token.toNative(),
            l2ChainId: chainId,
            balance,
            currentBalance,
          });

          if (!balanceChanged) {
            possibleRebalances.push(rebalance);
            // Decrement token balance in client for this chain and increment cross chain counter.
            this.trackCrossChainTransfer(l1Token, l2Token, amount, chainId);
          }
        } else {
          // Extract unexecutable rebalances for logging.
          unexecutedRebalances.push(rebalance);
        }
      }

      // Extract unexecutable rebalances for logging.

      this.log("Considered inventory rebalances", {
        rebalancesRequired: rebalancesRequired.map((rebalance) => {
          return {
            ...rebalance,
            l1Token: rebalance.l1Token.toNative(),
            l2Token: rebalance.l2Token.toNative(),
          };
        }),
        possibleRebalances: possibleRebalances.map((rebalance) => {
          return {
            ...rebalance,
            l1Token: rebalance.l1Token.toNative(),
            l2Token: rebalance.l2Token.toNative(),
          };
        }),
      });

      // Finally, execute the rebalances.
      // TODO: The logic below is slow as it waits for each transaction to be included before sending the next one. This
      // should be refactored to enable us to pass an array of transaction objects to the transaction util that then
      // sends each transaction one after the other with incrementing nonce. this will be left for a follow on PR as this
      // is already complex logic and most of the time we'll not be sending batches of rebalance transactions.
      for (const rebalance of possibleRebalances) {
        const { chainId, l1Token, l2Token, amount } = rebalance;
        const { hash } = await this.sendTokenCrossChain(chainId, l1Token, amount, this.simMode, l2Token);
        executedTransactions.push({ ...rebalance, hash });
      }

      // Construct logs on the cross-chain actions executed.
      let mrkdwn = "";

      const groupedRebalances = lodash.groupBy(executedTransactions, "chainId");
      for (const [_chainId, rebalances] of Object.entries(groupedRebalances)) {
        const chainId = Number(_chainId);
        mrkdwn += `*Rebalances sent to ${getNetworkName(chainId)}:*\n`;
        for (const {
          l1Token,
          l2Token,
          amount,
          targetPct,
          thresholdPct,
          cumulativeBalance,
          hash,
          chainId,
        } of rebalances) {
          const tokenInfo = this.hubPoolClient.getTokenInfoForAddress(l2Token, chainId);
          if (!tokenInfo) {
            `InventoryClient::rebalanceInventoryIfNeeded no token info for L2 token ${l2Token} on chain ${chainId}`;
          }
          const { symbol, decimals } = tokenInfo;
          const l2TokenFormatter = createFormatFunction(2, 4, false, decimals);
          const l1TokenInfo = getTokenInfo(l1Token, this.hubPoolClient.chainId);
          const l1Formatter = createFormatFunction(2, 4, false, l1TokenInfo.decimals);

          mrkdwn +=
            ` - ${l1Formatter(amount.toString())} ${symbol} rebalanced. This meets target allocation of ` +
            `${this.formatWei(targetPct.mul(100).toString())}% (trigger of ` +
            `${this.formatWei(thresholdPct.mul(100).toString())}%) of the total ` +
            `${l1Formatter(
              cumulativeBalance.toString()
            )} ${symbol} over all chains (ignoring hubpool repayments). This chain has a shortfall of ` +
            `${l2TokenFormatter(
              this.tokenClient.getShortfallTotalRequirement(chainId, l2Token).toString()
            )} ${symbol} ` +
            `tx: ${blockExplorerLink(hash, this.hubPoolClient.chainId)}\n`;
        }
      }

      const groupedUnexecutedRebalances = lodash.groupBy(unexecutedRebalances, "chainId");
      for (const [_chainId, rebalances] of Object.entries(groupedUnexecutedRebalances)) {
        const chainId = Number(_chainId);
        mrkdwn += `*Insufficient amount to rebalance to ${getNetworkName(chainId)}:*\n`;
        for (const { l1Token, l2Token, balance, cumulativeBalance, amount } of rebalances) {
          const tokenInfo = this.hubPoolClient.getTokenInfoForAddress(l2Token, chainId);
          if (!tokenInfo) {
            throw new Error(
              `InventoryClient::rebalanceInventoryIfNeeded no token info for L2 token ${l2Token} on chain ${chainId}`
            );
          }
          const l1TokenInfo = getTokenInfo(l1Token, this.hubPoolClient.chainId);
          const l1Formatter = createFormatFunction(2, 4, false, l1TokenInfo.decimals);

          const { symbol, decimals } = tokenInfo;
          const l2TokenFormatter = createFormatFunction(2, 4, false, decimals);
          const distributionPct = tokenDistributionPerL1Token[l1Token.toNative()][chainId][l2Token.toNative()].mul(100);
          mrkdwn +=
            `- ${symbol} transfer blocked. Required to send ` +
            `${l1Formatter(amount.toString())} but relayer has ` +
            `${l1Formatter(balance.toString())} on L1. There is currently ` +
            `${l1Formatter(this.getBalanceOnChain(chainId, l1Token, l2Token).toString())} ${symbol} on ` +
            `${getNetworkName(chainId)} which is ` +
            `${this.formatWei(distributionPct.toString())}% of the total ` +
            `${l1Formatter(cumulativeBalance.toString())} ${symbol}.` +
            " This chain's pending L1->L2 transfer amount is " +
            `${l1Formatter(
              this.crossChainTransferClient
                .getOutstandingCrossChainTransferAmount(this.relayer, chainId, l1Token, l2Token)
                .toString()
            )}.` +
            ` This chain has a shortfall of ${l2TokenFormatter(
              this.tokenClient.getShortfallTotalRequirement(chainId, l2Token).toString()
            )} ${symbol}.\n`;
        }
      }

      if (mrkdwn) {
        this.log("Executed Inventory rebalances 📒", { mrkdwn }, "info");
      }
    } catch (error) {
      this.log(
        "Something errored during inventory rebalance",
        { error, possibleRebalances, unexecutedRebalances, executedTransactions }, // include all info to help debugging.
        "error"
      );
    }
  }

  async unwrapWeth(): Promise<void> {
    if (!this.isInventoryManagementEnabled()) {
      return;
    }

    // Note: these types are just used inside this method, so they are declared in-line.
    type ChainInfo = {
      chainId: number;
      weth: string;
      unwrapWethThreshold: BigNumber;
      unwrapWethTarget: BigNumber;
      balance: BigNumber;
    };
    type Unwrap = { chainInfo: ChainInfo; amount: BigNumber };
    type ExecutedUnwrap = Unwrap & { hash: string };

    const unwrapsRequired: Unwrap[] = [];
    const unexecutedUnwraps: Unwrap[] = [];
    const executedTransactions: ExecutedUnwrap[] = [];

    try {
      const l1Weth = EvmAddress.from(TOKEN_SYMBOLS_MAP.WETH.addresses[this.hubPoolClient.chainId]);
      const chains = await Promise.all(
        this.getEnabledChains()
          .map((chainId) => {
            const tokenConfig = this.getTokenConfig(l1Weth, chainId);
            if (!isDefined(tokenConfig)) {
              return;
            }

            const { unwrapWethThreshold, unwrapWethTarget } = tokenConfig;

            // Ignore chains where ETH isn't the native gas token. Returning null will result in these being filtered.
            if (
              getNativeTokenSymbol(chainId) !== "ETH" ||
              unwrapWethThreshold === undefined ||
              unwrapWethTarget === undefined
            ) {
              return;
            }
            const weth = TOKEN_SYMBOLS_MAP.WETH.addresses[chainId];
            assert(isDefined(weth), `No WETH definition for ${getNetworkName(chainId)}`);

            return { chainId, weth, unwrapWethThreshold, unwrapWethTarget };
          })
          // This filters out all nulls, which removes any chains that are meant to be ignored.
          .filter(isDefined)
          // This map adds the ETH balance to the object.
          .map(async (chainInfo) => {
            const spokePoolClient = this.tokenClient.spokePoolClients[chainInfo.chainId];
            assert(isEVMSpokePoolClient(spokePoolClient));
            return {
              ...chainInfo,
              balance: await spokePoolClient.spokePool.provider.getBalance(this.relayer.toNative()),
            };
          })
      );

      this.log("Checking WETH unwrap thresholds for chains with thresholds set", { chains });

      chains.forEach((chainInfo) => {
        const { chainId, weth, unwrapWethThreshold, unwrapWethTarget, balance } = chainInfo;
        const l2WethBalance = this.tokenClient.getBalance(chainId, toAddressType(weth, chainId));

        if (balance.lt(unwrapWethThreshold)) {
          const amountToUnwrap = unwrapWethTarget.sub(balance);
          const unwrap = { chainInfo, amount: amountToUnwrap };
          if (l2WethBalance.gte(amountToUnwrap)) {
            unwrapsRequired.push(unwrap);
          }
          // Extract unexecutable rebalances for logging.
          else {
            unexecutedUnwraps.push(unwrap);
          }
        }
      });

      this.log("Considered WETH unwraps", { unwrapsRequired, unexecutedUnwraps });

      if (unwrapsRequired.length === 0) {
        this.log("No unwraps required");
        return;
      }

      // Finally, execute the unwraps.
      // TODO: The logic below is slow as it waits for each transaction to be included before sending the next one. This
      // should be refactored to enable us to pass an array of transaction objects to the transaction util that then
      // sends each transaction one after the other with incrementing nonce. this will be left for a follow on PR as this
      // is already complex logic and most of the time we'll not be sending batches of rebalance transactions.
      for (const { chainInfo, amount } of unwrapsRequired) {
        const { chainId, weth } = chainInfo;
        this.tokenClient.decrementLocalBalance(chainId, toAddressType(weth, chainId), amount);
        const receipt = await this._unwrapWeth(chainId, weth, amount);
        executedTransactions.push({ chainInfo, amount, hash: receipt.hash });
      }

      // Construct logs on the cross-chain actions executed.
      let mrkdwn = "";

      for (const { chainInfo, amount, hash } of executedTransactions) {
        const { chainId, unwrapWethTarget, unwrapWethThreshold, balance } = chainInfo;
        mrkdwn += `*Unwraps sent to ${getNetworkName(chainId)}:*\n`;
        const formatter = createFormatFunction(2, 4, false, 18);
        mrkdwn +=
          ` - ${formatter(amount.toString())} WETH rebalanced. This meets target ETH balance of ` +
          `${this.formatWei(unwrapWethTarget.toString())} (trigger of ` +
          `${this.formatWei(unwrapWethThreshold.toString())} ETH), ` +
          `current balance of ${this.formatWei(balance.toString())} ` +
          `tx: ${blockExplorerLink(hash, chainId)}\n`;
      }

      for (const { chainInfo, amount } of unexecutedUnwraps) {
        const { chainId, weth } = chainInfo;
        mrkdwn += `*Insufficient amount to unwrap WETH on ${getNetworkName(chainId)}:*\n`;
        const formatter = createFormatFunction(2, 4, false, 18);
        mrkdwn +=
          "- WETH unwrap blocked. Required to send " +
          `${formatter(amount.toString())} but relayer has ` +
          `${formatter(this.tokenClient.getBalance(chainId, toAddressType(weth, chainId)).toString())} WETH balance.\n`;
      }

      if (mrkdwn) {
        this.log("Executed WETH unwraps 🎁", { mrkdwn }, "info");
      }
    } catch (error) {
      this.log(
        "Something errored during WETH unwrapping",
        { error, unwrapsRequired, unexecutedUnwraps, executedTransactions }, // include all info to help debugging.
        "error"
      );
    }
  }

  async withdrawExcessBalances(): Promise<void> {
    if (!this.isInventoryManagementEnabled()) {
      return;
    }

    const chainIds = this.getEnabledL2Chains();
    type L2Withdrawal = { l2Token: Address; amountToWithdraw: BigNumber };
    const withdrawalsRequired: { [chainId: number]: L2Withdrawal[] } = {};

    await sdkUtils.forEachAsync(this.getL1Tokens(), async (l1Token) => {
      const l1TokenInfo = getTokenInfo(l1Token, this.hubPoolClient.chainId);
      const formatter = createFormatFunction(2, 4, false, l1TokenInfo.decimals);

      // We do not currently count any outstanding L2->L1 pending withdrawal balance in the cumulative balance
      // because it can take so long for these withdrawals to finalize (usually >1 day and up to 7 days). Unlike the
      // L1->L2 pending deposit balances which will finalize in <1 hour in most cases. For allocation % calculations,
      // these pending withdrawals are therefore ignored.
      const cumulativeBalance = this.getCumulativeBalance(l1Token);
      if (cumulativeBalance.eq(bnZero)) {
        return;
      }
      await sdkUtils.forEachAsync(chainIds, async (chainId) => {
        if (chainId === this.hubPoolClient.chainId || !this._l1TokenEnabledForChain(l1Token, chainId)) {
          return;
        }

        const l2Tokens = this.getRemoteTokensForL1Token(l1Token, chainId);
        await sdkUtils.forEachAsync(l2Tokens, async (l2Token) => {
          const { decimals: l2TokenDecimals } = this.hubPoolClient.getTokenInfoForAddress(l2Token, chainId);
          const l2TokenFormatter = createFormatFunction(2, 4, false, l2TokenDecimals);
          const l2BalanceFromL1Decimals = sdkUtils.ConvertDecimals(l1TokenInfo.decimals, l2TokenDecimals);
          const tokenConfig = this.getTokenConfig(l1Token, chainId, l2Token);
          if (!isDefined(tokenConfig)) {
            return;
          }
          // When l2 token balance exceeds threshold, withdraw (balance - target) to hub pool.
          const { targetOverageBuffer, targetPct, withdrawExcessPeriod } = tokenConfig;

          // Excess withdrawals are activated only for chains where the withdrawExcessPeriod variable is set.
          if (!isDefined(withdrawExcessPeriod)) {
            return;
          }

          const adapter = this.adapterManager.adapters[chainId];
          if (!adapter.isSupportedL2Bridge(l1Token)) {
            this.logger.warn({
              at: "InventoryClient#withdrawExcessBalances",
              message: `No L2 bridge configured for ${getNetworkName(chainId)} for token ${l1Token}`,
            });
            return;
          }

          const currentAllocPct = this.getCurrentAllocationPct(l1Token, chainId, l2Token);

          // We apply a discount on the effective target % because the repayment chain choice
          // algorithm should never allow the inventory to get above the target pct * target overage buffer.
          // Withdraw excess when current allocation % is within a small % of the target percentage multiplied
          // by the target overage buffer.
          const discountToTargetOverageBuffer = toBNWei("0.95");
          const targetPctMultiplier = targetOverageBuffer.mul(discountToTargetOverageBuffer).div(this.scalar);
          assert(
            targetPctMultiplier.gte(toBNWei("1")),
            `Target overage buffer multiplied by discount must be >= 1, got ${targetPctMultiplier.toString()}`
          );
          const excessWithdrawThresholdPct = targetPct.mul(targetPctMultiplier).div(this.scalar);

          const shouldWithdrawExcess = currentAllocPct.gte(excessWithdrawThresholdPct);
          const withdrawPct = currentAllocPct.sub(targetPct);
          const cumulativeBalanceInL2TokenDecimals = l2BalanceFromL1Decimals(cumulativeBalance);
          const desiredWithdrawalAmount = cumulativeBalanceInL2TokenDecimals.mul(withdrawPct).div(this.scalar);

          this.log(
            `Evaluated withdrawing excess balance on ${getNetworkName(chainId)} for token ${l1TokenInfo.symbol}: ${
              shouldWithdrawExcess ? "HAS EXCESS ✅" : "NO EXCESS ❌"
            }`,
            {
              l1Token,
              l2Token,
              cumulativeBalance: formatter(cumulativeBalance),
              currentAllocPct: formatUnits(currentAllocPct, 18),
              excessWithdrawThresholdPct: formatUnits(excessWithdrawThresholdPct, 18),
              targetPct: formatUnits(targetPct, 18),
              withdrawalParams: shouldWithdrawExcess
                ? {
                    withdrawPct: formatUnits(withdrawPct, 18),
                    desiredWithdrawalAmount: l2TokenFormatter(desiredWithdrawalAmount),
                  }
                : undefined,
            }
          );
          if (!shouldWithdrawExcess) {
            return;
          }
          // Check to make sure the total pending volume withdrawn over the last
          // maxL2WithdrawalPeriodSeconds does not exceed the maxL2WithdrawalVolume.
          const maxL2WithdrawalVolume = excessWithdrawThresholdPct
            .sub(targetPct)
            .mul(cumulativeBalanceInL2TokenDecimals)
            .div(this.scalar);
          // Note: getL2PendingWithdrawalAmount() returns a value in L2 token decimals so we can compare it with
          // maxL2WithdrawalVolume.
          const pendingWithdrawalAmount = await this.adapterManager.getL2PendingWithdrawalAmount(
            withdrawExcessPeriod,
            chainId,
            this.relayer,
            l2Token
          );
          // If this withdrawal would push the volume over the limit, allow it because the
          // a subsequent withdrawal would be blocked. In other words, the maximum withdrawal volume
          // would still behave as a rate-limit but with some overage allowed.
          const withdrawalVolumeOverCap = pendingWithdrawalAmount.gte(maxL2WithdrawalVolume);
          this.log(
            `Total withdrawal volume for the last ${withdrawExcessPeriod} seconds is ${
              withdrawalVolumeOverCap ? "OVER" : "UNDER"
            } the limit of ${l2TokenFormatter(maxL2WithdrawalVolume)} for ${l1TokenInfo.symbol} on ${getNetworkName(
              chainId
            )}, ${withdrawalVolumeOverCap ? "cannot" : "proceeding to"} withdraw ${l2TokenFormatter(
              desiredWithdrawalAmount
            )}.`,
            {
              excessWithdrawThresholdPct: formatUnits(excessWithdrawThresholdPct, 18),
              targetPct: formatUnits(targetPct, 18),
              maximumWithdrawalPct: formatUnits(excessWithdrawThresholdPct.sub(targetPct), 18),
              maximumWithdrawalAmount: l2TokenFormatter(maxL2WithdrawalVolume),
              pendingWithdrawalAmount: l2TokenFormatter(pendingWithdrawalAmount),
            }
          );
          if (pendingWithdrawalAmount.gte(maxL2WithdrawalVolume)) {
            return;
          }
          withdrawalsRequired[chainId] ??= [];
          withdrawalsRequired[chainId].push({
            l2Token,
            amountToWithdraw: desiredWithdrawalAmount,
          });
        });
      });
    });

    if (Object.keys(withdrawalsRequired).length === 0) {
      this.log("No excess balances to withdraw");
      return;
    } else {
      this.log("Excess balances to withdraw", { withdrawalsRequired });
    }

    // Now, go through each chain and submit transactions. We cannot batch them unfortunately since the bridges
    // pull tokens from the msg.sender.
    const txnReceipts: { [chainId: number]: string[] } = {};
    await sdkUtils.forEachAsync(Object.keys(withdrawalsRequired), async (_chainId) => {
      const chainId = Number(_chainId);
      txnReceipts[chainId] = [];
      await sdkUtils.forEachAsync(withdrawalsRequired[chainId], async (withdrawal) => {
        const txnRef = await this.adapterManager.withdrawTokenFromL2(
          this.relayer,
          chainId,
          withdrawal.l2Token,
          withdrawal.amountToWithdraw,
          this.simMode
        );
        txnReceipts[chainId].push(...txnRef);
      });
    });
    Object.keys(txnReceipts).forEach((chainId) => {
      this.logger.debug({
        at: "InventoryClient",
        message: `L2->L1 withdrawals on ${getNetworkName(chainId)} submitted`,
        chainId,
        withdrawalsRequired: withdrawalsRequired[chainId].map((withdrawal: L2Withdrawal) => {
          const l2TokenInfo = this.hubPoolClient.getTokenInfoForAddress(withdrawal.l2Token, Number(chainId));

          const formatter = createFormatFunction(2, 4, false, l2TokenInfo.decimals);
          return {
            l2Token: l2TokenInfo.symbol,
            amountToWithdraw: formatter(withdrawal.amountToWithdraw.toString()),
          };
        }),
        txnReceipt: txnReceipts[chainId],
      });
    });
  }

  constructConsideringRebalanceDebugLog(distribution: TokenDistributionPerL1Token): void {
    const logData: {
      [symbol: string]: {
        [chainId: number]: {
          [l2TokenAddress: string]: {
            actualBalanceOnChain: string;
            virtualBalanceOnChain: string;
            outstandingTransfers: string;
            tokenShortFalls: string;
            proRataShare: string;
          };
        };
      };
    } = {};
    const cumulativeBalances: { [symbol: string]: string } = {};
    Object.entries(distribution).forEach(([l1Token, distributionForToken]) => {
      const tokenInfo = getTokenInfo(EvmAddress.from(l1Token), this.hubPoolClient.chainId);
      if (tokenInfo === undefined) {
        throw new Error(
          `InventoryClient::constructConsideringRebalanceDebugLog info not found for L1 token ${l1Token}`
        );
      }
      const { symbol, decimals } = tokenInfo;
      const formatter = createFormatFunction(2, 4, false, decimals);
      cumulativeBalances[symbol] = formatter(this.getCumulativeBalance(EvmAddress.from(l1Token)).toString());
      logData[symbol] ??= {};

      Object.keys(distributionForToken).forEach((_chainId) => {
        const chainId = Number(_chainId);
        logData[symbol][chainId] ??= {};

        Object.entries(distributionForToken[chainId]).forEach(([_l2Token, amount]) => {
          const l2Token = toAddressType(_l2Token, chainId);
          const { decimals: l2TokenDecimals } = this.hubPoolClient.getTokenInfoForAddress(l2Token, chainId);
          const l2Formatter = createFormatFunction(2, 4, false, l2TokenDecimals);
          const l1TokenAddr = EvmAddress.from(l1Token);
          const balanceOnChain = this.getBalanceOnChain(chainId, l1TokenAddr, l2Token);
          const transfers = this.crossChainTransferClient.getOutstandingCrossChainTransferAmount(
            this.relayer,
            chainId,
            l1TokenAddr,
            l2Token
          );
          const actualBalanceOnChain = this.tokenClient.getBalance(chainId, l2Token);
          logData[symbol][chainId][l2Token.toNative()] = {
            actualBalanceOnChain: l2Formatter(actualBalanceOnChain.toString()),
            virtualBalanceOnChain: formatter(balanceOnChain.toString()),
            outstandingTransfers: formatter(transfers.toString()),
            tokenShortFalls: l2Formatter(this.tokenClient.getShortfallTotalRequirement(chainId, l2Token).toString()),
            proRataShare: this.formatWei(amount.mul(100).toString()) + "%",
          };
        });
      });
    });

    this.log("Considering rebalance", {
      tokenDistribution: logData,
      cumulativeBalances,
      inventoryConfig: this.inventoryConfig,
    });
  }

  sendTokenCrossChain(
    chainId: number | string,
    l1Token: EvmAddress,
    amount: BigNumber,
    simMode = false,
    l2Token?: Address
  ): Promise<TransactionResponse> {
    return this.adapterManager.sendTokenCrossChain(this.relayer, Number(chainId), l1Token, amount, simMode, l2Token);
  }

  _unwrapWeth(chainId: number, _l2Weth: string, amount: BigNumber): Promise<TransactionResponse> {
    const spokePoolClient = this.tokenClient.spokePoolClients[chainId];
    assert(isEVMSpokePoolClient(spokePoolClient));
    const l2Signer = spokePoolClient.spokePool.signer;
    const l2Weth = new Contract(_l2Weth, WETH_ABI, l2Signer);
    this.log("Unwrapping WETH", { amount: amount.toString() });
    return runTransaction(this.logger, l2Weth, "withdraw", [amount]);
  }

  async setTokenApprovals(): Promise<void> {
    if (!this.isInventoryManagementEnabled()) {
      return;
    }
    const l1Tokens = this.getL1Tokens();
    this.log("Checking token approvals", { l1Tokens });

    await this.adapterManager.setL1TokenApprovals(l1Tokens);
  }

  async wrapL2EthIfAboveThreshold(): Promise<void> {
    // If inventoryConfig is defined, there should be a default wrapEtherTarget and wrapEtherThreshold
    // set by RelayerConfig.ts
    if (!this?.inventoryConfig?.wrapEtherThreshold || !this?.inventoryConfig?.wrapEtherTarget) {
      return;
    }
    this.log("Checking ETH->WETH Wrap status");
    await this.adapterManager.wrapNativeTokenIfAboveThreshold(this.inventoryConfig, this.simMode);
  }

  update(chainIds?: number[]): Promise<void> {
    if (!this.isInventoryManagementEnabled()) {
      return;
    }

    return this.crossChainTransferClient.update(this.getL1Tokens(), chainIds);
  }

  isInventoryManagementEnabled(): boolean {
    if (this?.inventoryConfig?.tokenConfig && Object.keys(this.inventoryConfig.tokenConfig).length > 0) {
      return true;
    }
    // Use logDisabledManagement to avoid spamming the logs on every check if this module is enabled.
    else if (this.logDisabledManagement == false) {
      this.log("Inventory Management Disabled");
    }
    this.logDisabledManagement = true;
    return false;
  }

  _l1TokenEnabledForChain(l1Token: EvmAddress, chainId: number): boolean {
    const tokenConfig = this.inventoryConfig?.tokenConfig?.[l1Token.toNative()];
    if (!isDefined(tokenConfig)) {
      return false;
    }

    // If tokenConfig directly references chainId, token is enabled.
    if (!isAliasConfig(tokenConfig) && isDefined(tokenConfig[chainId])) {
      return true;
    }

    // If any of the mapped symbols reference chainId, token is enabled.
    return Object.keys(tokenConfig).some((symbol) => isDefined(tokenConfig[symbol][chainId]));
  }

  /**
   * @notice Return possible repayment chains for L1 token that have "slow withdrawals" from L2 to L1, so
   * taking repayment on these chains would be done to reduce HubPool utilization and keep funds out of the
   * slow withdrawal canonical bridges.
   * @param l1Token
   * @returns list of chains for l1Token that have a token config enabled and have pool rebalance routes set.
   */
  getSlowWithdrawalRepaymentChains(l1Token: EvmAddress): number[] {
    return SLOW_WITHDRAWAL_CHAINS.filter(
      (chainId) =>
        this._l1TokenEnabledForChain(l1Token, Number(chainId)) &&
        this.hubPoolClient.l2TokenEnabledForL1Token(l1Token, Number(chainId))
    );
  }

  log(message: string, data?: AnyObject, level: DefaultLogLevels = "debug"): void {
    if (this.logger) {
      this.logger[level]({ at: "InventoryClient", message, ...data });
    }
  }
}
