// ホスト + 複数の参加者をブラウザで動かす通しテスト（開発用）。
// 事前に次の3つを起動しておく（README の「開発者向け」を参照）:
//   PeerJS サーバー（127.0.0.1:9000）/ このリポジトリ（:8001）/ 参加者リポジトリ（:8002）
// 実行: N=6 node tests/e2e.cjs   （N = 参加者の人数）
const { chromium } = require('playwright');
const path = require('path');

const OUT = process.env.OUT || path.join(__dirname, 'shots');
// RELAY=ws://127.0.0.1:8883 で中継（MQTT）も使う。BLOCK_P2P=1 で参加者の直接通信（WebRTC の UDP）を止める。
const RELAY = process.env.RELAY || '';
const BLOCK_P2P = process.env.BLOCK_P2P === '1';
const HOST =
  process.env.HOST_URL ||
  `http://localhost:8001/?peer=127.0.0.1:9000&player=http://localhost:8002/${RELAY ? `&relay=${encodeURIComponent(RELAY)}` : '&relay=off'}`;
const N = Number(process.env.N || 6);
const errors = [];

function watch(page, name) {
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(`[${name}] ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`[${name}] PAGEERROR ${e.message}`));
}

(async () => {
  require('fs').mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const playerBrowser = BLOCK_P2P
    ? await chromium.launch({ args: ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'] })
    : browser;
  const hostCtx = await browser.newContext({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 });
  const host = await hostCtx.newPage();
  watch(host, 'host');
  await host.goto(HOST);
  await host.waitForSelector('#netStatus[data-s="online"]', { timeout: 20000 });
  const code = (await host.textContent('#roomCode')).replace(/\s/g, '');
  const joinUrl = await host.textContent('#joinUrl');
  console.log('room', code, joinUrl);

  const players = [];
  for (let i = 0; i < N; i++) {
    const ctx = await playerBrowser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1, isMobile: true, hasTouch: true });
    const page = await ctx.newPage();
    watch(page, `p${i + 1}`);
    await page.goto(joinUrl);
    await page.fill('#name', `生徒${i + 1}`);
    await page.click('button[type=submit]');
    players.push({ ctx, page });
  }
  for (const p of players) await p.page.waitForSelector('text=参加しました', { timeout: 20000 });
  await host.waitForFunction((n) => document.querySelector('#playerCount').textContent === String(n), N);
  console.log('all joined:', await host.textContent('#onlineCount'));
  if (BLOCK_P2P) {
    const kinds = await Promise.all(players.map((p) => p.page.textContent('#netStatus')));
    if (!kinds.every((k) => k.includes('中継'))) throw new Error(`expected relay for all players: ${kinds}`);
  }
  await host.screenshot({ path: `${OUT}/01-host-lobby.png`, fullPage: false });
  await players[0].page.screenshot({ path: `${OUT}/02-player-lobby.png` });

  // ---- Round 1 (no punishment)
  await host.click('#actions button:has-text("ラウンド1を開始")');
  for (const p of players) await p.page.waitForSelector('text=いくら出しますか？');
  await players[0].page.screenshot({ path: `${OUT}/03-player-contribute-empty.png` });
  const base = [1000, 500, 0, 250, 750, 1000, 300, 600, 900, 100];
  const amounts = Array.from({ length: N }, (_, i) => base[i % base.length]);
  for (let i = 0; i < N; i++) {
    const pg = players[i].page;
    if (![0, 250, 500, 750, 1000].includes(amounts[i])) {
      await pg.fill('.exact input', String(amounts[i]));
    } else if (false) {
      await pg.fill('.exact input', '300');
    } else {
      await pg.click(`.quick .btn:has-text("${amounts[i].toLocaleString('ja-JP')}円")`);
    }
    if (i === 0) await pg.screenshot({ path: `${OUT}/04-player-contribute.png` });
    await pg.click('.btn.primary.block');
    await pg.waitForSelector('text=送信しました');
  }
  await players[1].page.screenshot({ path: `${OUT}/05-player-sent.png` });
  await host.waitForSelector('#phaseBadge:has-text("結果発表")', { timeout: 10000 });
  for (const p of players) await p.page.waitForSelector('text=今回の利得');
  // verify payoff against formula from the host's state
  const st = await host.evaluate(() => JSON.parse(localStorage.getItem('pgg-host-state-v1')));
  const r1 = st.rounds[0];
  for (let i = 0; i < N; i++) {
    const shown = await players[i].page.textContent('.payoff .v');
    const pid = await players[i].page.evaluate((c) => JSON.parse(localStorage.getItem(`pgg-id-${c}`)).pid, code);
    const res = r1.results[pid];
    const g = r1.groups.find((gg) => gg.members.includes(pid));
    const sum = g.members.reduce((a, m) => a + r1.contributions[m], 0);
    const expected = 1000 - amounts[i] + (2 * sum) / g.members.length;
    if (Math.round(expected) !== Math.round(res.payoff) || r1.contributions[pid] !== amounts[i]) throw new Error(`payoff mismatch p${i + 1}`);
    if (shown.replace(/[^\d-]/g, '') !== String(Math.round(expected))) throw new Error(`shown mismatch p${i + 1}: ${shown} vs ${expected}`);
  }
  console.log('round 1 payoffs ok; groups:', r1.groups.map((g) => g.members.length));
  await players[2].page.screenshot({ path: `${OUT}/06-player-result.png`, fullPage: true });

  // ---- Round 2 with punishment
  await host.click('.rule-box .switch');
  await host.waitForSelector('#punishLabel:has-text("あり")');
  await host.click('#actions button:has-text("ラウンド2を開始")');
  for (const p of players) await p.page.waitForSelector('text=いくら出しますか？');
  for (let i = 0; i < N; i++) {
    const pg = players[i].page;
    await pg.click(`.quick .btn >> nth=${i % 2 === 0 ? 4 : 0}`);
    await pg.click('.btn.primary.block');
    await pg.waitForSelector('text=送信しました');
  }
  await host.waitForSelector('#phaseBadge:has-text("罰則の入力中")', { timeout: 10000 });
  for (const p of players) await p.page.waitForSelector('text=罰を与えますか？');
  // player 1 punishes the first other member twice
  const p1 = players[0].page;
  await p1.click('.prow:not(.me) >> nth=0 >> button[aria-label*="増やす"]');
  await p1.click('.prow:not(.me) >> nth=0 >> button[aria-label*="増やす"]');
  await p1.screenshot({ path: `${OUT}/07-player-punish.png`, fullPage: true });
  await host.screenshot({ path: `${OUT}/08-host-punish-progress.png` });
  for (let i = 0; i < N; i++) {
    await players[i].page.click('.btn.punish.block');
    await players[i].page.waitForSelector('text=送信しました');
  }
  await host.waitForSelector('#phaseBadge:has-text("結果発表")', { timeout: 10000 });
  for (const p of players) await p.page.waitForSelector('text=今回の利得');
  const st2 = await host.evaluate(() => JSON.parse(localStorage.getItem('pgg-host-state-v1')));
  const r2 = st2.rounds[1];
  const p1pid = await p1.evaluate((c) => JSON.parse(localStorage.getItem(`pgg-id-${c}`)).pid, code);
  if (r2.results[p1pid].cost !== 200) throw new Error('punish cost not applied');
  const victims = Object.values(r2.results).filter((x) => x.loss === 600);
  if (victims.length !== 1) throw new Error('punish loss not applied');
  console.log('round 2 punishment ok');
  await p1.screenshot({ path: `${OUT}/09-player-result-punish.png`, fullPage: true });

  // ---- player reload -> auto rejoin
  const p3 = players[2].page;
  await p3.reload();
  await p3.waitForSelector('text=今回の利得', { timeout: 20000 });
  console.log('player reload rejoin ok');

  // ---- host reload -> resume and players reconnect
  await host.reload();
  await host.waitForSelector('#modal:not([hidden])');
  await host.click('#modalActions >> text=続きから再開');
  await host.waitForSelector('#netStatus[data-s="online"]', { timeout: 30000 });
  await host.waitForFunction((n) => /接続中 (\d+)人/.test(document.querySelector('#onlineCount').textContent) && Number(document.querySelector('#onlineCount').textContent.match(/接続中 (\d+)人/)[1]) === n, N, { timeout: 45000 });
  console.log('host reload: all players reconnected');

  // ---- Round 3 then end
  await host.click('#actions button:has-text("ラウンド3を開始")');
  for (const p of players) await p.page.waitForSelector('text=いくら出しますか？', { timeout: 15000 });
  for (let i = 0; i < N - 1; i++) {
    const pg = players[i].page;
    await pg.click('.quick .btn >> nth=2');
    await pg.click('.btn.primary.block');
  }
  await host.waitForFunction((n) => document.querySelector('.progress-num')?.textContent === `${n - 1} / ${n}人`, N);
  await host.click('#actions .btn.primary');
  await host.click('#modalActions >> text=締め切る');
  await host.waitForSelector('#phaseBadge:has-text("罰則の入力中")');
  await host.click('#actions .btn.primary');
  await host.click('#modalActions >> text=締め切る');
  await host.waitForSelector('#phaseBadge:has-text("結果発表")');
  await host.screenshot({ path: `${OUT}/10-host-results.png`, fullPage: true });
  await host.click('#actions >> text=ゲームを終了');
  await host.click('#modalActions >> text=終了して最終結果へ');
  await host.click('#commentToggle + .track');
  for (const p of players) await p.page.waitForSelector('text=ゲーム終了', { timeout: 10000 });
  await players[0].page.waitForSelector('#commentText');
  await players[0].page.fill('#commentText', 'みんなが協力すると得をするのに、自分だけ出さない方が得に見えてしまった。');
  await players[0].page.click('text=匿名で送る');
  await host.waitForSelector('.comment', { timeout: 10000 });
  await players[0].page.screenshot({ path: `${OUT}/11-player-ended.png`, fullPage: true });
  await host.click('#btnProjector');
  await host.screenshot({ path: `${OUT}/12-host-ended-projector.png`, fullPage: true });
  console.log('ended ok');

  // narrow host (phone width) check: no horizontal scroll
  await host.setViewportSize({ width: 390, height: 844 });
  const overflow = await host.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  for (const p of players.slice(0, 1)) {
    const o = await p.page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
    if (o) console.log('WARN player horizontal overflow');
  }
  if (overflow) console.log('WARN host horizontal overflow at 390px');

  console.log('errors:', errors.length ? errors.join('\n') : 'none');
  if (playerBrowser !== browser) await playerBrowser.close();
  await browser.close();
})().catch((e) => {
  console.error('FAILED', e);
  console.log('errors:', errors.join('\n'));
  process.exit(1);
});
