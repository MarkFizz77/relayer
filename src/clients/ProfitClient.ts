import { Provider } from "@ethersproject/abstract-provider";
import { inspect } from "util";
import { utils as ethersUtils } from "ethers";
import { constants as sdkConsts, relayFeeCalculator, typeguards, utils as sdkUtils } from "@across-protocol/sdk";
import * as constants from "../common/Constants";
import {
  assert,
  bnOne,
  bnZero,
  bnUint256Max as uint256Max,
  fixedPointAdjustment as fixedPoint,
  BigNumber,
  formatFeePct,
  getCurrentTime,
  isDefined,
  min,
  winston,
  toBNWei,
  toBN,
  assign,
  CHAIN_IDs,
  TOKEN_SYMBOLS_MAP,
  TOKEN_EQUIVALENCE_REMAPPING,
  ZERO_ADDRESS,
  ZERO_BYTES,
  formatGwei,
  fixedPointAdjustment,
  getRemoteTokenForL1Token,
  getTokenInfo,
  dedupArray,
  SVMProvider,
  isEVMSpokePoolClient,
  isSVMSpokePoolClient,
  getDeployedAddress,
  chainIsEvm,
  EvmAddress,
  Address,
  SvmAddress,
  toAddressType,
  convertRelayDataParamsToBytes32,
  PriceClient,
  acrossApi,
  coingecko,
  defiLlama,
} from "../utils";
import { Deposit, DepositWithBlock, L1Token, SpokePoolClientsByChain } from "../interfaces";
import { getAcrossHost } from "./AcrossAPIClient";
import { HubPoolClient } from "./HubPoolClient";

type TransactionCostEstimate = sdkUtils.TransactionCostEstimate;

const { isError, isEthersError } = typeguards;
const { formatEther } = ethersUtils;

const {
  EMPTY_MESSAGE,
  DEFAULT_SIMULATED_RELAYER_ADDRESS: PROD_RELAYER,
  DEFAULT_SIMULATED_RELAYER_ADDRESS_TEST: TEST_RELAYER,
  DEFAULT_SIMULATED_RELAYER_ADDRESS_SVM: SVM_RELAYER,
} = sdkConsts;

const { getNativeTokenSymbol, isMessageEmpty, resolveDepositMessage } = sdkUtils;

const bn10 = toBN(10);

// @note All FillProfit BigNumbers are scaled to 18 decimals unless specified otherwise.
export type FillProfit = {
  inputTokenPriceUsd: BigNumber;
  inputAmountUsd: BigNumber;
  outputTokenPriceUsd: BigNumber;
  outputAmountUsd: BigNumber;
  grossRelayerFeePct: BigNumber; // Max of relayerFeePct and newRelayerFeePct from Deposit.
  grossRelayerFeeUsd: BigNumber; // USD value of the relay fee paid by the user.
  nativeGasCost: BigNumber; // Cost of completing the fill in the units of gas.
  tokenGasCost: BigNumber; // Cost of completing the fill in the relevant gas token.
  gasPrice: BigNumber; // Gas price in wei.
  gasPadding: BigNumber; // Positive padding applied to nativeGasCost and tokenGasCost before profitability.
  gasMultiplier: BigNumber; // Gas multiplier applied to fill cost estimates before profitability.
  gasTokenPriceUsd: BigNumber; // Price paid per unit of gas the gas token in USD.
  gasCostUsd: BigNumber; // Estimated cost of completing the fill in USD.
  netRelayerFeePct: BigNumber; // Relayer fee after gas costs as a portion of relayerCapitalUsd.
  netRelayerFeeUsd: BigNumber; // Relayer fee in USD after paying for gas costs.
  totalFeePct: BigNumber; // Total fee as a portion of the fill amount.
  profitable: boolean; // Fill profitability indicator.
};

type UnprofitableFill = {
  deposit: DepositWithBlock;
  lpFeePct: BigNumber;
  relayerFeePct: BigNumber;
  gasCost: BigNumber;
};

// @dev This address is known on each chain and has previously been used to simulate Deposit gas costs.
// Since _some_ known recipient address is needed for simulating a fill, default to this one. nb. Since
// the SpokePool implements custom behaviour when relayer === recipient, it's important not to use the
// relayer's own address. The specified address is deliberately setup by RL to have a 0 token balance.
const TEST_RECIPIENT = "0xBb23Cd0210F878Ea4CcA50e9dC307fb0Ed65Cf6B";

export class ProfitClient {
  private readonly priceClient: PriceClient;
  protected minRelayerFees: { [route: string]: BigNumber } = {};
  protected tokenSymbolMap: { [symbol: string]: string } = {};
  protected tokenPrices: { [address: string]: BigNumber } = {};
  private unprofitableFills: { [chainId: number]: UnprofitableFill[] } = {};

