# Attessa website (UI)

The public website for Attessa: a homepage, How it works, the Proof explorer, Use cases, Docs (five pages),
Security and limits, Privacy and Terms. Dark only. This folder is the **finished UI as static HTML, CSS and
JS**, built from the website brief (`claude-design-attessa-website-v1.md`) and the copy in `FLOWS.md` and
`SPEC.md`. It is the design reference for the real frontend. One thing reads Celo: the explorer's payment check
on Celo Sepolia (below). Nothing is wired to the gateway or the SDK yet.

This is the workspace package `@attessa/site` (private). Its one dependency is `esbuild` (exact, dev only; it
bundles the scene's scripts in T40). It adds no CI job.

## Run it

Needs Node 22 and `pnpm install` (once, at the repo root).

```bash
pnpm --filter @attessa/site build    # writes packages/site/dist/
node packages/site/serve.mjs         # http://localhost:4321  (optional port: node packages/site/serve.mjs 5000)
pnpm --filter @attessa/site test     # node --test test/*.test.mjs; ./test-count.sh runs each file alone and sums
```

Add `?settle` to any URL to make the 3D scene jump straight to each scroll position's final frame (handy for
screenshots and checking layouts).

## What is real and what is a sample

- **Every live value is a slot.** `[[slot:name]]` in a page renders as a dashed `{name}` chip marked
  "(sample)". Apart from the explorer's payment check, nothing on the site reads chain data, and no value on
  it is invented.
- **Proof explorer, payment check (live on Celo Sepolia):** a pasted settlement transaction is checked by
  `assets/explorer.js` with plain JSON-RPC to `https://forno.celo-sepolia.celo-testnet.org` (the CLI's
  default): `eth_chainId` (must be 11142220), `eth_getTransactionReceipt` and `eth_getBlockByNumber`. It finds
  the one ERC-20 `Transfer` of the pinned Sepolia USDC (`packages/core/src/deployments.ts`; no USA₮ is pinned on
  Sepolia) and shows the payer, the address paid, the amount (6 decimals), the block, its time in UTC and a
  Blockscout link. Not found, reverted, no USDC transfer, more than one USDC transfer (refused, none shown),
  Celo unreachable or too slow (10 s), the wrong chain and unreadable answers each get their own message.
  Answers are checked for shape and rendered with `textContent` only. The other four checks stay "Planned".
  Tests replay answers recorded from the real RPC (`test/fixtures/`, re-record with
  `node packages/site/test/fixtures/capture.mjs`).
- **Proof explorer, UI preview:** the "UI preview" switcher shows every state from the brief (verified,
  tampered, unapproved, unattested, checking, not found, malformed ID, Celo unreachable) with sample slots. It
  never takes the pasted transaction and never reads Celo. The recent-calls table is samples too.
- **Network switch** (footer): Celo Sepolia only. Mainnet is shown, disabled and marked "After launch" until
  Gate 5, and a stored `mainnet` from an earlier version is ignored. The payment check's network data (chain
  id, RPC, block explorer, pinned tokens) is one `NETWORKS` table in `assets/explorer.js`: mainnet is added there
  as data at Gate 5.
- **Terminal output** on the homepage and How it works is the CLI's example output from `FLOWS.md`, marked
  illustrative.
- **Privacy and Terms** are marked Draft; the legal wording is still to be written.
- **`/.well-known/security.txt`** has placeholder fields.

Slots used in the pages: `demoServiceUrl`, `callTime`, `payTo`, `amount`,
`asset`. The explorer's checklist also uses `endpointOrigin`, `releaseId`, `agentId`, `sourceRepo`, `sourceCommit`,
`signerAddress`, `signerExpiry`, `requestHash`, `responseHash`, `inputsBlock`, `inputsHash`,
`authorizationNonce`, `settlementTx`, `expiryBlock`, `rpcUrl`, `payer`, `payTo`, `settlementBlock`.

## How it is built

`build.mjs` is a small zero-dependency generator: each page in `src/pages/` is wrapped in `src/layout.html`,
and a few shorthands are expanded.

| In a page | Becomes |
| --- | --- |
| `<!-- title: ... -->`, `<!-- description: ... -->` | the page's title and meta description |
| `<!-- nav: how -->`, `<!-- doc: tutorial -->`, `<!-- body: ... -->` | the current nav or docs link, and the body class |
| `{{root}}` | the relative path back to the site root (pages work from any folder) |
| `{{> name}}` | `src/partials/name.html` |
| `{{i:name}}`, `{{arrow}}`, `{{copyIcon}}`, `{{logo}}` | icons (Phosphor), the hover arrow, the copy icon, the logo |
| `{{track:pass pass fail na free}}` | an outcome track: four checks, then `paid`, `free` (not charged) or `stopped` (nothing signed) |
| `[[slot:name]]`, `[[hash:0x...]]` | a sample slot chip, or a real value with copy and expand |

