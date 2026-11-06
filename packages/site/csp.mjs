// The Content-Security-Policy for one built page, from the page's own inline scripts.
// GitHub Pages cannot send headers, so it ships as <meta http-equiv="Content-Security-Policy"> in every page.
// A meta policy ignores frame-ancestors, report-uri and report-to, so those are left out (OPEN-QUESTIONS).
import { createHash } from 'node:crypto';

// The one network the pages read: the explorer's payment check on Celo Sepolia (assets/explorer.js).
export const CONNECT = ['https://forno.celo-sepolia.celo-testnet.org'];

/** sha256 CSP source of every inline <script> (no src) in the page. @param {string} html */
export function inlineScriptHashes(html) {
  const out = [];
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    if (/\bsrc\s*=/.test(m[1])) continue;
    out.push(`'sha256-${createHash('sha256').update(m[2], 'utf8').digest('base64')}'`);
  }
  return [...new Set(out)];
}

/** @param {string} html */
export function csp(html) {
  return [
    `default-src 'none'`,
    `script-src 'self' ${inlineScriptHashes(html).join(' ')}`.trim(),
    // Style attributes (style="--i:0") are the only inline styles; there is no <style> element.
    `style-src 'self'`,
    `style-src-attr 'unsafe-inline'`,
    `img-src 'self' data:`,
    `font-src 'self'`,
    `connect-src ${CONNECT.join(' ')}`,
    `base-uri 'none'`,
    `form-action 'none'`,
    `object-src 'none'`,
  ].join('; ');
}