  // Track total gas costs of a relay on each chain.
  protected totalGasCosts: { [chainId: number]: TransactionCostEstimate } = {};

  // Queries needed to fetch relay gas costs.
  private relayerFeeQueries: { [chainId: number]: relayFeeCalculator.QueryInterface } = {};

  private readonly isTestnet: boolean;

  // @todo: Consolidate this set of args before it grows legs and runs away from us.
  constructor(
    readonly logger: winston.Logger,
    readonly hubPoolClient: HubPoolClient,
    spokePoolClients: SpokePoolClientsByChain,
    readonly enabledChainIds: number[],
    readonly relayerAddress: Address,
    readonly defaultMinRelayerFeePct = toBNWei(constants.RELAYER_MIN_FEE_PCT),
    readonly debugProfitability = false,
    protected gasMultiplier = toBNWei(constants.DEFAULT_RELAYER_GAS_MULTIPLIER),
    protected gasMessageMultiplier = toBNWei(constants.DEFAULT_RELAYER_GAS_MESSAGE_MULTIPLIER),
    protected gasPadding = toBNWei(constants.DEFAULT_RELAYER_GAS_PADDING),
    readonly additionalL1Tokens: EvmAddress[] = []
  ) {
    // Require 0% <= gasPadding <= 200%
    assert(
      this.gasPadding.gte(bnZero) && this.gasPadding.lte(toBNWei(2)),
      `Gas padding out of range (${this.gasPadding})`
    );
    this.gasPadding = toBNWei("1").add(gasPadding);

    // Require 0% <= gasMultiplier <= 400%
    assert(
      this.gasMultiplier.gte(bnZero) && this.gasMultiplier.lte(toBNWei(4)),
      `Gas multiplier out of range (${this.gasMultiplier})`
    );
    assert(
      this.gasMessageMultiplier.gte(bnZero) && this.gasMessageMultiplier.lte(toBNWei(4)),
      `Gas message multiplier out of range (${this.gasMessageMultiplier})`
    );

    this.priceClient = new PriceClient(logger, [
      new acrossApi.PriceFeed({ host: getAcrossHost(hubPoolClient.chainId) }),
      new coingecko.PriceFeed({ apiKey: process.env.COINGECKO_PRO_API_KEY }),
      new defiLlama.PriceFeed(),
    ]);

    for (const chainId of this.enabledChainIds) {
      const spokePoolClient = spokePoolClients[chainId];
      let provider;
      if (isEVMSpokePoolClient(spokePoolClient)) {
        provider = spokePoolClient.spokePool.provider;
      } else if (isSVMSpokePoolClient(spokePoolClient)) {
        provider = spokePoolClient.svmEventsClient.getRpc();
      }
      this.relayerFeeQueries[chainId] = this.constructRelayerFeeQuery(chainId, provider);
    }

    this.isTestnet = this.hubPoolClient.chainId !== CHAIN_IDs.MAINNET;
  }

  resolveGasMultiplier(deposit: Deposit): BigNumber {
    return isMessageEmpty(resolveDepositMessage(deposit)) ? this.gasMultiplier : this.gasMessageMultiplier;
  }

  resolveGasToken(chainId: number): L1Token {
    const symbol = getNativeTokenSymbol(chainId);
    const token = TOKEN_SYMBOLS_MAP[symbol];
    if (!isDefined(symbol) || !isDefined(token)) {
      throw new Error(`Unable to resolve gas token for chain ID ${chainId}`);
    }

    const { decimals, addresses } = token;
    const address = addresses[1]; // Mainnet tokens are always used for price lookups.

    return { symbol, address, decimals };
  }

  getAllPrices(): { [address: string]: BigNumber } {
    return this.tokenPrices;
  }

  /**
   * Convenience function to resolve a token symbol to its underlying address.
   * @notice In case that an address is supplied, it will simply be returned as-is.
   * @param token Token address or symbol to resolve.
   * @returns Address corresponding to token.
   */
  resolveTokenAddress(token: string): Address {
    if (ethersUtils.isAddress(token)) {
      return toAddressType(token, CHAIN_IDs.MAINNET);
    }
    try {
      return SvmAddress.from(token);
    } catch {
      // The token address is neither an SVM address nor an EVM address, so it must be a symbol.
    }
    const remappedTokenSymbol = TOKEN_EQUIVALENCE_REMAPPING[token] ?? token;
    // In case we have an entry in `TOKEN_EQUIVALENCE_REMAPPING` which maps the native token symbol to its wrapped variant (e.g. BNB -> WBNB),
    // also check if the token symbols map has the non-remapped token symbol stored as a fallback.
    const address = this.tokenSymbolMap[remappedTokenSymbol] ?? this.tokenSymbolMap[token];
    assert(
      isDefined(address),
      `ProfitClient#resolveTokenAddress: Unable to resolve address for token ${token} (using remapped symbol ${remappedTokenSymbol})`
    );
    // We need to get the chain ID corresponding to the address, but we don't have access to this information in this function, so we instead
    // infer the chain ID as either an EVM chain ID or an SVM chain ID based on the format of the address (since the tokenSymbolMap should be
    // well formed).
    const chainId = ethersUtils.isAddress(address) ? CHAIN_IDs.MAINNET : CHAIN_IDs.SOLANA;
    return toAddressType(address, chainId);
  }

