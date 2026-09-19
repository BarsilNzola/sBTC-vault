"use client";

import { useCallback, useEffect, useState } from 'react';
import { useAtomValue } from 'jotai';
import { addressAtom, isMountedAtom } from '../store/wallet';
import { scaffoldConfig } from '../scaffold.config';
import {
  VaultPosition,
  activeSenderAddress,
  borrow,
  depositCollateral,
  faucetSbtc,
  faucetUrl,
  getDemoPrice,
  getPosition,
  getSbtcBalance,
  liquidate,
  repay,
  setDemoPrice,
  usesMockToken,
  withdrawCollateral,
} from '../lib/vaultContract';

const SATS_PER_BTC = 100_000_000n;

function fmtSats(sats: bigint): string {
  const whole = sats / SATS_PER_BTC;
  const frac = sats % SATS_PER_BTC;
  return `${whole}.${frac.toString().padStart(8, '0')}`;
}

function fmtVaultUsd(units: bigint): string {
  return fmtSats(units); // same 8-decimal convention in this demo
}

function toSats(btcInput: string): bigint {
  const [whole, frac = ''] = btcInput.trim().split('.');
  const paddedFrac = (frac + '00000000').slice(0, 8);
  return BigInt(whole || '0') * SATS_PER_BTC + BigInt(paddedFrac || '0');
}

function healthLabel(debt: bigint, liquidationPoint: bigint, collateral: bigint) {
  if (collateral === 0n) return { label: 'No collateral', tone: 'neutral' as const };
  if (debt === 0n) return { label: 'No debt', tone: 'safe' as const };
  const ratio = Number((debt * 1000n) / (liquidationPoint === 0n ? 1n : liquidationPoint));
  if (ratio >= 1000) return { label: 'Liquidatable', tone: 'danger' as const };
  if (ratio >= 850) return { label: 'At risk', tone: 'warning' as const };
  return { label: 'Healthy', tone: 'safe' as const };
}

const toneColor: Record<string, string> = {
  safe: '#F7931A',
  warning: '#F5B93B',
  danger: '#F0554C',
  neutral: '#8F8D8E',
};

function Field({
  label,
  value,
  onChange,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <label className="flex flex-col gap-1 text-[12px] font-mono text-[#908E8E]">
      {label}
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="bg-[#131416] border border-[#2A2929] rounded-[12px] px-3 py-2 text-[14px] text-[#F4F3EF] font-mono outline-none focus:border-[#F7931A]"
      />
    </label>
  );
}

function ActionButton({
  children,
  onClick,
  busy,
  variant = 'primary',
  full,
}: {
  children: React.ReactNode;
  onClick: () => void;
  busy?: boolean;
  variant?: 'primary' | 'secondary';
  full?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={
        (variant === 'primary'
          ? 'bg-[#F7931A] text-[#131416] font-medium '
          : 'bg-transparent border border-[#2A2929] text-[#F4F3EF] ') +
        'font-mono text-[13px] rounded-[12px] px-4 py-2 disabled:opacity-50' +
        (full ? ' w-full' : '')
      }
    >
      {busy ? 'Working…' : children}
    </button>
  );
}

const TABS = ['Position', 'Deposit / Borrow', 'Repay / Withdraw', 'Advanced'] as const;
type Tab = (typeof TABS)[number];

