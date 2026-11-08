import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const caddyfile = read('../caddy/Caddyfile');
const launch = read('../../../scripts/ec2-launch.sh');
const setup = read('../../../scripts/ec2-host-setup.sh');

// Never reachable from outside: the test gateway (8083), the local-fork gateway (8082), seller-host (7070-7072),
// socat (5005-5007) and the enclave's own vsock port (5000). SPEC §5, TASKS T23.
const HIDDEN = ['8082', '8083', '7070', '7071', '7072', '5000', '5005', '5006', '5007'];

describe('host files: what the internet can reach', () => {
  it('the Caddyfile names neither the test gateway nor any enclave, socat or seller-host port', () => {
    expect(caddyfile).not.toMatch(/sepolia-test|attessa-gw@test|TEST_ONLY/i);
    for (const p of HIDDEN) expect(caddyfile, `port ${p}`).not.toMatch(new RegExp(`(^|[^0-9])${p}([^0-9]|$)`));
  });

  it('the Caddyfile has exactly the two gateway ports SPEC §5 fixes, behind the two origin variables', () => {
    expect(caddyfile).toContain('{$ATTESSA_ORIGIN_MAINNET} {\n\timport gateway 8080\n}');
    expect(caddyfile).toContain('{$ATTESSA_ORIGIN_SEPOLIA} {\n\timport gateway 8081\n}');
    expect(caddyfile.match(/reverse_proxy/g)).toHaveLength(1);
    expect(caddyfile).toContain('reverse_proxy 127.0.0.1:{args[0]}');
    expect(caddyfile).not.toMatch(/^\s*encode\b/m);
  });

  it('ec2-launch.sh opens only 22, 80 and 443, through one authorize call, and never to all protocols', () => {
    expect(launch.match(/authorize-security-group-ingress/g)).toHaveLength(1);
    expect(launch).toContain('--protocol tcp --port "$1"');
    const calls = [...launch.matchAll(/^ingress (\S+) (\S+)$/gm)].map((m) => [m[1], m[2]]);
    expect(calls).toEqual([
      ['22', '"$CIDR"'],
      ['80', '0.0.0.0/0'],
      ['443', '0.0.0.0/0'],
    ]);
    expect(launch).not.toMatch(/--protocol\s+(-1|all|icmp|udp)|IpPermissions|--port\s+-1/);
  });

  it('ec2-launch.sh enables enclaves, uses the public SSM parameter and runs nothing without --run', () => {
    expect(launch).toContain('--enclave-options Enabled=true');
    expect(launch).toContain('/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-arm64');
    expect(launch).toContain('c6g.xlarge');
    expect(launch).toContain('REGION=us-east-1');
    expect(launch).toMatch(/aws\(\) \{\n\s*\{\n\s*printf/); // print mode is the default definition
  });

  it('ec2-host-setup.sh sets the SPEC §5 allocator and starts no attessa unit', () => {
    expect(setup).toContain('memory_mib: 3072\\ncpu_count: 3');
    expect(setup).not.toMatch(/systemctl (start|restart|enable)[^\n]*attessa/);
    expect(setup).not.toMatch(/--broadcast|PRIVATE_KEY|API_KEY/);
  });
});