  /**
   * Return the cached price for token.
   * @param token Token identifier. May be a token symbol or token address on the HubPool chain.
   * @returns Token token price for token.
   */
  getPriceOfToken(token: string): BigNumber {
    const address = this.resolveTokenAddress(token);
    const price = this.tokenPrices[address.toNative()];
    if (!isDefined(price)) {
      this.logger.warn({ at: "ProfitClient#getPriceOfToken", message: `Token ${token} not in price list.`, address });
      return bnZero;
    }

    return price;
  }

  private async _getTotalGasCost(
    deposit: Omit<Deposit, "messageHash">,
    relayer: Address
  ): Promise<TransactionCostEstimate> {
    try {
      return await this.relayerFeeQueries[deposit.destinationChainId].getGasCosts(deposit, relayer);
    } catch (err) {
      const reason = isEthersError(err) ? err.reason : isError(err) ? err.message : "unknown error";
      // Attempt to extract an underlying cause, if the error object exposes one. This is
      // helpful for Solana errors, where standard `cause` property of Error is populated
      let cause: string | undefined;
      if (err && typeof err === "object" && "cause" in err) {
        const _cause = (err as { cause?: unknown }).cause;
        if (_cause) {
          cause = isError(_cause)
            ? _cause.message
            : // For non-Error objects (including those containing BigInts), use util.inspect for a
              // readable representation that won’t throw on JSON.stringify. This prints BigInts as
              // “123n” and provides depth-limited details rather than the unhelpful "[object Object]".
              inspect(_cause, { depth: 3, breakLength: 120 });
        }
      }
      this.logger.warn({
        at: "ProfitClient#getTotalGasCost",
        message: "Failed to simulate fill for deposit.",
        reason,
        cause,
        deposit: convertRelayDataParamsToBytes32(deposit),
        notificationPath: "across-warn",
      });
      return { nativeGasCost: uint256Max, tokenGasCost: uint256Max, gasPrice: uint256Max };
    }
  }

  async getTotalGasCost(deposit: Deposit): Promise<TransactionCostEstimate> {
    const { destinationChainId: chainId } = deposit;

    // If there's no attached message, gas consumption from previous fills can be used in most cases.
    // @todo: Simulate this per-token in future, because some ERC20s consume more gas.
    if (isMessageEmpty(resolveDepositMessage(deposit)) && isDefined(this.totalGasCosts[chainId])) {
      return this.totalGasCosts[chainId];
    }

    return this._getTotalGasCost(deposit, this.relayerAddress);
  }

  getGasCostsForChain(chainId: number): TransactionCostEstimate {
    return this.totalGasCosts[chainId];
  }

  // Estimate the gas cost of filling this relay.
  async estimateFillCost(
    deposit: Deposit
  ): Promise<Pick<FillProfit, "nativeGasCost" | "tokenGasCost" | "gasTokenPriceUsd" | "gasCostUsd" | "gasPrice">> {
    const { destinationChainId: chainId } = deposit;

    const gasToken = this.resolveGasToken(chainId);
    const gasTokenPriceUsd = this.getPriceOfToken(gasToken.symbol);
    const totalGasCost = await this.getTotalGasCost(deposit);
    let { nativeGasCost, tokenGasCost } = totalGasCost;
    const gasPrice = totalGasCost.gasPrice;

    Object.entries({
      "gas consumption": nativeGasCost, // raw gas units
      "gas cost": tokenGasCost, // gas token (i.e. wei)
      "gas token price": gasTokenPriceUsd, // usd/gasToken
    }).forEach(([err, field]) => {
      if (field.eq(uint256Max) || field.lte(bnZero)) {
        throw new Error(`Unable to compute gas cost (${err} unknown)`);
      }
    });

    // Fills with messages have arbitrary execution and therefore lower certainty about the simulated execution cost.
    // Pad these estimates before computing profitability to allow execution headroom and reduce the chance of an OoG.
    nativeGasCost = nativeGasCost.mul(this.gasPadding).div(fixedPoint);
    tokenGasCost = tokenGasCost.mul(this.gasPadding).div(fixedPoint);

    // Gas estimates for token-only fills are stable and reliable. Allow these to be scaled up or down via the
    // configured gasMultiplier. Do not scale the nativeGasCost, since it might be used to set the transaction gasLimit.
    // @todo Consider phasing this out and relying solely on the minimum profitability config.
    const gasMultiplier = this.resolveGasMultiplier(deposit);
    tokenGasCost = tokenGasCost.mul(gasMultiplier).div(fixedPoint);

    const gasCostUsd = tokenGasCost.mul(gasTokenPriceUsd).div(bn10.pow(gasToken.decimals));

    return {
      nativeGasCost,
      tokenGasCost,
      gasPrice,
      gasTokenPriceUsd,
      gasCostUsd,
    };
  }

