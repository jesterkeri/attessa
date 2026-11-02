import { NETWORK_PORTS } from './networks.ts';

/**
 * systemd template units, one instance per network (SPEC §5, FR-13): `attessa-vsock@<network>` (socat
 * loopback TCP → enclave vsock 5000), `attessa-seller@<network>` (this package), `attessa-gw@<network>`
 * (the gateway). Per-network values live in `/etc/attessa/<network>.env`, read once at start, so a
 * restart can't point socat at another network's enclave. The files under `systemd/` are this output.
 */

export const INSTALL_ROOT = '/opt/attessa';
export const ETC = '/etc/attessa';

const HARDENING = [
  'NoNewPrivileges=yes',
  'PrivateTmp=yes',
  'PrivateDevices=yes',
  'ProtectSystem=strict',
  'ProtectHome=yes',
  'ProtectKernelTunables=yes',
  'ProtectKernelModules=yes',
  'ProtectControlGroups=yes',
  'RestrictSUIDSGID=yes',
  'LockPersonality=yes',
  'CapabilityBoundingSet=',
];

function unit(lines: string[]): string {
  return `${lines.join('\n')}\n`;
}

export function renderUnits(): Record<string, string> {
  const files: Record<string, string> = {};

  files['attessa-vsock@.service'] = unit([
    '# socat bridge: 127.0.0.1:<5005|5007|5006> -> vsock <16|17|18>:5000 (SPEC §5).',
    '[Unit]',
    'Description=Attessa vsock bridge to the %i enclave',
    'After=network-online.target nitro-enclaves-allocator.service',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    'User=attessa-seller',
    'Group=attessa-seller',
    `EnvironmentFile=${ETC}/%i.env`,
    'ExecStart=/usr/bin/socat TCP-LISTEN:${ATTESSA_SOCAT_PORT},bind=127.0.0.1,fork,reuseaddr VSOCK-CONNECT:${ATTESSA_ENCLAVE_CID}:5000',
    'Restart=always',
    'RestartSec=2',
    ...HARDENING,
    'RestrictAddressFamilies=AF_INET AF_VSOCK',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ]);

  files['attessa-seller@.service'] = unit([
    '# Seller-host for one network: configures the enclave, fetches inputs, serves 127.0.0.1:<7070|7071> (SPEC §5).',
    '[Unit]',
    'Description=Attessa seller-host (%i)',
    'Requires=attessa-vsock@%i.service',
    'After=attessa-vsock@%i.service network-online.target',
    'Wants=network-online.target',
    '',
    '[Service]',
    'Type=simple',
    'User=attessa-seller',
    'Group=attessa-seller',
    // Read-only access to the gateway database for the budget guard (SPEC §5).
    'SupplementaryGroups=attessa-gw',
    `EnvironmentFile=${ETC}/%i.env`,
    // AGENT_PRIVATE_KEY for buy payments: a root-owned 0600 file, read by systemd before dropping privileges.
    `EnvironmentFile=-${ETC}/seller-%i.secret`,
    `ExecStart=/usr/bin/node ${INSTALL_ROOT}/packages/seller-host/dist/main.js ${ETC}/seller-%i.json`,
    'StateDirectory=attessa/seller-%i',
    'StateDirectoryMode=0750',
    'Restart=always',
    'RestartSec=2',
    ...HARDENING,
    'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ]);

  files['attessa-gw@.service'] = unit([
    '# Gateway for one network: 127.0.0.1:<8080|8081> behind Caddy (SPEC §5, §6.5). No private key.',
    '[Unit]',
    'Description=Attessa gateway (%i)',
    'Wants=attessa-seller@%i.service',
    'After=attessa-seller@%i.service network-online.target',
    '',
    '[Service]',
    'Type=simple',
    'User=attessa-gw',
    'Group=attessa-gw',
    `EnvironmentFile=${ETC}/%i.env`,
    // FACILITATOR_API_KEY (and optional RPC_URL): a root-owned 0600 file.
    `EnvironmentFile=${ETC}/gateway-%i.secret`,
    `ExecStart=/usr/bin/node ${INSTALL_ROOT}/packages/gateway/dist/main.js ${ETC}/gateway-%i.json`,
    'StateDirectory=attessa',
    'StateDirectoryMode=0750',
    'Restart=always',
    'RestartSec=2',
    ...HARDENING,
    'RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX',
    '',
    '[Install]',
    'WantedBy=multi-user.target',
  ]);

  for (const [name, p] of Object.entries(NETWORK_PORTS)) {
    const lines = [
      `# ${name}: per-network values for the attessa-*@${name} units (SPEC §5).`,
      `ATTESSA_NETWORK=${name}`,
      `ATTESSA_ENCLAVE_CID=${p.cid}`,
      `ATTESSA_SOCAT_PORT=${p.socatPort}`,
    ];
    if (p.sellerPort) lines.push(`ATTESSA_SELLER_PORT=${p.sellerPort}`);
    if (p.gatewayPort) lines.push(`ATTESSA_GATEWAY_PORT=${p.gatewayPort}`);
    files[`${name}.env`] = unit(lines);
  }
  return files;
}
