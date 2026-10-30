import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseConfig } from '../src/config.ts';
import { NETWORK_PORTS } from '../src/networks.ts';
import { renderUnits } from '../src/units.ts';

const DIR = fileURLToPath(new URL('../systemd/', import.meta.url));

function env(text: string): Record<string, string> {
  return Object.fromEntries(
    text
      .split('\n')
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split('=') as [string, string]),
  );
}

describe('systemd template units (SPEC §5)', () => {
  const units = renderUnits();

  it('the committed files under systemd/ are exactly the rendered units', () => {
    expect(readdirSync(DIR).sort()).toEqual(Object.keys(units).sort());
    for (const [name, text] of Object.entries(units)) expect(readFileSync(`${DIR}${name}`, 'utf8')).toBe(text);
  });

  it('pins CID, socat port, seller-host and gateway ports per network as SPEC §5 tabulates', () => {
    expect(env(units['mainnet.env']!)).toMatchObject({ ATTESSA_ENCLAVE_CID: '16', ATTESSA_SOCAT_PORT: '5005', ATTESSA_SELLER_PORT: '7070', ATTESSA_GATEWAY_PORT: '8080' });
    expect(env(units['sepolia.env']!)).toMatchObject({ ATTESSA_ENCLAVE_CID: '17', ATTESSA_SOCAT_PORT: '5007', ATTESSA_SELLER_PORT: '7071', ATTESSA_GATEWAY_PORT: '8081' });
    const test = env(units['test.env']!);
    expect(test).toMatchObject({ ATTESSA_ENCLAVE_CID: '18', ATTESSA_SOCAT_PORT: '5006' });
    expect(test.ATTESSA_SELLER_PORT).toBeUndefined();
  });

  it('socat listens on loopback only, forks per connection, and connects to vsock port 5000 of the pinned CID', () => {
    const v = units['attessa-vsock@.service']!;
    expect(v).toContain(
      'ExecStart=/usr/bin/socat TCP-LISTEN:${ATTESSA_SOCAT_PORT},bind=127.0.0.1,fork,reuseaddr VSOCK-CONNECT:${ATTESSA_ENCLAVE_CID}:5000',
    );
    // The per-network file is read at start: a restart can't point socat at another network's enclave.
    expect(v).toContain('EnvironmentFile=/etc/attessa/%i.env');
    expect(v).not.toMatch(/0\.0\.0\.0/);
  });

  it('seller-host runs as attessa-seller after its own vsock bridge, with the agent key only from a secret env file', () => {
    const s = units['attessa-seller@.service']!;
    expect(s).toContain('User=attessa-seller');
    expect(s).toContain('Requires=attessa-vsock@%i.service');
    expect(s).toContain('After=attessa-vsock@%i.service');
    expect(s).toContain('EnvironmentFile=-/etc/attessa/seller-%i.secret');
    expect(s).toContain('ExecStart=/usr/bin/node /opt/attessa/packages/seller-host/dist/main.js /etc/attessa/seller-%i.json');
    expect(s).not.toMatch(/PRIVATE_KEY=/);
  });

  it('the gateway runs as attessa-gw and never loads the seller secret', () => {
    const g = units['attessa-gw@.service']!;
    expect(g).toContain('User=attessa-gw');
    expect(g).toContain('EnvironmentFile=/etc/attessa/gateway-%i.secret');
    expect(g).not.toContain('seller-%i.secret');
  });

  it('every service is hardened and restarts', () => {
    for (const name of ['attessa-vsock@.service', 'attessa-seller@.service', 'attessa-gw@.service']) {
      const u = units[name]!;
      for (const line of ['NoNewPrivileges=yes', 'ProtectSystem=strict', 'ProtectHome=yes', 'Restart=always', 'CapabilityBoundingSet=']) {
        expect(u, `${name}: ${line}`).toContain(line);
      }
      expect(u).not.toContain('--debug-mode');
    }
  });
});

describe('seller-host config', () => {
  const base = { registry: '0x00000000000000000000000000000000000000aa', agentId: '412', origin: 'https://risk.example', stateDir: '/var/lib/attessa/seller-sepolia' };

  it('takes ports and Forno from the network', () => {
    const c = parseConfig({ ...base, network: 'sepolia' });
    expect(c).toMatchObject({ chainId: 11142220, enclavePort: NETWORK_PORTS.sepolia.socatPort, listen: { host: '127.0.0.1', port: 7071 }, fornoUrl: 'https://forno.celo-sepolia.celo-testnet.org' });
    expect(parseConfig({ ...base, network: 'mainnet' })).toMatchObject({ chainId: 42220, enclavePort: 5005, listen: { port: 7070 } });
  });

  it('refuses a non-loopback listener, a wrong chain id, and an origin that is not normalised', () => {
    expect(() => parseConfig({ ...base, network: 'sepolia', listen: { host: '0.0.0.0' } })).toThrow(/loopback/);
    expect(() => parseConfig({ ...base, network: 'sepolia', chainId: 42220 })).toThrow(/chainId/);
    expect(() => parseConfig({ ...base, network: 'sepolia', origin: 'https://Risk.example/path' })).toThrow(/normalised/);
    expect(() => parseConfig({ ...base, network: 'local' })).toThrow(/chainId is required/);
  });
});