  getUnprofitableFills(): { [chainId: number]: UnprofitableFill[] } {
    return this.unprofitableFills;
  }

  clearUnprofitableFills(): void {
    this.unprofitableFills = {};
  }

  /**
   * Allow the minimum relayer fee to be overridden per token/route:
   * 0.1bps on USDC from Optimism to Arbitrum:
   *   - MIN_RELAYER_FEE_PCT_USDC_42161_10=0.00001
   * @param symbol Token symbol to query.
   * @param symbol srcChainId Origin chain for deposit.
   * @param symbol dstChainId Destination chain for deposit.
   * @returns The minimum required fee multiplier for the specified token/route combination.
   */
  minRelayerFeePct(symbol: string, srcChainId: number, dstChainId: number): BigNumber {
    const effectiveSymbol = TOKEN_EQUIVALENCE_REMAPPING[symbol] ?? symbol;

    const tokenKey = `MIN_RELAYER_FEE_PCT_${effectiveSymbol}`;
    const routeKey = `${tokenKey}_${srcChainId}_${dstChainId}`;
    let minRelayerFeePct = this.minRelayerFees[routeKey] ?? this.minRelayerFees[tokenKey];

    if (!minRelayerFeePct) {
      const _minRelayerFeePct = process.env[routeKey] ?? process.env[tokenKey];
      minRelayerFeePct = _minRelayerFeePct ? toBNWei(_minRelayerFeePct) : this.defaultMinRelayerFeePct;

      // Save the route for next time.
      this.minRelayerFees[routeKey] = minRelayerFeePct;
    }

    return minRelayerFeePct;
  }

  /**
   * @param deposit Deposit object.
   * @param lpFeePct Predetermined LP fee as a multiplier of the deposit inputAmount.
   * @param minRelayerFeePct Relayer minimum fee requirements.
   * @returns FillProfit object detailing the profitability breakdown.
   */
  async calculateFillProfitability(
    deposit: Deposit,
    lpFeePct: BigNumber,
    minRelayerFeePct: BigNumber
  ): Promise<FillProfit> {
    const { hubPoolClient } = this;

    const inputTokenInfo = hubPoolClient.getTokenInfoForAddress(deposit.inputToken, deposit.originChainId);
    const inputTokenPriceUsd = this.getPriceOfToken(inputTokenInfo.symbol);
    const inputTokenScalar = toBNWei(1, 18 - inputTokenInfo.decimals);
    const scaledInputAmount = deposit.inputAmount.mul(inputTokenScalar);
    const inputAmountUsd = scaledInputAmount.mul(inputTokenPriceUsd).div(fixedPoint);

    // Unlike the input token, output token is not always resolvable via HubPoolClient since outputToken
    // can be any arbitrary token.
    const { symbol: outputTokenSymbol, decimals: outputTokenDecimals } = hubPoolClient.getTokenInfoForAddress(
      deposit.outputToken,
      deposit.destinationChainId
    );
    const outputTokenPriceUsd = this.getPriceOfToken(outputTokenSymbol);
    const outputTokenScalar = toBNWei(1, 18 - outputTokenDecimals);
    const effectiveOutputAmount = min(deposit.outputAmount, deposit.updatedOutputAmount ?? deposit.outputAmount);
    const scaledOutputAmount = effectiveOutputAmount.mul(outputTokenScalar);
    const outputAmountUsd = scaledOutputAmount.mul(outputTokenPriceUsd).div(fixedPoint);

    const totalFeePct = inputAmountUsd.sub(outputAmountUsd).mul(fixedPoint).div(inputAmountUsd);

    // Normalise token amounts to USD terms.
    const scaledLpFeeAmount = scaledInputAmount.mul(lpFeePct).div(fixedPoint);
    const lpFeeUsd = scaledLpFeeAmount.mul(inputTokenPriceUsd).div(fixedPoint);

    // Infer gross relayer fee (excluding gas cost of fill).
    const grossRelayerFeeUsd = inputAmountUsd.sub(outputAmountUsd).sub(lpFeeUsd);
    const grossRelayerFeePct = grossRelayerFeeUsd.gt(bnZero)
      ? grossRelayerFeeUsd.mul(fixedPoint).div(inputAmountUsd)
      : bnZero;

    // Estimate the gas cost of filling this relay.
    const { nativeGasCost, tokenGasCost, gasTokenPriceUsd, gasCostUsd, gasPrice } = await this.estimateFillCost(
      deposit
    );

    // Determine profitability. netRelayerFeePct effectively represents the capital cost to the relayer;
    // i.e. how much it pays out to the recipient vs. the net fee that it receives for doing so.
    const netRelayerFeeUsd = grossRelayerFeeUsd.sub(gasCostUsd);
    const netRelayerFeePct = outputAmountUsd.gt(bnZero)
      ? netRelayerFeeUsd.mul(fixedPoint).div(outputAmountUsd)
      : bnZero;

    // If either token prices are unknown, assume the relay is unprofitable.
    const profitable =
      inputTokenPriceUsd.gt(bnZero) && outputTokenPriceUsd.gt(bnZero) && netRelayerFeePct.gte(minRelayerFeePct);

    return {
      totalFeePct,
      inputTokenPriceUsd,
      inputAmountUsd,
      outputTokenPriceUsd,
      outputAmountUsd,
      grossRelayerFeePct,
      grossRelayerFeeUsd,
      nativeGasCost,
      tokenGasCost,
      gasPrice,
      gasPadding: this.gasPadding,
      gasMultiplier: this.resolveGasMultiplier(deposit),
      gasTokenPriceUsd,
      gasCostUsd,
      netRelayerFeePct,
      netRelayerFeeUsd,
      profitable,
    };
  }

