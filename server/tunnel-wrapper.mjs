/**
 * cloudflared Quick Tunnel を起動し、割り当てられたURLを検知したら
 * Cloudflare Pages側の /relay/report に報告する常駐ラッパー。
 *
 * cloudflared プロセスが（再接続ではなく）再起動してURLが変わった場合も、
 * このラッパー自体は生き続けて新しいURLを都度報告する。
 * cloudflared が完全にクラッシュして終了した場合は再spawnする。
 *
 * さらに、cloudflared プロセスは生きているのに Quick Tunnel が Cloudflare 側で
 * 失効（Error 1016 / control stream failure の無限リトライ）するケースを
 * 能動ヘルスチェックで検知し、cloudflared を強制再起動して新URLを再発行させる。
 * ※ このケースでは proc.on('exit') が発火しないため、これが無いと約1日周期で沈黙する。
 *
 * 環境変数:
 *   RELAY_REPORT_URL — 例: https://motion-lab-apa.pages.dev/relay/report
 *   RELAY_SECRET      — Cloudflare Pages 環境変数 RELAY_SECRET と同じ値
 *   HOME_SERVER_PORT  — 既定 4000（server/.env の PORT と一致させる）
 *   CLOUDFLARED_PATH  — cloudflared バイナリのパス（PATH に無い環境向け。既定 'cloudflared'）
 *   HEALTH_PROBE_MS   — ヘルスチェック間隔ms（既定 30000）
 *   HEALTH_FAIL_MAX   — 連続何回失敗したら強制再起動するか（既定 3）
 */

import { spawn } from 'node:child_process';

const REPORT_URL = process.env.RELAY_REPORT_URL;
const SECRET = process.env.RELAY_SECRET;
const PORT = process.env.HOME_SERVER_PORT ?? '4000';
// Windows実機など cloudflared が PATH に無い環境向け。フルパスを指定できる（既定は 'cloudflared'）
const CLOUDFLARED_BIN = process.env.CLOUDFLARED_PATH ?? 'cloudflared';
const HEALTH_PROBE_MS = Number(process.env.HEALTH_PROBE_MS ?? 30000);
const HEALTH_FAIL_MAX = Number(process.env.HEALTH_FAIL_MAX ?? 3);

if (!REPORT_URL || !SECRET) {
  console.error('RELAY_REPORT_URL と RELAY_SECRET を環境変数で設定してください');
  process.exit(1);
}

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

// 現在稼働中の cloudflared 子プロセスと、そのトンネルURL。
// ヘルスチェックとの競合を防ぐためモジュールスコープで一元管理する。
let currentProc = null;
let currentUrl = null;
let probeFailStreak = 0;
let restarting = false; // 強制再起動〜新spawn完了までのガード

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
  restarting = false;
  currentUrl = null;
  probeFailStreak = 0;

  const proc = spawn(CLOUDFLARED_BIN, ['tunnel', '--url', `http://localhost:${PORT}`], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  currentProc = proc;

  let reported = false;

  const onData = (chunk) => {
    const text = chunk.toString();
    process.stdout.write(text); // ログはそのまま流す（pm2 logsで見れるように）
    if (!reported) {
      const match = text.match(URL_RE);
      if (match) {
        reported = true;
        currentUrl = match[0];
        reportUrl(currentUrl);
      }
    }
  };

  proc.stdout.on('data', onData);
  proc.stderr.on('data', onData); // cloudflaredはURLをstderrに出すことが多い

  proc.on('exit', (code) => {
    if (proc !== currentProc) return; // 既に別プロセスに切り替わっていれば無視
    console.error(`[tunnel-wrapper] cloudflared exited (code=${code}), restarting in 5s...`);
    currentProc = null;
    currentUrl = null;
    setTimeout(startTunnel, 5000);
  });
}

/**
 * 能動ヘルスチェック: 報告済みURL経由で /api/health を叩く。
 * Quick Tunnel が失効すると cloudflared は exit せずリトライし続けるため、
 * ここで到達不能を検知して強制再起動（kill → exit ハンドラで再spawn → 新URL報告）する。
 */
async function healthProbe() {
  if (restarting || !currentProc || !currentUrl) return; // 起動直後・再起動中はスキップ

  let ok = false;
  try {
    const res = await fetch(`${currentUrl}/api/health`, {
      signal: AbortSignal.timeout(15000),
    });
    ok = res.ok;
  } catch {
    ok = false;
  }

  if (ok) {
    if (probeFailStreak > 0) {
      console.log('[tunnel-wrapper] health probe recovered');
    }
    probeFailStreak = 0;
    return;
  }

  probeFailStreak++;
  console.error(`[tunnel-wrapper] health probe failed (${probeFailStreak}/${HEALTH_FAIL_MAX}) url=${currentUrl}`);
  if (probeFailStreak >= HEALTH_FAIL_MAX) {
    console.error('[tunnel-wrapper] tunnel appears dead — killing cloudflared to force a fresh tunnel');
    restarting = true;
    const dying = currentProc;
    currentProc = null;
    currentUrl = null;
    probeFailStreak = 0;
    try { dying?.kill(); } catch {}
    // dying.on('exit') は proc !== currentProc で無視されるため、ここで再spawnを予約
    setTimeout(startTunnel, 5000);
  }
}

setInterval(() => { void healthProbe(); }, HEALTH_PROBE_MS);

startTunnel();
