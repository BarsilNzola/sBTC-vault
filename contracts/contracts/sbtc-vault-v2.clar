;; sbtc-vault.clar
;;
;; A non-custodial, over-collateralized borrowing vault backed by sBTC.
;;
;; Why this contract exists
;; -------------------------
;; Bitcoin holders can't natively borrow against their BTC without handing
;; custody to someone else. sBTC makes BTC programmable on Stacks, so this
;; vault lets a user:
;;   1. deposit sBTC as collateral (the contract holds it, not a company)
;;   2. borrow an on-chain IOU token ("vault-usd") against that collateral,
;;      up to a max loan-to-value (LTV) ratio
;;   3. repay the IOU to unlock collateral, at any time, with no lockups
;;   4. get liquidated only if their position becomes unsafe, transparently,
;;      by anyone watching the chain -- not by a support ticket
;;
;; Every rule here is enforced by the contract, not by an intermediary.
;; The user never signs custody of their BTC away to a company; they sign a
;; transaction to a contract whose logic is fully readable on-chain.
;;
;; NOTE ON PRICING: this demo uses an adjustable toy price (`price-bps`,
;; basis points against a 1:1 peg) instead of a real price oracle, so the
;; collateral/liquidation mechanics are easy to see and test without wiring
;; up live market data. It starts at u10000 (100%, i.e. 1:1) and only the
;; contract deployer can move it, purely to simulate BTC price swings for
;; this demo -- e.g. "what happens to open positions if BTC drops 30%?".
;; A production version would delete `set-demo-price` entirely and replace
;; every read of `price-bps` with a live BTC/USD feed (e.g. Pyth on Stacks).

;; ---------------------------------------------------------------------
;; sBTC token reference. Points at the local `mock-sbtc` contract for now.
;;
;; UPDATE: this was originally meant as a dev/test-only stand-in, with a
;; plan to swap to the real sBTC contract before a testnet deploy. That
;; plan hit a wall for two independent reasons:
;;   1. the real sbtc-token contract's mint path (`protocol-mint`) is
;;      gated to the sBTC signers, so no test wallet can fund itself
;;      directly -- confirmed against the real contract source.
;;   2. the hackathon organizers confirmed the official testnet sBTC
;;      faucet is down, and explicitly recommended deploying your own
;;      SIP-010 token as a stand-in instead -- which is exactly what
;;      mock-sbtc.clar already is.
;; So for this deployment, `.mock-sbtc` isn't a placeholder -- it's the
;; token this version of the vault actually uses. If the real faucet
;; comes back and you want to switch, swap `.mock-sbtc` for the real
;; contract at the three contract-call sites below:
;;   testnet: 'SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token
;;   mainnet: 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
;; (and redeploy under a new contract name, since Stacks contracts are
;; immutable once published).
;; ---------------------------------------------------------------------

;; ---------------------------------------------------------------------
;; This vault's own IOU / debt token: minted when a user borrows,
;; burned when they repay. 6 decimals, same convention as many
;; Stacks-native stablecoins.
;; ---------------------------------------------------------------------
(define-fungible-token vault-usd)

;; ---------------------------------------------------------------------
;; Risk parameters (basis points, 10000 = 100%)
;; ---------------------------------------------------------------------
(define-constant max-ltv-bps u5000)            ;; can borrow up to 50% of collateral value
(define-constant liquidation-threshold-bps u7500) ;; liquidatable once debt > 75% of collateral value
(define-constant liquidation-bonus-bps u1000)  ;; liquidator gets a 10% discount on seized collateral

;; toy adjustable price, in bps against a 1:1 peg -- see NOTE ON PRICING above
(define-data-var price-bps uint u10000)
(define-constant contract-deployer tx-sender)

;; ---------------------------------------------------------------------
;; Errors
;; ---------------------------------------------------------------------
(define-constant err-zero-amount (err u100))
(define-constant err-insufficient-collateral (err u101))
(define-constant err-exceeds-ltv (err u102))
(define-constant err-no-position (err u103))
(define-constant err-repay-exceeds-debt (err u104))
(define-constant err-not-liquidatable (err u105))
(define-constant err-transfer-failed (err u106))
(define-constant err-not-owner (err u107))

;; ---------------------------------------------------------------------
;; State
;; ---------------------------------------------------------------------
(define-map collateral principal uint)   ;; sats of sBTC deposited, per user
(define-map debt principal uint)         ;; vault-usd owed, per user

(define-data-var total-collateral uint u0)
(define-data-var total-debt uint u0)

;; ---------------------------------------------------------------------
;; Internal helpers
;; ---------------------------------------------------------------------

(define-read-only (get-collateral (who principal))
  (default-to u0 (map-get? collateral who)))

(define-read-only (get-debt (who principal))
  (default-to u0 (map-get? debt who)))

;; value of `sats` of sBTC, expressed in vault-usd units, at the current
;; (demo-adjustable) toy price
(define-read-only (collateral-value (sats uint))
  (/ (* sats (var-get price-bps)) u10000))

(define-read-only (get-demo-price)
  (var-get price-bps))

;; the most vault-usd a user is allowed to owe given their collateral
(define-read-only (max-borrowable (sats uint))
  (/ (* (collateral-value sats) max-ltv-bps) u10000))

;; the debt level (in vault-usd) at which a position becomes liquidatable
(define-read-only (liquidation-point (sats uint))
  (/ (* (collateral-value sats) liquidation-threshold-bps) u10000))