  // Return USD amount of fill amount for deposited token, should always return in wei as the units.
  getFillAmountInUsd(
    deposit: Pick<Deposit, "destinationChainId" | "outputToken" | "outputAmount">
  ): BigNumber | undefined {
    const { destinationChainId, outputToken, outputAmount } = deposit;

    const { symbol, decimals } = this.hubPoolClient.getTokenInfoForAddress(outputToken, destinationChainId);
    const tokenPriceInUsd = this.getPriceOfToken(symbol);

    // The USD amount of a fill must be normalised to 18 decimals, so factor out the token's own decimal promotion.
    return outputAmount.mul(tokenPriceInUsd).div(bn10.pow(decimals));
  }

  protected getTokenSymbol(token: Address, chainId: number): string {
    try {
      const { symbol } = getTokenInfo(token, chainId);
      return symbol;
    } catch (e) {
      return "UNKNOWN";
    }
  }

  async getFillProfitability(
    deposit: Deposit,
    lpFeePct: BigNumber,
    l1Token: EvmAddress,
    repaymentChainId: number
  ): Promise<FillProfit> {
    const symbol = this.getTokenSymbol(l1Token, this.hubPoolClient.chainId);
    const minRelayerFeePct = this.minRelayerFeePct(symbol, deposit.originChainId, deposit.destinationChainId);

    const fill = await this.calculateFillProfitability(deposit, lpFeePct, minRelayerFeePct);
    if (!fill.profitable || this.debugProfitability) {
      const { depositId } = deposit;
      const profitable = fill.profitable ? "profitable" : "unprofitable";

      this.logger.debug({
        at: "ProfitClient#getFillProfitability",
        message: `${symbol} deposit ${depositId.toString()} with repayment on ${repaymentChainId} is ${profitable}`,
        deposit: convertRelayDataParamsToBytes32(deposit),
        inputTokenPriceUsd: formatEther(fill.inputTokenPriceUsd),
        inputTokenAmountUsd: formatEther(fill.inputAmountUsd),
        outputTokenPriceUsd: formatEther(fill.inputTokenPriceUsd),
        outputTokenAmountUsd: formatEther(fill.outputAmountUsd),
        totalFeePct: `${formatFeePct(fill.totalFeePct)}%`,
        lpFeePct: `${formatFeePct(lpFeePct)}%`,
        grossRelayerFeePct: `${formatFeePct(fill.grossRelayerFeePct)}%`,
        nativeGasCost: fill.nativeGasCost,
        tokenGasCost: formatEther(fill.tokenGasCost),
        gasPrice: formatGwei(fill.gasPrice.toString()),
        gasPadding: this.gasPadding,
        gasMultiplier: formatEther(this.resolveGasMultiplier(deposit)),
        gasTokenPriceUsd: formatEther(fill.gasTokenPriceUsd),
        grossRelayerFeeUsd: formatEther(fill.grossRelayerFeeUsd),
        gasCostUsd: formatEther(fill.gasCostUsd),
        netRelayerFeeUsd: formatEther(fill.netRelayerFeeUsd),
        netRelayerFeePct: `${formatFeePct(fill.netRelayerFeePct)}%`,
        minRelayerFeePct: `${formatFeePct(minRelayerFeePct)}%`,
        profitable: fill.profitable,
      });
    }

    return fill;
  }