export default function VaultDashboard() {
  const connectedAddress = useAtomValue(addressAtom);
  const isMounted = useAtomValue(isMountedAtom);
  const address = activeSenderAddress(connectedAddress);

  const [tab, setTab] = useState<Tab>('Position');
  const [position, setPosition] = useState<VaultPosition | null>(null);
  const [sbtcBalance, setSbtcBalance] = useState<bigint | null>(null);
  const [priceBps, setPriceBps] = useState<bigint | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const [depositAmount, setDepositAmount] = useState('');
  const [withdrawAmount, setWithdrawAmount] = useState('');
  const [borrowAmount, setBorrowAmount] = useState('');
  const [repayAmount, setRepayAmount] = useState('');
  const [priceInput, setPriceInput] = useState('');
  const [liquidateBorrower, setLiquidateBorrower] = useState('');
  const [liquidateRepay, setLiquidateRepay] = useState('');

  const refresh = useCallback(async () => {
    if (!address) return;
    try {
      const [pos, bal, price] = await Promise.all([
        getPosition(address),
        getSbtcBalance(address),
        getDemoPrice(address),
      ]);
      setPosition(pos);
      setSbtcBalance(bal);
      setPriceBps(price);
      setPriceInput((Number(price) / 100).toString());
    } catch (e) {
      console.error('[vault] refresh failed', e);
    }
  }, [address]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const runAction = async (name: string, fn: () => Promise<{ txid?: string }>) => {
    setBusyAction(name);
    setStatus(null);
    try {
      const result = await fn();
      setStatus(result.txid ? `Submitted: ${result.txid}` : 'Submitted.');
      await refresh();
    } catch (e: any) {
      setStatus(`Failed: ${e?.message ?? String(e)}`);
    } finally {
      setBusyAction(null);
    }
  };

  if (!isMounted) return null;

  if (!address) {
    return (
      <div className="w-full max-w-[560px] mx-auto my-10 text-center font-mono text-[13px] text-[#908E8E]">
        Connect a wallet to open a vault position.
      </div>
    );
  }

  const health = position
    ? healthLabel(position.debt, position.liquidationPoint, position.collateral)
    : { label: '—', tone: 'neutral' as const };

  return (
    <div className="w-full max-w-[560px] mx-auto my-10 px-4 flex flex-col gap-4">
      {/* Always-visible summary strip */}
      <div className="bg-[#1F1E1F] rounded-[20px] p-4 flex items-center justify-between">
        <div className="flex gap-6 font-mono text-[13px]">
          <div className="flex flex-col">
            <span className="text-[10px] text-[#908E8E]">Collateral</span>
            <span>{position ? fmtSats(position.collateral) : '—'} sBTC</span>
          </div>
          <div className="flex flex-col">
            <span className="text-[10px] text-[#908E8E]">Debt</span>
            <span>{position ? fmtVaultUsd(position.debt) : '—'}</span>
          </div>
        </div>
        <div
          className="font-mono text-[11px] px-3 py-1 rounded-full border shrink-0"
          style={{ color: toneColor[health.tone], borderColor: toneColor[health.tone] }}
        >
          {health.label}
        </div>
      </div>

      {/* Tab bar */}
      <div className="flex gap-1 bg-[#1F1E1F] rounded-[14px] p-1">
        {TABS.map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              'flex-1 text-center font-mono text-[12px] rounded-[10px] py-2 px-2 transition-colors ' +
              (tab === t ? 'bg-[#F7931A] text-[#131416]' : 'text-[#908E8E]')
            }
          >
            {t}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="bg-[#1F1E1F] rounded-[20px] p-5 flex flex-col gap-4">
        {tab === 'Position' && (
          <>
            {usesMockToken() && (
              <p className="text-[11px] font-mono text-[#908E8E] bg-[#131416] rounded-[10px] px-3 py-2">
                Using a demo sBTC-equivalent token for this deployment — the official testnet sBTC
                faucet is down. Same interface, same math, different token address.
              </p>
            )}
            <div className="grid grid-cols-2 gap-4 font-mono text-[13px]">
              <div className="flex flex-col gap-1">
                <span className="text-[#908E8E]">Collateral (sBTC)</span>
                <span className="text-[18px]">{position ? fmtSats(position.collateral) : '—'}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[#908E8E]">Debt (vault-usd)</span>
                <span className="text-[18px]">{position ? fmtVaultUsd(position.debt) : '—'}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[#908E8E]">Max borrowable</span>
                <span>{position ? fmtVaultUsd(position.maxBorrowable) : '—'}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[#908E8E]">Liquidation point</span>
                <span>{position ? fmtVaultUsd(position.liquidationPoint) : '—'}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[#908E8E]">Wallet sBTC balance</span>
                <span>{sbtcBalance !== null ? fmtSats(sbtcBalance) : '—'}</span>
              </div>
              <div className="flex flex-col gap-1">
                <span className="text-[#908E8E]">Demo BTC price</span>
                <span>{priceBps !== null ? `${(Number(priceBps) / 100).toFixed(2)}%` : '—'} of peg</span>
              </div>
            </div>

            {usesMockToken() ? (
              <ActionButton
                variant="secondary"
                full
                busy={busyAction === 'faucet'}
                onClick={() => runAction('faucet', () => faucetSbtc(address))}
              >
                Get 0.05 test sBTC
              </ActionButton>
            ) : (
              <a href={faucetUrl()} target="_blank" rel="noreferrer">
                <ActionButton variant="secondary" full onClick={() => {}}>
                  Get testnet sBTC from the Hiro faucet ↗
                </ActionButton>
              </a>
            )}
          </>
        )}

        {tab === 'Deposit / Borrow' && (
          <>
            <div className="flex flex-col gap-2">
              <div className="font-instrument text-[15px]">Deposit collateral</div>
              <Field label="Amount (sBTC)" value={depositAmount} onChange={setDepositAmount} placeholder="0.10" />
              <ActionButton
                full
                busy={busyAction === 'deposit'}
                onClick={() => runAction('deposit', () => depositCollateral(toSats(depositAmount), address))}
              >
                Deposit
              </ActionButton>
            </div>
            <div className="h-px bg-[#2A2929]" />
            <div className="flex flex-col gap-2">
              <div className="font-instrument text-[15px]">Borrow</div>
              <Field label="Amount (vault-usd)" value={borrowAmount} onChange={setBorrowAmount} placeholder="0.02" />
              <ActionButton
                full
                busy={busyAction === 'borrow'}
                onClick={() => runAction('borrow', () => borrow(toSats(borrowAmount), address))}
              >
                Borrow
              </ActionButton>
            </div>
          </>
        )}

        {tab === 'Repay / Withdraw' && (
          <>
            <div className="flex flex-col gap-2">
              <div className="font-instrument text-[15px]">Repay</div>
              <Field label="Amount (vault-usd)" value={repayAmount} onChange={setRepayAmount} placeholder="0.02" />
              <ActionButton
                variant="secondary"
                full
                busy={busyAction === 'repay'}
                onClick={() => runAction('repay', () => repay(toSats(repayAmount), address))}
              >
                Repay
              </ActionButton>
            </div>
            <div className="h-px bg-[#2A2929]" />
            <div className="flex flex-col gap-2">
              <div className="font-instrument text-[15px]">Withdraw collateral</div>
              <Field label="Amount (sBTC)" value={withdrawAmount} onChange={setWithdrawAmount} placeholder="0.05" />
              <ActionButton
                variant="secondary"
                full
                busy={busyAction === 'withdraw'}
                onClick={() => runAction('withdraw', () => withdrawCollateral(toSats(withdrawAmount), address))}
              >
                Withdraw
              </ActionButton>
            </div>
          </>
        )}

        {tab === 'Advanced' && (
          <>
            <div className="flex flex-col gap-2">
              <div className="font-instrument text-[15px]">Simulate a BTC price move</div>
              <p className="text-[11px] font-mono text-[#908E8E]">
                Demo-only. Only the contract deployer can move this; everyone else sees the effect
                on open positions and can liquidate ones that cross 75% debt-to-collateral.
              </p>
              <Field
                label="New price (% of original peg)"
                value={priceInput}
                onChange={setPriceInput}
                placeholder="60"
              />
              <ActionButton
                variant="secondary"
                full
                busy={busyAction === 'price'}
                onClick={() =>
                  runAction('price', () =>
                    setDemoPrice(BigInt(Math.round(parseFloat(priceInput || '0') * 100)), address)
                  )
                }
              >
                Set price
              </ActionButton>
            </div>
            <div className="h-px bg-[#2A2929]" />
            <div className="flex flex-col gap-2">
              <div className="font-instrument text-[15px]">Liquidate a position</div>
              <p className="text-[11px] font-mono text-[#908E8E]">
                Anyone can call this once a position is liquidatable -- no gatekeeper. Repaying
                their debt earns you their collateral plus a 10% bonus, in sBTC.
              </p>
              <Field
                label="Borrower address"
                value={liquidateBorrower}
                onChange={setLiquidateBorrower}
                placeholder="ST…"
              />
              <Field
                label="Repay amount (vault-usd)"
                value={liquidateRepay}
                onChange={setLiquidateRepay}
                placeholder="0.01"
              />
              <ActionButton
                full
                busy={busyAction === 'liquidate'}
                onClick={() =>
                  runAction('liquidate', () => liquidate(liquidateBorrower, toSats(liquidateRepay), address))
                }
              >
                Liquidate
              </ActionButton>
            </div>
          </>
        )}
      </div>

      {status && <div className="font-mono text-[11px] text-[#908E8E] break-all">{status}</div>}

      {scaffoldConfig.isDevnet && (
        <div className="font-mono text-[11px] text-[#5c5b5b] text-center">
          Devnet mode: transactions sign locally with the wallet_1 burner key, no wallet popup.
        </div>
      )}
    </div>
  );
}