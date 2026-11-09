# The one paid call on Celo mainnet (2026-11-09)

Run by hand with the `buy` CLI from the agent wallet. The seller itself has made no paid call. The chain proves the payment. The request, the receipt line and the response below are our own record, kept here without any credential: nothing on chain names the CLI, the service or the reads.

## What the chain proves

Transaction `0xebec214d75d2df40e8911d32737daba48f059f2882d36408d128331f37f21df0`, block 82301265, 05:27:03 UTC: 10000 atomic units (0.01 USDC) from `0x08eeF13fD03088aE1dB72ED84a7eed7B255CBfe1` to `0x20faAca5F980E29639A0FCC6dcA6988E18ed333B`. The transaction was sent by the gateway's relayer, so it doesn't carry the project's attribution tag; the agent wallet signed the payment.

## The receipt `buy` printed

```
2026-11-09 05:27:03Z  attessa-agent  0.01 USDC on celo confirmed [HTTP 200]
  https://gateway.usebuy.ai/chainstack/celo  0xebec214d75d2df40e8911d32737daba48f059f2882d36408d128331f37f21df0
```

## The request (POST https://gateway.usebuy.ai/chainstack/celo)

```json
[{"jsonrpc":"2.0","id":1,"method":"eth_getBlockByNumber","params":["0x4e7d144",false]},
{"jsonrpc":"2.0","id":2,"method":"eth_getCode","params":["0x08eeF13fD03088aE1dB72ED84a7eed7B255CBfe1","0x4e7d144"]},
{"jsonrpc":"2.0","id":3,"method":"eth_getTransactionCount","params":["0x08eeF13fD03088aE1dB72ED84a7eed7B255CBfe1","0x4e7d144"]},
{"jsonrpc":"2.0","id":4,"method":"eth_getBalance","params":["0x08eeF13fD03088aE1dB72ED84a7eed7B255CBfe1","0x4e7d144"]}]
```

## What came back

Block 82301252 (0x4e7d144), and the agent wallet's code, nonce and balance at that block. The block hash, nonce and balance matched a free read of the same block from Celo's public Forno endpoint.
