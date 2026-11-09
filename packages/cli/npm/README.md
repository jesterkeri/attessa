# attessa

The Attessa command line. It checks which build a paid service really runs before you pay it, and only pays if the answer checks out.

## Status

Attessa is not live on Celo mainnet yet: its registry isn't deployed and there is no public seller, so there is nothing to pay through it today. Commands that need the mainnet registry say so and stop. `attessa` defaults to Celo Sepolia, which uses test money.

## Install

Needs Node 22.13 or newer.

```
npm install -g attessa
attessa init
```

`attessa init` needs a wallet of yours. This package has no OS keychain support, so it stops and says so until you set `ATTESSA_PRIVATE_KEY`, or pass `--keystore <file>` with the password in `ATTESSA_KEYSTORE_PASSWORD`. Never share a private key or a seed phrase, including with anyone offering help with this tool.

## Commands

```
attessa call <url> --body <file|json>
attessa status --agent <id>
attessa evidence export
attessa seller --help
```

Running a seller (`attessa gateway` and the sealed machine) needs the repository: https://github.com/jesterkeri/attessa
