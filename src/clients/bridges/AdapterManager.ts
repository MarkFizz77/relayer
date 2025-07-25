import { utils } from "@across-protocol/sdk";
import {
  spokesThatHoldNativeTokens,
  SUPPORTED_TOKENS,
  CUSTOM_BRIDGE,
  CANONICAL_BRIDGE,
  DEFAULT_GAS_MULTIPLIER,
  CUSTOM_L2_BRIDGE,
  CANONICAL_L2_BRIDGE,
} from "../../common/Constants";
import { InventoryConfig, OutstandingTransfers } from "../../interfaces";
import {
  BigNumber,
  isDefined,
  winston,
  Signer,
  getL2TokenAddresses,
  TransactionResponse,
  assert,
  Profiler,
  EvmAddress,
  toAddressType,
  TOKEN_EQUIVALENCE_REMAPPING,
  getRemoteTokenForL1Token,
  getTokenInfo,
  isEVMSpokePoolClient,
  Address,
  isSVMSpokePoolClient,
} from "../../utils";
import { SpokePoolClient, HubPoolClient } from "../";
import { CHAIN_IDs, TOKEN_SYMBOLS_MAP } from "@across-protocol/constants";
import { BaseChainAdapter } from "../../adapter";

export class AdapterManager {
  private profiler: InstanceType<typeof Profiler>;
  public adapters: { [chainId: number]: BaseChainAdapter } = {};

  // Some L2's canonical bridges send ETH, not WETH, over the canonical bridges, resulting in recipient addresses
  // receiving ETH that needs to be wrapped on the L2. This array contains the chainIds of the chains that this
  // manager will attempt to wrap ETH on into WETH. This list also includes chains like Arbitrum where the relayer is
  // expected to receive ETH as a gas refund from an L1 to L2 deposit that was intended to rebalance inventory.
  private chainsToWrapEtherOn = [...spokesThatHoldNativeTokens, CHAIN_IDs.ARBITRUM, CHAIN_IDs.MAINNET];

  constructor(
    readonly logger: winston.Logger,
    readonly spokePoolClients: { [chainId: number]: SpokePoolClient },
    readonly hubPoolClient: HubPoolClient,
    readonly monitoredAddresses: Address[]
  ) {
    if (!spokePoolClients) {
      return;
    }
    const spokePoolAddresses = Object.values(spokePoolClients).map((client) => client.spokePoolAddress);

    // The adapters are only set up to monitor EOA's and the HubPool and SpokePool address, so remove
    // spoke pool addresses from other chains.
    const filterMonitoredAddresses = (chainId: number) => {
      return monitoredAddresses.filter(
        (address) =>
          EvmAddress.from(this.hubPoolClient.hubPool.address).eq(address) ||
          this.spokePoolClients[chainId].spokePoolAddress.eq(address) ||
          !spokePoolAddresses.some((spokePoolAddress) => spokePoolAddress.eq(address))
      );
    };

    const hubChainId = hubPoolClient.chainId;
    const l1Signer = hubPoolClient.hubPool.signer;
    const constructBridges = (chainId: number) => {
      if (chainId === hubChainId) {
        return {};
      } // Special case for the EthereumAdapter

      return Object.fromEntries(
        SUPPORTED_TOKENS[chainId]?.map((symbol) => {
          const spokePoolClient = spokePoolClients[chainId];
          let l2SignerOrProvider;
          if (isEVMSpokePoolClient(spokePoolClient)) {
            l2SignerOrProvider = spokePoolClient.spokePool.signer;
          } else if (isSVMSpokePoolClient(spokePoolClient)) {
            l2SignerOrProvider = spokePoolClient.svmEventsClient.getRpc();
          }
          const l1Token = TOKEN_SYMBOLS_MAP[symbol].addresses[hubChainId];
          const bridgeConstructor = CUSTOM_BRIDGE[chainId]?.[l1Token] ?? CANONICAL_BRIDGE[chainId];
          const bridge = new bridgeConstructor(
            chainId,
            hubChainId,
            l1Signer,
            l2SignerOrProvider,
            EvmAddress.from(l1Token)
          );
          return [l1Token, bridge];
        }) ?? []
      );
    };
    const constructL2Bridges = (chainId: number) => {
      if (chainId === hubChainId) {
        return {};
      }
      const spokePoolClient = spokePoolClients[chainId];
      let l2Signer;
      if (isEVMSpokePoolClient(spokePoolClient)) {
        l2Signer = spokePoolClient.spokePool.signer;
      }
      return Object.fromEntries(
        SUPPORTED_TOKENS[chainId]
          ?.map((symbol) => {
            const l1Token = TOKEN_SYMBOLS_MAP[symbol].addresses[hubChainId];
            const bridgeConstructor = CUSTOM_L2_BRIDGE[chainId]?.[l1Token] ?? CANONICAL_L2_BRIDGE[chainId];
            if (!isDefined(bridgeConstructor)) {
              return undefined;
            }
            const bridge = new bridgeConstructor(chainId, hubChainId, l2Signer, l1Signer, EvmAddress.from(l1Token));
            return [l1Token, bridge];
          })
          .filter(isDefined) ?? []
      );
    };
    Object.values(this.spokePoolClients).map(({ chainId }) => {
      // Instantiate a generic adapter and supply all network-specific configurations.
      this.adapters[chainId] = new BaseChainAdapter(
        spokePoolClients,
        chainId,
        hubChainId,
        filterMonitoredAddresses(chainId),
        logger,
        SUPPORTED_TOKENS[chainId] ?? [],
        constructBridges(chainId),
        constructL2Bridges(chainId),
        DEFAULT_GAS_MULTIPLIER[chainId] ?? 1
      );
    });
    this.profiler = new Profiler({
      logger: this.logger,
      at: "AdapterManager",
    });
    logger.debug({
      at: "AdapterManager#constructor",
      message: "Initialized AdapterManager",
      adapterChains: Object.keys(this.adapters).map((chainId) => Number(chainId)),
    });
  }

