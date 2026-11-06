import { DEPLOYMENTS } from '@attessa/core';
import { REGISTRY } from './fake-chain.ts';

// The SDK's FakeChain reports Sepolia's chain id, and a pinned registry wins over ATTESSA_REGISTRY (SPEC §2.6). Since T10
// pinned the real Sepolia registry, the FakeChain's default registry stands in for it in every CLI test file (each runs
// in its own fork); test/fake-chain.ts's REGISTRY is the same address.
(DEPLOYMENTS['celo-sepolia'] as { enclaveRegistry: string | null }).enclaveRegistry = REGISTRY;