  async isFillProfitable(
    deposit: Deposit,
    lpFeePct: BigNumber,
    l1Token: EvmAddress,
    repaymentChainId: number
  ): Promise<Pick<FillProfit, "profitable" | "nativeGasCost" | "gasPrice" | "tokenGasCost" | "netRelayerFeePct">> {
    let profitable = false;
    let netRelayerFeePct = bnZero;
    let nativeGasCost = uint256Max;
    let tokenGasCost = uint256Max;
    let gasPrice = uint256Max;
    try {
      ({ profitable, netRelayerFeePct, nativeGasCost, tokenGasCost, gasPrice } = await this.getFillProfitability(
        deposit,
        lpFeePct,
        l1Token,
        repaymentChainId
      ));
    } catch (err) {
      this.logger.debug({
        at: "ProfitClient#isFillProfitable",
        message: `Unable to determine fill profitability (${err}).`,
        deposit: convertRelayDataParamsToBytes32(deposit),
        lpFeePct,
      });
    }

    return {
      profitable: profitable || (this.isTestnet && nativeGasCost.lt(uint256Max)),
      nativeGasCost,
      tokenGasCost,
      gasPrice,
      netRelayerFeePct,
    };
  }

  captureUnprofitableFill(
    deposit: DepositWithBlock,
    lpFeePct: BigNumber,
    relayerFeePct: BigNumber,
    gasCost: BigNumber
  ): void {
    this.logger.debug({
      at: "ProfitClient",
      message: "Handling unprofitable fill",
      deposit: convertRelayDataParamsToBytes32(deposit),
      lpFeePct,
      relayerFeePct,
      gasCost,
    });
    assign(this.unprofitableFills, [deposit.originChainId], [{ deposit, lpFeePct, relayerFeePct, gasCost }]);
  }

  anyCapturedUnprofitableFills(): boolean {
    return Object.keys(this.unprofitableFills).length != 0;
  }

  async update(): Promise<void> {
    await Promise.all([this.updateTokenPrices(), this.updateGasCosts()]);
  }

  protected async updateTokenPrices(): Promise<void> {
    const l1Tokens = this._getL1Tokens();
    // Generate list of tokens to retrieve. Map by symbol because tokens like
    // ETH/WETH refer to the same mainnet contract address.
    const tokens: { [_symbol: string]: string } = Object.fromEntries(
      l1Tokens
        .map(({ symbol: _symbol }) => {
          // If the L1 token is defined in token symbols map, then use the L1 token symbol. Otherwise, use the remapping in constants.
          const symbol = isDefined(TOKEN_SYMBOLS_MAP[_symbol]) ? _symbol : TOKEN_EQUIVALENCE_REMAPPING[_symbol];
          if (!isDefined(symbol)) {
            // If the symbol is undefined, then there is missing configuration in the constants repository.
            // Throw an error if we are on mainnet, since this indicates that we are attempting to fetch prices for an unsupported token.
            // If we are on testnet, return undefined. This is necessary since there are multiple "mock" tokens enabled on L1 intentionally without
            // entries in `TOKEN_SYMBOLS_MAP`.
            if (this.isTestnet) {
              return [undefined, undefined];
            }
            throw new Error(`${_symbol} has no definition in TOKEN_SYMBOLS_MAP or TOKEN_EQUIVALENCE_REMAPPING`);
          }

          const { addresses } = TOKEN_SYMBOLS_MAP[symbol];
          let address = addresses[CHAIN_IDs.MAINNET];
          // For testnet only, if we cannot resolve the token address, revert to ETH. On mainnet, if `address` is undefined,
          // we will throw an error instead.
          if (this.hubPoolClient.chainId === CHAIN_IDs.SEPOLIA && !isDefined(address)) {
            address = TOKEN_SYMBOLS_MAP.ETH.addresses[CHAIN_IDs.MAINNET];
          }
          return [symbol, address];
        })
        .filter(([symbol, address]) => isDefined(address) && isDefined(symbol))
    );

    // Log any tokens that are in the L1Tokens list but are not in the tokenSymbolsMap.
    // Note: we should batch these up and log them all at once to avoid spamming the logs.
    const unknownTokens = l1Tokens.filter(
      ({ symbol }) => !isDefined(TOKEN_SYMBOLS_MAP[symbol]) && !isDefined(TOKEN_EQUIVALENCE_REMAPPING[symbol])
    );
    if (unknownTokens.length > 0) {
      this.logger.debug({
        at: "ProfitClient#updateTokenPrices",
        message: "Filtered out unknown token(s) that don't have a corresponding entry in TOKEN_SYMBOLS_MAP.",
        unknownTokens,
        resolvedTokens: Object.keys(tokens),
        availableTokens: Object.keys(TOKEN_SYMBOLS_MAP),
      });
    }

    // Also ensure all gas tokens are included in the lookup.
    this.enabledChainIds.forEach((chainId) => {
      const symbol = getNativeTokenSymbol(chainId);
      let nativeTokenAddress = TOKEN_SYMBOLS_MAP[symbol]?.addresses[this._getNativeTokenNetwork(symbol)];
      // For testnet only, if the custom gas token has no mainnet address, use ETH.
      if (this.hubPoolClient.chainId === CHAIN_IDs.SEPOLIA && !isDefined(nativeTokenAddress)) {
        nativeTokenAddress = TOKEN_SYMBOLS_MAP["ETH"].addresses[CHAIN_IDs.MAINNET];
      }
      tokens[symbol] ??= nativeTokenAddress;
    });

    this.logger.debug({ at: "ProfitClient", message: "Updating Profit client", tokens });

    // Pre-populate any new addresses.
    Object.entries(tokens).forEach(([symbol, address]) => {
      this.tokenSymbolMap[symbol] ??= address;
      this.tokenPrices[address] ??= bnZero;
    });

    try {
      const tokenAddrs = Array.from(new Set(Object.values(tokens)));
      const tokenPrices = await this.priceClient.getPricesByAddress(tokenAddrs, "usd");
      tokenPrices.forEach(({ address, price }) => (this.tokenPrices[address] = toBNWei(price)));
      this.logger.debug({ at: "ProfitClient", message: "Updated token prices", tokenPrices: this.tokenPrices });
    } catch (err) {
      const errMsg = `Failed to update token prices (${err})`;
      let mrkdwn = `${errMsg}:\n`;
      Object.entries(tokens).forEach(([symbol, address]) => {
        mrkdwn += `- Using last known ${symbol} price of ${this.getPriceOfToken(address)}.\n`;
      });
      this.logger.warn({ at: "ProfitClient", message: "Could not fetch all token prices 💳", mrkdwn });
      throw new Error(errMsg);
    }
  }

