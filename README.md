# sBTC Vault

A non-custodial, over-collateralized borrowing vault backed by sBTC —
built as a working answer to "what would you ship on Stacks?"

## Why this, specifically

The pitch for building on Stacks is: if your product benefits from Bitcoin's
capital, security, or users, Stacks gives you an application layer to build
on top of it -- Clarity contracts, transactions anchored to Bitcoin, and
programmable BTC through sBTC. The post calls out a concrete unsolved
problem: **how do people borrow against their BTC without completely
surrendering control?**

This project is a direct, working answer to that question, not a rebuilt
Ethereum dApp with a Stacks label on it:

- Your sBTC sits in an on-chain contract, not a company's balance sheet.
- Every rule -- how much you can borrow, when you can withdraw, when a
  position gets liquidated -- is enforced by code anyone can read, not by a
  support ticket or a frozen account.
- Liquidation has no gatekeeper: anyone can call it once a position is
  unsafe, which is what keeps the system solvent without a centralized risk
  desk.

## What's actually in here

```
contracts/            Clarinet project (Clarity + vitest, real tests)
  contracts/
    sbtc-vault.clar    the vault: deposit, borrow, repay, withdraw, liquidate
    mock-sbtc.clar     local SIP-010 stand-in for sBTC (see note below)
  tests/
    sbtc-vault.test.ts full lifecycle test, including a real liquidation
frontend/              Next.js app (the actual scaffold-stacks frontend
                        template), with a VaultDashboard page wired to
                        the contract
```

**This is real, tested code**, not a mockup:
- `cd contracts && npm install && npm test` runs 6 tests against an actual
  Clarity interpreter (Clarinet's simnet) -- deposit, LTV-capped borrowing,
  repay/withdraw, blocked liquidation of a healthy position, access control
  on the demo price control, and a full price-drop-to-liquidation payout,
  with the liquidator receiving the correct seized collateral.
- `cd frontend && npm install && npm run build` produces a real Next.js
  production build.

### About `mock-sbtc.clar`

The vault calls a local SIP-010 token (`mock-sbtc.clar`) instead of the
real sBTC contract. This is a deliberate offline-development choice, not a
shortcut around the real integration: pulling the live sBTC contract source
requires network access to Hiro's API (via Clarinet's `requirements`
mechanism), which wasn't available in the sandbox this was built in. The
mock implements the same interface the vault calls (`transfer`,
`get-balance`) plus a `mint`/`faucet` for test funding.

**Before a real deploy**, swap `.mock-sbtc` for the real sBTC contract in
`contracts/contracts/sbtc-vault.clar` (search for `.mock-sbtc`, three call
sites) and either:
- add the real contract as a Clarinet `requirement` (see the commented-out
  block at the top of `Clarinet.toml`) and let Clarinet's deployment plan
  remap the address per network, or
- hardcode the address directly:
  - testnet: `'SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token`
  - mainnet: `'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token`

### About the price control

Real BTC-backed lending needs a live price oracle (e.g. Pyth on Stacks).
This demo uses an adjustable `price-bps` variable instead, gated to the
contract deployer, purely so you can simulate "BTC drops 40%" and watch a
position become liquidatable in real time -- both in the tests and in the
frontend's "Simulate a BTC price move" panel. Delete `set-demo-price` and
wire in a real oracle before this touches real money.

## Running it

You'll need the `stacksdapp` CLI (this repo follows its project layout) or
plain Clarinet + npm, either works:

```bash
# contracts
cd contracts
npm install
npm test                    # run the test suite
clarinet check               # if you have Clarinet installed locally

# frontend
cd ../frontend
npm install
cp env.local.example .env.local   # then set NEXT_PUBLIC_NETWORK=devnet
npm run dev
```

Then deploy the two contracts to devnet (`clarinet devnet start` /
`stacksdapp dev`), update `DEPLOYER_ADDRESS` in
`frontend/src/lib/vaultContract.ts` if it differs from the default devnet
deployer, and open the app. On devnet, actions sign locally with a burner
key (no wallet popup); on testnet/mainnet, connecting Leather or Xverse
triggers the real `openContractCall` flow.

### Deploying to testnet

1. Generate a deployer key and get testnet STX from the
   [Hiro Platform faucet](https://platform.hiro.so/faucet) (same faucet
   also dispenses testnet sBTC directly, so you may not even need
   `mock-sbtc.clar`/the `faucet` function once you swap in the real
   contract).
2. Swap `.mock-sbtc` for the real testnet sBTC contract as described above:
   `'SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token`.
3. `clarinet deployments generate --testnet` then
   `clarinet deployments apply -p deployments/default.testnet-plan.yaml`.
4. Put your deployer address in `DEPLOYER_ADDRESS.testnet` in
   `frontend/src/lib/vaultContract.ts`, set `NEXT_PUBLIC_NETWORK=testnet`
   in `.env.local`, and run the frontend as above.
5. Browse the deployed contract on the
   [testnet explorer](https://explorer.hiro.so/?chain=testnet).

## What would extend this into a real product

- Swap in a real sBTC contract + price oracle (noted above).
- Replace the internal `vault-usd` IOU with an actual stablecoin, or let
  users borrow real sBTC/STX from a lender-funded pool instead of a minted
  IOU.
- Add interest accrual, so lenders (if you add a supply side) earn yield.
- A liquidation keeper bot -- the contract already welcomes anyone to call
  `liquidate`, it just needs someone watching for underwater positions.
- Multi-collateral support, if you want STX or other assets alongside sBTC.

None of that changes the core shape: collateral held on-chain, debt tracked
on-chain, liquidation open to anyone. That's the part that only makes sense
because it's on Stacks, anchored to Bitcoin.