`src/static/` is copied as is. The five scripts:

- `assets/site.css`: all styles.
- `assets/site.js`: menu, tabs, copy buttons, the How it works walkthrough, the docs menu and on-this-page
  markers, and the explorer's preview states.
- `assets/explorer.js`: the explorer's live payment check (loaded on the explorer page only; no CDN).
- `assets/motion.js`: GSAP text and section reveals.
- `assets/scene.js`: the three.js particle scene (below).

Loaded from CDNs, versions pinned in `layout.html`: GSAP 3.12.5 and ScrollTrigger (cdnjs), three 0.160.0
(jsDelivr, via an import map), Phosphor icons 2.1.1 (unpkg), Google Fonts (Anybody, Geist, Geist Mono).
These sit outside the repo's lockfile and supply-chain rules, so the production frontend should self-host or
pin them with integrity hashes.

## The 3D scene

One particle system on a fixed canvas behind the page. Scroll position blends it between acts, so it never
switches or blinks out:

1. Star dust behind the hero; the statement gathers it into a cluster of cubes (the sealed machines).
2. The pinned story (five steps): the approved build lights up, the machine lifts out, signs, the five checks
   tick, and a tampered answer scatters red.
3. Each pinned section after that forms its own object in its `[data-slot]` beside the text, then lets it go:
   the outcome seal (lime check, red and breaking, grey cross), the globe, a coin for spending limits, a cube
   whose right half comes loose for "what it doesn't show", a ring round the final call to action. Use cases
   gives each of its four uses an object; the explorer's seal shows the current result.
4. The dust fades as the footer arrives and wireframe mountains rise under it.

A section opts in with `data-scene-sec="name"` and a `[data-slot]` element; `sceneTarget()` in `scene.js`
says what each name forms.

## Design rules (keep these)

- Dark only. Near-black page, one hairline grey family.
- **Square corners everywhere** (inline chips 2px). Panels are solid with one hairline; only the nav and the
  phone menu are blurred.
- **Lime means verified or paid, nothing else.** Red means refused. The records diagram on How it works keeps
  lime on the approved release on purpose.
- Headings are the display face in condensed capitals. Outlined words appear only in the homepage hero and the
  final call to action. Status always pairs an icon with a word.
- The main action is a solid square button; a second action is `[ BRACKETED ]` text.
- The footer wordmark (silver gradient, condensed capitals, centred) is settled. Leave it.
- Copy comes from `FLOWS.md` and `SPEC.md`. No em dashes.

## Responsive behaviour

- **Desktop and tablets (720px and wider):** pinned scenes with the object beside the text. Short screens
  tighten the story (under about 820px tall) and the proves section (under about 960px) so they fit, and a
  pinned box that still overflows (200% zoom on a laptop) scrolls from its top. A box that scrolls with nothing focusable inside (the story, the outcomes, the uses) has `tabindex="0"`, so the keyboard can scroll it; so do the docs code blocks and reference tables, which scroll sideways on phones and at 200% zoom.
- **Phones (under 720px):** nothing pins. Each object gets its own slot above its section's text and forms as
  that slot scrolls in; the statement's cubes form under the sentence; the story puts the step, the cubes and
  the checklist one above the other. The final call to action has no ring on phones.
- The nav collapses to a menu under 1020px; the docs menu becomes a toggle under 860px.

Checked in a desktop browser at 390, 768, 834, 1024, 1280, 1366 and 1440px wide. Not yet checked on a real
phone or tablet.

## What the real frontend still needs

- The explorer's other four checks (the proof checks in `SPEC.md`, which need the call's proof and request-ID
  lookup), the recent-calls feed from Celo events, and every other slot from chain data, the deploy record and
  the SDK. The payment check reads Celo Sepolia today.
- Celo mainnet in the explorer at Gate 5 (USDC and USA₮), and the registry addresses the network switch implies.
- Self-host or pin the CDN scripts and fonts with integrity hashes.
- Final Privacy and Terms wording, and the real `security.txt` contact.
- A real-device pass (tap feel, safe areas, keyboard, particle performance on older phones).