  /**
   * @notice Returns list of chains we have adapters for
   * @returns list of chain IDs we have adapters for
   */
  supportedChains(): number[] {
    return Object.keys(this.adapters).map((chainId) => Number(chainId));
  }

  getOutstandingCrossChainTransfers(chainId: number, l1Tokens: EvmAddress[]): Promise<OutstandingTransfers> {
    const adapter = this.adapters[chainId];
    // @dev The adapter should filter out tokens that are not supported by the adapter, but we do it here as well.
    const adapterSupportedL1Tokens = l1Tokens.filter((token) => {
      const tokenSymbol = getTokenInfo(token, this.hubPoolClient.chainId).symbol;
      return (
        adapter.supportedTokens.includes(tokenSymbol) ||
        adapter.supportedTokens.includes(TOKEN_EQUIVALENCE_REMAPPING[tokenSymbol])
      );
    });
    this.logger.debug({
      at: "AdapterManager",
      message: `Getting outstandingCrossChainTransfers for ${chainId}`,
      adapterSupportedL1Tokens: adapterSupportedL1Tokens.map((l1Token) => l1Token.toNative()),
      searchConfigs: adapter.getUpdatedSearchConfigs(),
    });
    return this.adapters[chainId].getOutstandingCrossChainTransfers(adapterSupportedL1Tokens);
  }

  sendTokenCrossChain(
    address: Address,
    chainId: number,
    l1Token: EvmAddress,
    amount: BigNumber,
    simMode = false,
    l2Token?: Address
  ): Promise<TransactionResponse> {
    this.logger.debug({
      at: "AdapterManager",
      message: "Sending token cross-chain",
      chainId,
      l1Token: l1Token.toNative(),
      amount,
    });
    l2Token ??= this.l2TokenForL1Token(l1Token, chainId);
    return this.adapters[chainId].sendTokenToTargetChain(address, l1Token, l2Token, amount, simMode);
  }

  withdrawTokenFromL2(
    address: EvmAddress,
    chainId: number | string,
    l2Token: Address,
    amount: BigNumber,
    simMode = false
  ): Promise<string[]> {
    chainId = Number(chainId);
    this.logger.debug({
      at: "AdapterManager",
      message: "Withdrawing token from L2",
      chainId,
      l2Token: l2Token.toNative(),
      amount,
    });
    const txnReceipts = this.adapters[chainId].withdrawTokenFromL2(address, l2Token, amount, simMode);
    return txnReceipts;
  }

