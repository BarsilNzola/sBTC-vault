;; mock-sbtc.clar
;;
;; A local stand-in for the real sBTC token contract, used only for devnet
;; testing and offline development. It implements the same SIP-010 surface
;; the vault calls (transfer / get-balance), plus a deployer-gated `mint`
;; so tests can fund wallets the same way the official sBTC docs show
;; minting against the real contract on simnet.
;;
;; SWAP BEFORE DEPLOYING: sbtc-vault.clar points at this contract via
;; `.mock-sbtc`. Before a testnet or mainnet deploy, point it at the real
;; sBTC contract instead:
;;   testnet: 'SN3VMHXEN64ZZF71JQ5VESXDWTR301XTTXGF4J8F1.sbtc-token
;;   mainnet: 'SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token
;; (same address on mainnet as the constant already used in the vault's
;; comments -- Clarinet's `requirements` mechanism normally automates this
;; remap; here it's a manual one-line swap since this sandbox can't reach
;; the network to fetch the live contract source.)

(define-fungible-token sbtc)

(define-constant contract-deployer tx-sender)
(define-constant err-not-owner (err u900))
(define-constant err-not-token-owner (err u901))

(define-public (mint (amount uint) (recipient principal))
  (begin
    (asserts! (is-eq tx-sender contract-deployer) err-not-owner)
    (ft-mint? sbtc amount recipient)
  ))

;; Open to anyone, capped per call, purely so this demo is self-serve for
;; testnet wallets that don't hold the deployer key. Not part of the real
;; sBTC contract -- delete along with this whole mock when you swap in the
;; real sBTC token.
(define-constant faucet-cap u5000000) ;; 0.05 sBTC per call
(define-public (faucet)
  (ft-mint? sbtc faucet-cap tx-sender))

(define-public (transfer (amount uint) (sender principal) (recipient principal) (memo (optional (buff 34))))
  (begin
    (asserts! (is-eq tx-sender sender) err-not-token-owner)
    (try! (ft-transfer? sbtc amount sender recipient))
    (ok true)
  ))

(define-read-only (get-name)
  (ok "mock sBTC"))

(define-read-only (get-symbol)
  (ok "sBTC"))

(define-read-only (get-decimals)
  (ok u8))

(define-read-only (get-balance (who principal))
  (ok (ft-get-balance sbtc who)))

(define-read-only (get-total-supply)
  (ok (ft-get-supply sbtc)))

(define-read-only (get-token-uri)
  (ok none))
