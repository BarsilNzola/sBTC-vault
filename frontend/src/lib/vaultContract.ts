"use client";

import {
  Cl,
  ClarityValue,
  cvToJSON,
  fetchCallReadOnlyFunction,
  PostConditionMode,
} from '@stacks/transactions';
import { openContractCall } from '@stacks/connect';
import { scaffoldConfig, getReadOnlyNetwork } from '../scaffold.config';
import { callDevnetContract, getDevnetSenderAddress } from './devnet';

// Deployed contract addresses per network. Fill in DEPLOYER_ADDRESS after
// running `clarinet deployments apply` -- see the README. The devnet
// deployer address below matches the public devnet mnemonic in
// contracts/settings/Devnet.toml, so it works out of the box locally.
const DEPLOYER_ADDRESS: Record<'devnet' | 'testnet', string> = {
  devnet: 'ST1PQHQKV0RJXZFY1DGX8MNSNYVE3VGZJSRTPGZGM',
  testnet: 'ST3FB4WQWXGVGHM74FBBDQBMBP7ESE784SV4AAJK2',
};

// The real sBTC contract, per Stacks' official network reference. Not
// currently used -- the testnet sBTC faucet is down (confirmed by the
// hackathon organizers), and separately the real contract's mint path is
// gated to the sBTC signers anyway, so this project uses the local
// `mock-sbtc` contract everywhere for now. Kept here in case real sBTC
// integration becomes usable later; see the note in sbtc-vault-v2.clar
// for how to switch back.
const SBTC_CONTRACT: Record<'testnet', string> = {
  testnet: 'SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token',
};
const USE_REAL_SBTC = false;

function networkKey(): 'devnet' | 'testnet' {
  return scaffoldConfig.network as 'devnet' | 'testnet';
}

export function usesMockToken(): boolean {
  return !USE_REAL_SBTC || networkKey() === 'devnet';
}

function deployerAddress(): string {
  return DEPLOYER_ADDRESS[networkKey()];
}

// Renamed from 'sbtc-vault' -- that name is already taken on testnet by
// an earlier deploy pointing at the (currently unreachable) real sBTC
// contract, and Stacks contracts are immutable once published.
export const VAULT_CONTRACT_NAME = 'sbtc-vault-v2';
export const MOCK_TOKEN_CONTRACT_NAME = 'mock-sbtc';

export function vaultContractId() {
  return `${deployerAddress()}.${VAULT_CONTRACT_NAME}`;
}

export function tokenContractId() {
  if (usesMockToken()) return `${deployerAddress()}.${MOCK_TOKEN_CONTRACT_NAME}`;
  return SBTC_CONTRACT['testnet'];
}

// ---------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------

async function readOnly(
  contractAddress: string,
  contractName: string,
  functionName: string,
  functionArgs: ClarityValue[],
  senderAddress: string
) {
  const result = await fetchCallReadOnlyFunction({
    contractAddress,
    contractName,
    functionName,
    functionArgs,
    senderAddress,
    network: getReadOnlyNetwork(),
  });
  return cvToJSON(result);
}

export type VaultPosition = {
  collateral: bigint;
  debt: bigint;
  maxBorrowable: bigint;
  liquidationPoint: bigint;
  liquidatable: boolean;
};

export async function getPosition(address: string): Promise<VaultPosition> {
  const json = await readOnly(
    deployerAddress(),
    VAULT_CONTRACT_NAME,
    'get-position',
    [Cl.principal(address)],
    address
  );
  const v = json.value.value;
  return {
    collateral: BigInt(v.collateral.value),
    debt: BigInt(v.debt.value),
    maxBorrowable: BigInt(v['max-borrowable'].value),
    liquidationPoint: BigInt(v['liquidation-point'].value),
    liquidatable: v.liquidatable.value,
  };
}

