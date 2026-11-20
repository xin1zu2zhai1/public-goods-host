import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../js/game.js';

function seeded(seed = 1) {
  let s = seed;
  return () => {
    s = (s * 16807) % 2147483647;
    return (s - 1) / 2147483646;
  };
}

function pid(i) {
  return `player-${String(i).padStart(4, '0')}`;
}

function setup(n, settings = {}) {
  const state = G.createState('123456', settings);
  for (let i = 1; i <= n; i++) G.addPlayer(state, pid(i), `生徒${i}`);
  return state;
}

test('groupSizes keeps groups close to the target size', () => {
  assert.deepEqual(G.groupSizes(4, 4), [4]);
  assert.deepEqual(G.groupSizes(3, 4), [3]);
  assert.deepEqual(G.groupSizes(5, 4), [5]);
  assert.deepEqual(G.groupSizes(6, 4), [3, 3]);
  assert.deepEqual(G.groupSizes(7, 4), [4, 3]);
  assert.deepEqual(G.groupSizes(10, 4), [4, 3, 3]);
  assert.deepEqual(G.groupSizes(40, 4), Array(10).fill(4));
  assert.deepEqual(G.groupSizes(9, 0), [9]);
  for (let n = 3; n <= 200; n++) {
    const sizes = G.groupSizes(n, 4);
    assert.equal(sizes.reduce((a, b) => a + b, 0), n);
    assert.ok(Math.min(...sizes) >= 3 && Math.max(...sizes) <= 5, `n=${n} -> ${sizes}`);
  }
});

test('labels go A..Z then AA', () => {
  assert.equal(G.labelFor(0), 'A');
  assert.equal(G.labelFor(25), 'Z');
  assert.equal(G.labelFor(26), 'AA');
  assert.equal(G.labelFor(27), 'AB');
});

test('players: join, rejoin, invalid ids, closed entry', () => {
  const s = G.createState('000001');
  assert.equal(G.addPlayer(s, 'bad id!', 'x').ok, false);
  const a = G.addPlayer(s, pid(1), '  たろう\u0000 ');
  assert.equal(a.ok, true);
  assert.equal(a.player.name, 'たろう');
  const again = G.addPlayer(s, pid(1), 'たろう2');
  assert.equal(again.rejoined, true);
  assert.equal(Object.keys(s.players).length, 1);
  const anon = G.addPlayer(s, pid(2), '');
  assert.equal(anon.player.name, '参加者2');
  s.settings.acceptJoin = false;
  assert.equal(G.addPlayer(s, pid(3), 'x').reason, 'closed');
  // 既存の参加者は受付終了後でも再接続できる
  assert.equal(G.addPlayer(s, pid(1), '').ok, true);
});

test('payoff formula without punishment: (E - c) + m * sum / n', () => {
  const s = setup(4);
  G.startRound(s, seeded(3));
  const r = G.currentRound(s);
  assert.equal(r.groups.length, 1);
  const amounts = { [pid(1)]: 1000, [pid(2)]: 500, [pid(3)]: 0, [pid(4)]: 300 };
  for (const [p, a] of Object.entries(amounts)) assert.equal(G.submitContribution(s, p, a).ok, true);
  assert.equal(G.allSubmitted(s), true);
  G.closeContributions(s);
  assert.equal(s.phase, 'result');
  const sum = 1800;
  const share = (2 * sum) / 4; // 900
  assert.equal(r.results[pid(1)].payoff, 0 + share);
  assert.equal(r.results[pid(3)].payoff, 1000 + share);
  assert.equal(r.results[pid(4)].payoff, 700 + share);
  assert.equal(r.groupStats[r.groups[0].id].sum, sum);
  // 全員全額で効率100%、全員0円で50%
});

test('contribution is clamped and validated', () => {
  const s = setup(2);
  G.startRound(s);
  assert.equal(G.submitContribution(s, pid(1), 99999).ok, true);
  assert.equal(G.currentRound(s).contributions[pid(1)], 1000);
  assert.equal(G.submitContribution(s, pid(1), -5).ok, true);
  assert.equal(G.currentRound(s).contributions[pid(1)], 0);
  assert.equal(G.submitContribution(s, pid(1), 'abc').ok, false);
  assert.equal(G.submitContribution(s, 'player-nobody', 10).ok, false);
});