  private async updateGasCosts(): Promise<void> {
    const { enabledChainIds, hubPoolClient } = this;
    const outputAmount = toBN(100); // Avoid rounding to zero but ensure the relayer has sufficient balance to estimate.
    const currentTime = getCurrentTime();

    // Prefer USDC on mainnet because it is consistent in terms of gas estimation (no unwrap conditional).
    // Prefer WETH on testnet because it is more likely to be configured for the destination SpokePool.
    // The relayer _cannot_ be the recipient because the SpokePool skips the ERC20 transfer. Instead, use
    // the main RL address because it has all supported tokens and approvals in place on all chains.
    const testSymbols = {
      [CHAIN_IDs.ALEPH_ZERO]: "USDT", // USDC is not yet supported on AlephZero, so revert to USDT. @todo: Update.
      [CHAIN_IDs.BLAST]: "USDB",
      [CHAIN_IDs.INK]: "WETH", // USDC deferred on Ink.
      [CHAIN_IDs.LENS]: "WETH", // USDC not yet supported.
      [CHAIN_IDs.LISK]: "USDT", // USDC is not yet supported on Lisk, so revert to USDT. @todo: Update.
      [CHAIN_IDs.REDSTONE]: "WETH", // Redstone only supports WETH.
      [CHAIN_IDs.SONEIUM]: "WETH", // USDC deferred on Soneium.
      [CHAIN_IDs.WORLD_CHAIN]: "WETH", // USDC deferred on World Chain.
      [CHAIN_IDs.LENS_SEPOLIA]: "WETH", // No USD token on Lens Sepolia
      [CHAIN_IDs.TATARA]: "WETH",
    };
    const prodRelayer = process.env.RELAYER_FILL_SIMULATION_ADDRESS ?? PROD_RELAYER;
    const [defaultTestSymbol, _relayer] =
      this.hubPoolClient.chainId === CHAIN_IDs.MAINNET ? ["USDC", prodRelayer] : ["WETH", TEST_RELAYER];

    // Pre-fetch total gas costs for relays on enabled chains.
    const totalGasCostsToLog = Object.fromEntries(
      await sdkUtils.mapAsync(enabledChainIds, async (destinationChainId) => {
        // @dev We need set the recipient/relayer to a valid address on the destination network in order for the gas query to succeed.
        const destinationAddress = toAddressType(
          chainIsEvm(destinationChainId) ? TEST_RECIPIENT : SVM_RELAYER,
          destinationChainId
        );
        const relayer = chainIsEvm(destinationChainId) ? _relayer : SVM_RELAYER;
        const sampleDeposit = {
          depositId: bnZero,
          depositor: toAddressType(TEST_RECIPIENT, CHAIN_IDs.MAINNET),
          recipient: destinationAddress,
          inputToken: toAddressType(ZERO_ADDRESS, CHAIN_IDs.MAINNET), // Not verified by the SpokePool.
          inputAmount: outputAmount.add(bnOne),
          outputToken: "", // SpokePool-specific, overwritten later.
          outputAmount,
          originChainId: 0, // Not verified by the SpokePool.
          destinationChainId: 0, // SpokePool-specific, overwritten later.
          quoteTimestamp: currentTime - 60,
          fillDeadline: currentTime + 60,
          exclusivityDeadline: 0,
          exclusiveRelayer: toAddressType(
            chainIsEvm(destinationChainId) ? ZERO_ADDRESS : ZERO_BYTES,
            destinationChainId
          ),
          message: EMPTY_MESSAGE,
          fromLiteChain: false,
          toLiteChain: false,
        };
        const symbol = testSymbols[destinationChainId] ?? defaultTestSymbol;
        const hubToken = EvmAddress.from(TOKEN_SYMBOLS_MAP[symbol].addresses[this.hubPoolClient.chainId]);
        const outputToken =
          destinationChainId === hubPoolClient.chainId
            ? hubToken
            : getRemoteTokenForL1Token(hubToken, destinationChainId, this.hubPoolClient.chainId);
        assert(isDefined(outputToken), `Chain ${destinationChainId} SpokePool is not configured for ${symbol}`);

        const deposit = { ...sampleDeposit, destinationChainId, outputToken };
        const gasCosts = await this._getTotalGasCost(deposit, toAddressType(relayer, destinationChainId));
        // The scaledNativeGasCost is approximately what the relayer will set as the `gasLimit` when submitting
        // fills on the destination chain.
        const scaledNativeGasCost = gasCosts.nativeGasCost.mul(this.gasPadding).div(fixedPointAdjustment);
        // The scaledTokenGasCost is the estimated gas cost of submitting a fill on the destination chain and is used
        // in the this.estimateFillCost function to determine whether a deposit is profitable to fill. Therefore,
        // the scaledTokenGasCost should be safely lower than the quote API's tokenGasCosts in order for the relayer
        // to consider a deposit is profitable.
        const scaledTokenGasCost = gasCosts.tokenGasCost
          .mul(this.gasPadding)
          .div(fixedPointAdjustment)
          .mul(this.gasMultiplier)
          .div(fixedPointAdjustment);
        this.totalGasCosts[destinationChainId] = gasCosts;
        return [
          destinationChainId,
          {
            ...gasCosts,
            scaledNativeGasCost,
            scaledTokenGasCost,
            gasPadding: formatEther(this.gasPadding),
            gasMultiplier: formatEther(this.gasMultiplier),
          },
        ];
      })
    );

    this.logger.debug({
      at: "ProfitClient",
      message: "Updated gas cost",
      enabledChainIds: this.enabledChainIds,
      totalGasCosts: totalGasCostsToLog,
    });
  }

