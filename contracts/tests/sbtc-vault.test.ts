import { describe, expect, it, beforeEach } from "vitest";
import { Cl } from "@stacks/transactions";

const accounts = simnet.getAccounts();
const deployer = accounts.get("deployer")!;
const wallet1 = accounts.get("wallet_1")!;
const wallet2 = accounts.get("wallet_2")!;

const ONE_BTC = 100_000_000; // sats

function mintSbtc(to: string, amount: number) {
  // mock-sbtc only lets the contract deployer mint, mirroring how the
  // real sbtc-token contract restricts minting (protocol-mint) to the
  // sBTC signers -- see the note in sbtc-vault.clar for why we can't
  // just call the real contract's mint path here.
  return simnet.callPublicFn("mock-sbtc", "mint", [Cl.uint(amount), Cl.principal(to)], deployer);
}

describe("sbtc-vault-v2", () => {
  beforeEach(() => {
    mintSbtc(wallet1, ONE_BTC);
    mintSbtc(wallet2, ONE_BTC);
  });

  it("accepts sBTC as collateral and tracks the deposit", () => {
    const { result } = simnet.callPublicFn(
      "sbtc-vault-v2",
      "deposit-collateral",
      [Cl.uint(ONE_BTC)],
      wallet1
    );
    expect(result).toBeOk(Cl.uint(ONE_BTC));

    const position = simnet.callReadOnlyFn(
      "sbtc-vault-v2",
      "get-position",
      [Cl.principal(wallet1)],
      wallet1
    );
    expect(position.result).toBeTuple({
      collateral: Cl.uint(ONE_BTC),
      debt: Cl.uint(0),
      "max-borrowable": Cl.uint(ONE_BTC * 0.5),
      "liquidation-point": Cl.uint(ONE_BTC * 0.75),
      liquidatable: Cl.bool(false),
    });
  });

  it("lets a user borrow up to 50% LTV, but no further", () => {
    simnet.callPublicFn("sbtc-vault-v2", "deposit-collateral", [Cl.uint(ONE_BTC)], wallet1);

    const halfBtc = ONE_BTC * 0.5;
    const okBorrow = simnet.callPublicFn("sbtc-vault-v2", "borrow", [Cl.uint(halfBtc)], wallet1);
    expect(okBorrow.result).toBeOk(Cl.uint(halfBtc));

    const tooMuch = simnet.callPublicFn("sbtc-vault-v2", "borrow", [Cl.uint(1)], wallet1);
    expect(tooMuch.result).toBeErr(Cl.uint(102)); // err-exceeds-ltv
  });

  it("lets a user repay debt and then withdraw freed-up collateral", () => {
    simnet.callPublicFn("sbtc-vault-v2", "deposit-collateral", [Cl.uint(ONE_BTC)], wallet1);
    simnet.callPublicFn("sbtc-vault-v2", "borrow", [Cl.uint(ONE_BTC * 0.5)], wallet1);

    const blocked = simnet.callPublicFn(
      "sbtc-vault-v2",
      "withdraw-collateral",
      [Cl.uint(ONE_BTC)],
      wallet1
    );
    expect(blocked.result).toBeErr(Cl.uint(102)); // err-exceeds-ltv

    const repaid = simnet.callPublicFn("sbtc-vault-v2", "repay", [Cl.uint(ONE_BTC * 0.5)], wallet1);
    expect(repaid.result).toBeOk(Cl.uint(0));

    const withdrawn = simnet.callPublicFn(
      "sbtc-vault-v2",
      "withdraw-collateral",
      [Cl.uint(ONE_BTC)],
      wallet1
    );
    expect(withdrawn.result).toBeOk(Cl.uint(0));
  });

  it("blocks liquidation of a healthy position", () => {
    simnet.callPublicFn("sbtc-vault-v2", "deposit-collateral", [Cl.uint(ONE_BTC)], wallet1);
    simnet.callPublicFn("sbtc-vault-v2", "borrow", [Cl.uint(ONE_BTC * 0.5)], wallet1);

    const attempt = simnet.callPublicFn(
      "sbtc-vault-v2",
      "liquidate",
      [Cl.principal(wallet1), Cl.uint(1000)],
      wallet2
    );
    expect(attempt.result).toBeErr(Cl.uint(105)); // err-not-liquidatable
  });

  it("only the deployer can move the demo price", () => {
    const denied = simnet.callPublicFn("sbtc-vault-v2", "set-demo-price", [Cl.uint(8000)], wallet1);
    expect(denied.result).toBeErr(Cl.uint(107)); // err-not-owner

    const allowed = simnet.callPublicFn("sbtc-vault-v2", "set-demo-price", [Cl.uint(8000)], deployer);
    expect(allowed.result).toBeOk(Cl.bool(true));
  });

  it("becomes liquidatable after a simulated price drop, and liquidation pays out correctly", () => {
    // wallet_1 deposits 1 BTC and borrows the max 50% LTV while price is 1:1
    simnet.callPublicFn("sbtc-vault-v2", "deposit-collateral", [Cl.uint(ONE_BTC)], wallet1);
    const borrowed = ONE_BTC * 0.5;
    simnet.callPublicFn("sbtc-vault-v2", "borrow", [Cl.uint(borrowed)], wallet1);

    // wallet_2 sets up their own healthy position so they hold vault-usd
    // to liquidate with
    simnet.callPublicFn("sbtc-vault-v2", "deposit-collateral", [Cl.uint(ONE_BTC)], wallet2);
    simnet.callPublicFn("sbtc-vault-v2", "borrow", [Cl.uint(ONE_BTC * 0.5)], wallet2);

    // simulate BTC dropping 40% (price-bps 10000 -> 6000): wallet_1's debt
    // (50% of the old collateral value) is now ~83% of the new collateral
    // value, above the 75% liquidation threshold
    const priceDrop = simnet.callPublicFn("sbtc-vault-v2", "set-demo-price", [Cl.uint(6000)], deployer);
    expect(priceDrop.result).toBeOk(Cl.bool(true));

    const position = simnet.callReadOnlyFn(
      "sbtc-vault-v2",
      "get-position",
      [Cl.principal(wallet1)],
      wallet1
    );
    expect(position.result).toBeTuple({
      collateral: Cl.uint(ONE_BTC),
      debt: Cl.uint(borrowed),
      "max-borrowable": Cl.uint(Math.floor(ONE_BTC * 0.6 * 0.5)),
      "liquidation-point": Cl.uint(Math.floor(ONE_BTC * 0.6 * 0.75)),
      liquidatable: Cl.bool(true),
    });

    // wallet_2 liquidates half of wallet_1's debt
    const repayAmount = Math.floor(borrowed / 2);
    const liquidation = simnet.callPublicFn(
      "sbtc-vault-v2",
      "liquidate",
      [Cl.principal(wallet1), Cl.uint(repayAmount)],
      wallet2
    );
    const expectedSeized = Math.floor((repayAmount * 11000) / 6000);
    expect(liquidation.result).toBeOk(
      Cl.tuple({ repaid: Cl.uint(repayAmount), seized: Cl.uint(expectedSeized) })
    );

    const positionAfter = simnet.callReadOnlyFn(
      "sbtc-vault-v2",
      "get-position",
      [Cl.principal(wallet1)],
      wallet1
    );
    expect(positionAfter.result).toBeTuple({
      collateral: Cl.uint(ONE_BTC - expectedSeized),
      debt: Cl.uint(borrowed - repayAmount),
      "max-borrowable": Cl.uint(Math.floor((ONE_BTC - expectedSeized) * 0.6 * 0.5)),
      "liquidation-point": Cl.uint(Math.floor((ONE_BTC - expectedSeized) * 0.6 * 0.75)),
      liquidatable: Cl.bool(
        borrowed - repayAmount >= Math.floor((ONE_BTC - expectedSeized) * 0.6 * 0.75)
      ),
    });
  });
});