;; a full snapshot of a user's position, for UIs / debug panels
(define-read-only (get-position (who principal))
  (let (
      (coll (get-collateral who))
      (owed (get-debt who))
    )
    {
      collateral: coll,
      debt: owed,
      max-borrowable: (max-borrowable coll),
      liquidation-point: (liquidation-point coll),
      liquidatable: (and (> owed u0) (>= owed (liquidation-point coll))),
    }
  ))

(define-read-only (get-vault-stats)
  {
    total-collateral: (var-get total-collateral),
    total-debt: (var-get total-debt),
  })

;; ---------------------------------------------------------------------
;; Public functions
;; ---------------------------------------------------------------------

;; DEMO ONLY: lets the deployer move the toy price to simulate a BTC price
;; swing and show its effect on open positions' health. Delete this in any
;; real deployment and wire `price-bps` to a real oracle instead.
(define-public (set-demo-price (new-price-bps uint))
  (begin
    (asserts! (is-eq tx-sender contract-deployer) err-not-owner)
    (asserts! (> new-price-bps u0) err-zero-amount)
    (ok (var-set price-bps new-price-bps))
  ))

;; Deposit sBTC into the vault as collateral. The vault contract itself
;; becomes the custodian on-chain -- not a company, not a custodian
;; you have to trust off-chain.
(define-public (deposit-collateral (amount uint))
  (begin
    (asserts! (> amount u0) err-zero-amount)
    (unwrap! (contract-call? .mock-sbtc transfer amount tx-sender (as-contract tx-sender) none)
              err-transfer-failed)
    (map-set collateral tx-sender (+ (get-collateral tx-sender) amount))
    (var-set total-collateral (+ (var-get total-collateral) amount))
    (ok (get-collateral tx-sender))
  ))

;; Borrow vault-usd against deposited sBTC collateral, up to max-ltv-bps.
(define-public (borrow (amount uint))
  (let (
      (coll (get-collateral tx-sender))
      (owed (get-debt tx-sender))
      (new-debt (+ owed amount))
    )
    (asserts! (> amount u0) err-zero-amount)
    (asserts! (<= new-debt (max-borrowable coll)) err-exceeds-ltv)
    (try! (ft-mint? vault-usd amount tx-sender))
    (map-set debt tx-sender new-debt)
    (var-set total-debt (+ (var-get total-debt) amount))
    (ok new-debt)
  ))

;; Repay vault-usd debt, freeing up borrowing capacity (and eventually,
;; withdrawable collateral). Can be repaid at any time, fully or partially.
(define-public (repay (amount uint))
  (let (
      (owed (get-debt tx-sender))
    )
    (asserts! (> amount u0) err-zero-amount)
    (asserts! (<= amount owed) err-repay-exceeds-debt)
    (try! (ft-burn? vault-usd amount tx-sender))
    (map-set debt tx-sender (- owed amount))
    (var-set total-debt (- (var-get total-debt) amount))
    (ok (- owed amount))
  ))

;; Withdraw sBTC collateral, as long as the position stays within max-ltv
;; afterwards. This is the "without completely surrendering control" part:
;; nothing but your own repayment schedule and the LTV rule gates your BTC.
(define-public (withdraw-collateral (amount uint))
  (let (
      (recipient tx-sender)
      (coll (get-collateral tx-sender))
      (owed (get-debt tx-sender))
      (remaining (- coll amount))
    )
    (asserts! (> amount u0) err-zero-amount)
    (asserts! (<= amount coll) err-insufficient-collateral)
    (asserts! (<= owed (max-borrowable remaining)) err-exceeds-ltv)
    (map-set collateral tx-sender remaining)
    (var-set total-collateral (- (var-get total-collateral) amount))
    (unwrap! (as-contract (contract-call? .mock-sbtc transfer amount tx-sender recipient none))
              err-transfer-failed)
    (ok remaining)
  ))

;; Liquidate an unsafe position: the liquidator repays some of the
;; borrower's debt (burning their own vault-usd) and receives that much
;; collateral value plus a bonus, in sBTC. Anyone can call this -- there
;; is no gatekeeper, which is what keeps the system solvent without a
;; centralized risk desk.
(define-public (liquidate (borrower principal) (repay-amount uint))
  (let (
      (liquidator tx-sender)
      (coll (get-collateral borrower))
      (owed (get-debt borrower))
      ;; convert the vault-usd value being repaid (plus the liquidator's
      ;; bonus) back into sats, at the *current* toy price -- this is what
      ;; makes liquidation actually pay out correctly after a price move
      (seized (/ (* repay-amount (+ u10000 liquidation-bonus-bps)) (var-get price-bps)))
    )
    (asserts! (> repay-amount u0) err-zero-amount)
    (asserts! (and (> owed u0) (>= owed (liquidation-point coll))) err-not-liquidatable)
    (asserts! (<= repay-amount owed) err-repay-exceeds-debt)
    (asserts! (<= seized coll) err-insufficient-collateral)
    (try! (ft-burn? vault-usd repay-amount liquidator))
    (map-set debt borrower (- owed repay-amount))
    (map-set collateral borrower (- coll seized))
    (var-set total-debt (- (var-get total-debt) repay-amount))
    (var-set total-collateral (- (var-get total-collateral) seized))
    (unwrap! (as-contract (contract-call? .mock-sbtc transfer seized tx-sender liquidator none))
              err-transfer-failed)
    (ok { repaid: repay-amount, seized: seized })
  ))
