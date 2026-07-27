/**
 * cloudflared Quick Tunnel を起動し、割り当てられたURLを検知したら
 * Cloudflare Pages側の /relay/report に報告する常駐ラッパー。
 *
 * cloudflared プロセスが（再接続ではなく）再起動してURLが変わった場合も、
 * このラッパー自体は生き続けて新しいURLを都度報告する。
 * cloudflared が完全にクラッシュして終了した場合は再spawnする。
 *
 * 環境変数:
 *   RELAY_REPORT_URL — 例: https://motion-lab-apa.pages.dev/relay/report
 *   RELAY_SECRET      — Cloudflare Pages 環境変数 RELAY_SECRET と同じ値
 *   HOME_SERVER_PORT  — 既定 4000（server/.env の PORT と一致させる）
 */

import { spawn } from 'node:child_process';

const REPORT_URL = process.env.RELAY_REPORT_URL;
const SECRET = process.env.RELAY_SECRET;
const PORT = process.env.HOME_SERVER_PORT ?? '4000';
// Windows実機など cloudflared が PATH に無い環境向け。フルパスを指定できる（既定は 'cloudflared'）
const CLOUDFLARED_BIN = process.env.CLOUDFLARED_PATH ?? 'cloudflared';

if (!REPORT_URL || !SECRET) {
  console.error('RELAY_REPORT_URL と RELAY_SECRET を環境変数で設定してください');
  process.exit(1);
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

async function reportUrl(url) {
  try {
    const res = await fetch(REPORT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Relay-Secret': SECRET },
      body: JSON.stringify({ url }),
    });
    if (!res.ok) {
      console.error(`[tunnel-wrapper] report failed: HTTP ${res.status}`, await res.text());
    } else {
      console.log(`[tunnel-wrapper] reported new URL: ${url}`);
    }
  } catch (e) {
    console.error('[tunnel-wrapper] report error:', e);
  }
}

function startTunnel() {
  console.log('[tunnel-wrapper] starting cloudflared...');
  const proc = spawn(CLOUDFLARED_BIN, ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let reported = false;

  const onData = (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text); // ログはそのまま流す（pm2 logsで見れるように）
    if (!reported) {
      const match = text.match(URL_RE);
      if (match) {
        reported = true;
        reportUrl(match[0]);
      }
    }
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData); // cloudflaredはURLをstderrに出すことが多い

  proc.on('exit', (code) => {
    console.error(`[tunnel-wrapper] cloudflared exited (code=${code}), restarting in 5s...`);
    setTimeout(startTunnel, 5000);
  });
}

startTunnel();