test('missing contributions count as 0 and are flagged', () => {
  const s = setup(4);
  G.startRound(s);
  G.submitContribution(s, pid(1), 400);
  assert.equal(G.allSubmitted(s), false);
  G.closeContributions(s);
  const r = G.currentRound(s);
  assert.equal(r.missing.length, 3);
  assert.equal(r.results[pid(2)].missing, true);
  assert.equal(r.results[pid(2)].contribution, 0);
  assert.equal(r.results[pid(2)].payoff, 1000 + 200);
});

test('punishment: cost to punisher, loss to target', () => {
  const s = setup(4, { punishment: true });
  G.startRound(s, seeded(5));
  const r = G.currentRound(s);
  const g = r.groups[0];
  const [a, b, c, d] = g.members;
  for (const p of [a, b, c]) G.submitContribution(s, p, 1000);
  G.submitContribution(s, d, 0);
  G.closeContributions(s);
  assert.equal(s.phase, 'punish');
  const L = g.labels;
  // a は d に 2 回、b は d に 1 回、自分自身への罰と範囲外は無視
  G.submitPunishment(s, a, { [L[d]]: 2, [L[a]]: 3 });
  G.submitPunishment(s, b, { [L[d]]: 1, ZZ: 4 });
  G.submitPunishment(s, c, { [L[d]]: 99 });
  assert.equal(r.punishments[c][d], 3, 'clamped to punishMax');
  assert.equal(G.allSubmitted(s), false);
  G.submitPunishment(s, d, {});
  assert.equal(G.allSubmitted(s), true);
  G.closePunishment(s);
  const share = (2 * 3000) / 4; // 1500
  assert.equal(r.results[a].payoff, share - 200);
  assert.equal(r.results[b].payoff, share - 100);
  assert.equal(r.results[c].payoff, share - 300);
  assert.equal(r.results[d].payoff, 1000 + share - 6 * 300);
  assert.equal(r.results[d].punishReceived, 6);
});

test('punishment off: punish phase is skipped', () => {
  const s = setup(3);
  G.startRound(s);
  G.closeContributions(s);
  assert.equal(s.phase, 'result');
});

test('stage increments when the punishment rule changes', () => {
  const s = setup(4);
  const play = () => {
    G.startRound(s);
    G.closeContributions(s);
    if (s.phase === 'punish') G.closePunishment(s);
  };
  play();
  play();
  s.settings.punishment = true;
  play();
  play();
  s.settings.punishment = false;
  play();
  assert.deepEqual(s.rounds.map((r) => r.stage), [1, 1, 2, 2, 3]);
  assert.deepEqual(s.rounds.map((r) => r.punishment), [false, false, true, true, false]);
});

test('toggling punishment during the input phase updates the current round', () => {
  const s = setup(4);
  G.startRound(s);
  s.settings.punishment = true;
  G.syncRoundSettings(s);
  assert.equal(G.currentRound(s).punishment, true);
  G.closeContributions(s);
  assert.equal(s.phase, 'punish');
});

test('late joiners are placed into groups at the next round', () => {
  const s = setup(8);
  G.startRound(s, seeded(2));
  assert.equal(G.currentRound(s).groups.length, 2);
  G.addPlayer(s, pid(100), '遅刻1');
  G.closeContributions(s);
  G.startRound(s, seeded(2));
  const r2 = G.currentRound(s);
  const total = r2.groups.reduce((a, g) => a + g.members.length, 0);
  assert.equal(total, 9);
  const p = s.players[pid(100)];
  const g = r2.groups.find((gg) => gg.id === p.groupId);
  assert.ok(g.members.includes(pid(100)));
  assert.equal(new Set(g.members.map((m) => g.labels[m])).size, g.members.length, 'labels unique');
  // 3人以上まとまって遅れてきたら新グループ
  for (let i = 0; i < 4; i++) G.addPlayer(s, pid(200 + i), '');
  G.closeContributions(s);
  G.startRound(s, seeded(2));
  assert.equal(G.currentRound(s).groups.length, 3);
});

test('removing a player during input removes them from the round', () => {
  const s = setup(4);
  G.startRound(s);
  G.submitContribution(s, pid(1), 1000);
  G.removePlayer(s, pid(2));
  const r = G.currentRound(s);
  assert.equal(r.groups[0].members.length, 3);
  assert.equal(s.players[pid(2)], undefined);
  assert.equal(G.addPlayer(s, pid(2), 'again').reason, 'removed');
  G.closeContributions(s);
  assert.equal(r.results[pid(1)].groupN, 3);
});

