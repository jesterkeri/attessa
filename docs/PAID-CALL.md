# The paid calls on Celo mainnet (2026-11-09)

Eleven calls, 0.11 USDC in total, all run by hand with the `buy` CLI from the agent wallet: the first at 05:27 UTC, then ten more between 06:51 and 06:53 UTC. The seller itself has made no paid call. The chain proves the payment. The request, the receipt line and the response below are our own record, kept here without any credential: nothing on chain names the CLI, the service or the reads.

## What the chain proves

The first call: transaction `0xebec214d75d2df40e8911d32737daba48f059f2882d36408d128331f37f21df0`, block 82301265, 05:27:03 UTC: 10000 atomic units (0.01 USDC) from `0x08eeF13fD03088aE1dB72ED84a7eed7B255CBfe1` to `0x20faAca5F980E29639A0FCC6dcA6988E18ed333B`. The transaction was sent by the gateway's relayer, so it doesn't carry the project's attribution tag; the agent wallet signed the payment.

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

## The ten further calls

The same request for the block current at each call, one call at a time, each stopped on any failure or any difference from Forno. All ten came back HTTP 200, and each one's block hash, nonce and balance matched a free read of the same block from Forno.

On chain, each transaction below succeeded and moved exactly 10000 atomic units (0.01 USDC) from the agent wallet to `0x20faAca5F980E29639A0FCC6dcA6988E18ed333B`. Each was sent by the gateway's relayer `0x0d74d5cefd2e7f24e623330ebe3d8d4cb45ffb48` and carries no attribution tag. The agent wallet's USDC balance went from 116368 to 16368 atomic units, which is exactly these ten payments.

```
2026-11-09 06:53:39Z  attessa-agent  0.01 USDC on celo confirmed [HTTP 200]
  https://gateway.usebuy.ai/chainstack/celo  0x68f3b57a9f9d1e47bed0a460c665819e462fbca8005f98242f22b4dc9c0590a8
2026-11-09 06:53:25Z  attessa-agent  0.01 USDC on celo confirmed [HTTP 200]
  https://gateway.usebuy.ai/chainstack/celo  0x1b95b4e05424019270628929f01484ed0a259f411dbc9e5df473c802b0ca8351
2026-11-09 06:53:12Z  attessa-agent  0.01 USDC on celo confirmed [HTTP 200]
  https://gateway.usebuy.ai/chainstack/celo  0x770d3af331a23841f26a97332827663d9f45d2fd9202913026a1d67fae33d705
2026-11-09 06:52:59Z  attessa-agent  0.01 USDC on celo confirmed [HTTP 200]
  https://gateway.usebuy.ai/chainstack/celo  0x48a7f8a70df6766e9b7748e1f720e48e00992916a2067b8f07a101e341b95de2
2026-11-09 06:52:44Z  attessa-agent  0.01 USDC on celo confirmed [HTTP 200]
  https://gateway.usebuy.ai/chainstack/celo  0x036424fe6d6ec4b28d16facfdb4468635230239e2b4376a2f29cc8546b8e0710
2026-11-09 06:52:31Z  attessa-agent  0.01 USDC on celo confirmed [HTTP 200]
  https://gateway.usebuy.ai/chainstack/celo  0xa6979d291c69c2dd826a1211cb056a49b3de690f860700c8824784f9aaf919f2
2026-11-09 06:52:18Z  attessa-agent  0.01 USDC on celo confirmed [HTTP 200]
  https://gateway.usebuy.ai/chainstack/celo  0x2ee063ad855b149bcdc83586d620f800530a657e59e212f49045b7ad9f0fd0bc
2026-11-09 06:52:04Z  attessa-agent  0.01 USDC on celo confirmed [HTTP 200]
  https://gateway.usebuy.ai/chainstack/celo  0x96aa32132dbebd9a4813819765bb88611b6b8f94305b603fc0f1f271d7467bb8
2026-11-09 06:51:50Z  attessa-agent  0.01 USDC on celo confirmed [HTTP 200]
  https://gateway.usebuy.ai/chainstack/celo  0xc0a8ec6eae7cb4d9ffc4a01ae9f4c91be85bb361a5b780556055d8a0ba151c7c
2026-11-09 06:51:37Z  attessa-agent  0.01 USDC on celo confirmed [HTTP 200]
  https://gateway.usebuy.ai/chainstack/celo  0x1b38dc440accf4371989559e4e8de9d80c4291eaa8fc1c5bc71919a18f3c93a6
```

These are hand-run calls for this record, not use by anyone else: there is still no live seller and there are no users.