  private _getL1Tokens(): L1Token[] {
    // The L1 tokens should be the hub pool tokens plus any extra configured tokens in the inventory config.
    const hubPoolTokens = this.hubPoolClient.getL1Tokens();
    const additionalL1Tokens = this.additionalL1Tokens.map((l1Token) => {
      const l1TokenInfo = getTokenInfo(l1Token, this.hubPoolClient.chainId);
      assert(l1TokenInfo.address.isEVM());
      return {
        ...l1TokenInfo,
        address: l1TokenInfo.address,
      };
    });
    return dedupArray([...hubPoolTokens, ...additionalL1Tokens]);
  }

  private _getNativeTokenNetwork(symbol: string): number {
    return symbol === "SOL" ? CHAIN_IDs.SOLANA : CHAIN_IDs.MAINNET;
  }

  private constructRelayerFeeQuery(
    chainId: number,
    provider: Provider | SVMProvider
  ): relayFeeCalculator.QueryInterface {
    // Fallback to Coingecko's free API for now.
    // TODO: Add support for Coingecko Pro.
    const coingeckoProApiKey = undefined;
    // Call the factory to create a new QueryBase instance.
    return relayFeeCalculator.QueryBase__factory.create(
      chainId,
      provider,
      undefined, // symbolMapping
      chainIsEvm(chainId) ? undefined : getDeployedAddress("SvmSpoke", chainId), // spokePoolAddress
      undefined, // simulatedRelayerAddress
      coingeckoProApiKey,
      this.logger
    );
  }
}