export async function getVaultStats(address: string) {
  const json = await readOnly(deployerAddress(), VAULT_CONTRACT_NAME, 'get-vault-stats', [], address);
  const v = json.value.value;
  return {
    totalCollateral: BigInt(v['total-collateral'].value),
    totalDebt: BigInt(v['total-debt'].value),
  };
}

export async function getDemoPrice(address: string): Promise<bigint> {
  const json = await readOnly(deployerAddress(), VAULT_CONTRACT_NAME, 'get-demo-price', [], address);
  return BigInt(json.value);
}

export async function getSbtcBalance(address: string): Promise<bigint> {
  const [sbtcAddress, sbtcName] = tokenContractId().split('.');
  const json = await readOnly(sbtcAddress, sbtcName, 'get-balance', [Cl.principal(address)], address);
  return BigInt(json.value.value);
}

// ---------------------------------------------------------------------
// Writes -- routes to the local devnet burner signer on devnet, or opens
// the connected browser wallet (Leather / Xverse) on testnet.
// ---------------------------------------------------------------------

type WriteResult = { txid?: string };

async function writeContract(
  contractName: string,
  functionName: string,
  functionArgs: ClarityValue[],
  senderAddress: string | null
): Promise<WriteResult> {
  const contract = `${deployerAddress()}.${contractName}`;

  if (scaffoldConfig.isDevnet) {
    const result = await callDevnetContract({ contract, functionName, functionArgs });
    return { txid: result.txid };
  }

  if (!senderAddress) {
    throw new Error('Connect a wallet first.');
  }

  return new Promise((resolve, reject) => {
    openContractCall({
      contractAddress: deployerAddress(),
      contractName,
      functionName,
      functionArgs,
      network: scaffoldConfig.requestNetwork,
      postConditionMode: PostConditionMode.Allow,
      onFinish: (data) => resolve({ txid: data.txId }),
      onCancel: () => reject(new Error('Transaction cancelled.')),
    });
  });
}

export function depositCollateral(amountSats: bigint, senderAddress: string | null) {
  return writeContract(VAULT_CONTRACT_NAME, 'deposit-collateral', [Cl.uint(amountSats)], senderAddress);
}

export function borrow(amountVaultUsd: bigint, senderAddress: string | null) {
  return writeContract(VAULT_CONTRACT_NAME, 'borrow', [Cl.uint(amountVaultUsd)], senderAddress);
}

export function repay(amountVaultUsd: bigint, senderAddress: string | null) {
  return writeContract(VAULT_CONTRACT_NAME, 'repay', [Cl.uint(amountVaultUsd)], senderAddress);
}

export function withdrawCollateral(amountSats: bigint, senderAddress: string | null) {
  return writeContract(VAULT_CONTRACT_NAME, 'withdraw-collateral', [Cl.uint(amountSats)], senderAddress);
}

export function liquidate(borrower: string, repayAmount: bigint, senderAddress: string | null) {
  return writeContract(
    VAULT_CONTRACT_NAME,
    'liquidate',
    [Cl.principal(borrower), Cl.uint(repayAmount)],
    senderAddress
  );
}

export function setDemoPrice(newPriceBps: bigint, senderAddress: string | null) {
  return writeContract(VAULT_CONTRACT_NAME, 'set-demo-price', [Cl.uint(newPriceBps)], senderAddress);
}

export function faucetUrl(): string {
  // Not currently used, kept for when/if the real sBTC faucet is back.
  return 'https://platform.hiro.so/faucet';
}

export function faucetSbtc(senderAddress: string | null) {
  // Works on any network where usesMockToken() is true (currently: all
  // of them) -- mock-sbtc's faucet is open to anyone, unlike the real
  // sBTC contract's protocol-gated mint (see the note in
  // sbtc-vault-v2.clar).
  return writeContract(MOCK_TOKEN_CONTRACT_NAME, 'faucet', [], senderAddress);
}

export function activeSenderAddress(connectedAddress: string | null): string | null {
  if (scaffoldConfig.isDevnet) return getDevnetSenderAddress();
  return connectedAddress;
}