  async getL2PendingWithdrawalAmount(
    lookbackPeriodSeconds: number,
    chainId: number | string,
    fromAddress: Address,
    l2Token: Address
  ): Promise<BigNumber> {
    chainId = Number(chainId);
    return await this.adapters[chainId].getL2PendingWithdrawalAmount(lookbackPeriodSeconds, fromAddress, l2Token);
  }

  // Check how many native tokens are on the target chain and if the number of tokens is above the wrap threshold, execute a wrap. Note that this only
  // needs to be done on chains where rebalancing the native token from L1 to L2 results in the relayer receiving the unwrapped native token
  // (not the ERC20), or if the relayer expects to be sent the native token perhaps as a gas refund from an original L1 to L2
  // deposit. This currently happens on Arbitrum, where the relayer address is set as the Arbitrum_Adapter's
  // L2 refund recipient, and on ZkSync, because the relayer is set as the refund recipient when rebalancing
  // inventory from L1 to ZkSync via the AtomicDepositor.
  async wrapNativeTokenIfAboveThreshold(inventoryConfig: InventoryConfig, simMode = false): Promise<void> {
    await utils.mapAsync(
      this.chainsToWrapEtherOn.filter((chainId) => isDefined(this.spokePoolClients[chainId])),
      async (chainId) => {
        const wrapThreshold =
          inventoryConfig?.wrapEtherThresholdPerChain?.[chainId] ?? inventoryConfig.wrapEtherThreshold;
        const wrapTarget = inventoryConfig?.wrapEtherTargetPerChain?.[chainId] ?? inventoryConfig.wrapEtherTarget;
        assert(
          wrapThreshold.gte(wrapTarget),
          `wrapEtherThreshold ${wrapThreshold.toString()} must be >= wrapEtherTarget ${wrapTarget.toString()}`
        );
        await this.adapters[chainId].wrapNativeTokenIfAboveThreshold(wrapThreshold, wrapTarget, simMode);
      }
    );
  }

  getSigner(chainId: number): Signer {
    const spokePoolClient = this.spokePoolClients[chainId];
    assert(isEVMSpokePoolClient(spokePoolClient));
    return spokePoolClient.spokePool.signer;
  }

  l2TokenForL1Token(l1Token: EvmAddress, chainId: number): Address {
    // the try catch below is a safety hatch. If you try fetch an L2 token that is not within the hubPoolClient for a
    // given L1Token and chainId combo then you are likely trying to send a token to a chain that does not support it.
    try {
      // That the line below is critical. if the hubpoolClient returns the wrong destination token for the L1 token then
      // the bot can irrecoverably send the wrong token to the chain and loose money. It should crash if this is detected.
      const l2TokenForL1Token = getRemoteTokenForL1Token(l1Token, chainId, this.hubPoolClient.chainId);
      if (!l2TokenForL1Token) {
        throw new Error(`No L2 token found for L1 token ${l1Token} on chain ${chainId}`);
      }
      if (!l2TokenForL1Token.eq(toAddressType(getL2TokenAddresses(l1Token.toEvmAddress())[chainId], chainId))) {
        throw new Error(
          `Token address mismatch (${l2TokenForL1Token} != ${getL2TokenAddresses(l1Token.toEvmAddress())[chainId]})`
        );
      }
      return l2TokenForL1Token;
    } catch (error) {
      this.logger.error({
        at: "AdapterManager",
        message: "Implementor attempted to get a l2 token address for an L1 token that does not exist in the routings!",
        l1Token,
        chainId,
        error,
      });
      throw error;
    }
  }

  async setL1TokenApprovals(l1Tokens: EvmAddress[]): Promise<void> {
    // Each of these calls must happen sequentially or we'll have collisions within the TransactionUtil. This should
    // be refactored in a follow on PR to separate out by nonce increment by making the transaction util stateful.
    for (const chainId of this.supportedChains()) {
      const adapter = this.adapters[chainId];
      if (isDefined(adapter)) {
        const hubTokens = l1Tokens.filter((token) => this.l2TokenExistForL1Token(token, chainId));
        await adapter.checkTokenApprovals(hubTokens);
      }
    }
  }

  l2TokenExistForL1Token(l1Token: EvmAddress, l2ChainId: number): boolean {
    return isDefined(getRemoteTokenForL1Token(l1Token, l2ChainId, this.hubPoolClient.chainId));
  }

  // eslint-disable-next-line @typescript-eslint/no-empty-function
  async update(): Promise<void> {}
}