test('removing a player after a round keeps their history', () => {
  const s = setup(4);
  G.startRound(s);
  G.closeContributions(s);
  G.removePlayer(s, pid(3));
  assert.equal(s.players[pid(3)].removed, true);
  G.startRound(s);
  assert.equal(G.currentRound(s).groups[0].members.length, 3);
  assert.ok(G.toCSV(s).includes('生徒3'));
});

test('cancelRound and end/resume', () => {
  const s = setup(4);
  G.startRound(s);
  assert.equal(G.endGame(s).ok, false);
  G.cancelRound(s);
  assert.equal(s.phase, 'lobby');
  assert.equal(s.rounds.length, 0);
  G.startRound(s);
  G.closeContributions(s);
  assert.equal(G.endGame(s).ok, true);
  assert.equal(s.phase, 'ended');
  G.resumeGame(s);
  assert.equal(s.phase, 'result');
});

test('playerView hides names and others’ inputs until revealed', () => {
  const s = setup(4, { punishment: true });
  G.startRound(s, seeded(7));
  G.submitContribution(s, pid(1), 600);
  let v = G.playerView(s, pid(2));
  assert.equal(v.phase, 'contribute');
  assert.equal(v.reveal, null, 'contributions are hidden while entering');
  assert.equal(v.my.contribution, null);
  assert.equal(v.progress.group.submitted, 1);
  assert.ok(v.group.members.every((m) => m.name === null));
  assert.ok(!JSON.stringify(v).includes('生徒1'));
  G.closeContributions(s);
  v = G.playerView(s, pid(2));
  assert.equal(v.phase, 'punish');
  assert.equal(v.reveal.length, 4);
  assert.equal(v.reveal.find((m) => m.contribution === 600).me, false);
  assert.ok(!JSON.stringify(v).includes('player-0001'), 'other pids are not leaked');
  G.closePunishment(s);
  v = G.playerView(s, pid(1));
  assert.equal(v.result.contribution, 600);
  assert.equal(v.history.length, 1);
  assert.equal(v.classSeries.length, 1);
  s.settings.showNames = true;
  v = G.playerView(s, pid(1));
  assert.ok(v.result.members.some((m) => m.name === '生徒2'));
});

test('playerView summary at the end of the game', () => {
  const s = setup(4);
  for (let i = 0; i < 3; i++) {
    G.startRound(s);
    for (let k = 1; k <= 4; k++) G.submitContribution(s, pid(k), 1000);
    G.closeContributions(s);
  }
  G.endGame(s);
  const v = G.playerView(s, pid(1));
  assert.equal(v.summary.rounds, 3);
  assert.equal(v.summary.myTotal, 6000);
  assert.equal(v.summary.bestCase, 6000);
  assert.equal(v.summary.worstCase, 3000);
  assert.equal(G.classSeries(s)[0].efficiency, 1);
});

test('comments only when enabled, cleaned', () => {
  const s = setup(1);
  assert.equal(G.addComment(s, 'hi').ok, false);
  s.settings.acceptComments = true;
  assert.equal(G.addComment(s, '   ').ok, false);
  const c = G.addComment(s, 'a'.repeat(500));
  assert.equal(c.comment.text.length, 200);
});

test('CSV escapes and guards formula injection', () => {
  const s = G.createState('1');
  G.addPlayer(s, pid(1), '=HYPERLINK("x")');
  G.addPlayer(s, pid(2), 'a,b');
  G.startRound(s);
  G.closeContributions(s);
  const csv = G.toCSV(s);
  assert.ok(csv.includes(`"'=HYPERLINK(""x"")"`));
  assert.ok(csv.includes('"a,b"'));
});

test('sanitizeSettings clamps values', () => {
  const s = G.sanitizeSettings({ endowment: -1, multiplier: 2.345, groupSize: 'x', punishMax: 999, punishment: 'yes' });
  assert.equal(s.endowment, 100);
  assert.equal(s.multiplier, 2.35);
  assert.equal(s.groupSize, 4);
  assert.equal(s.punishMax, 20);
  assert.equal(s.punishment, false);
});

test('large class: 120 players play a round quickly', () => {
  const s = setup(120);
  G.startRound(s, seeded(9));
  for (let i = 1; i <= 120; i++) G.submitContribution(s, pid(i), (i * 37) % 1001);
  assert.equal(G.allSubmitted(s), true);
  G.closeContributions(s);
  const t0 = Date.now();
  const series = G.classSeries(s);
  for (let i = 1; i <= 120; i++) G.playerView(s, pid(i), { series });
  assert.ok(Date.now() - t0 < 500);
  assert.equal(G.currentRound(s).groups.length, 30);
});
