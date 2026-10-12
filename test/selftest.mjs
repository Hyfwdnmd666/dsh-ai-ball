// dsh-ai-ball self-test.
//
// No host, no network, no DSH process: a fake `ctx` collects what `apply()` registers and
// every tool is then driven against a throwaway folder. The plugin's whole job is file
// I/O, so this exercises all of the real logic.
//
//   node --import ./test/register.mjs test/selftest.mjs
//
// Every case here exists because something like it went wrong once.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';

import { apply, name as pluginName, inject } from '../lib/index.js';

const cases = [];
const test = (title, fn) => cases.push({ title, fn });

// ---------------------------------------------------------------- harness

function freshBallDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aiball-plugin-'));
  fs.writeFileSync(path.join(dir, 'ball.py'), '# stand-in for the real ball\n', 'utf8');
  return dir;
}

function mount(config = {}) {
  const registered = [];
  const disposers = [];
  const ctx = {
    get(service) {
      if (service === 'tools') {
        return { register: (tool) => registered.push(tool) };
      }
      return undefined;
    },
    on(event, fn) {
      if (event === 'dispose') disposers.push(fn);
    },
  };
  apply(ctx, config);
  const byName = Object.fromEntries(registered.map((t) => [t.name, t]));
  return { registered, byName, dispose: () => disposers.forEach((fn) => fn()) };
}

/**
 * The host rejects tool output that is not lossless JSON, and it does so at the transport
 * layer — after every `typeof x === 'number'` check you would ever write has passed.
 * `NaN` and `Infinity` are the quiet ways to trip it, so they are checked here.
 */
function assertLosslessJson(value, path = 'result') {
  const seen = new Set();
  const walk = (v, p) => {
    const t = typeof v;
    if (t === 'number') {
      if (!Number.isFinite(v)) throw new Error(`${p} is not lossless JSON (${v})`);
      return;
    }
    if (v === null || t === 'string' || t === 'boolean') return;
    if (t === 'undefined') throw new Error(`${p} is undefined, which is not JSON`);
    if (t !== 'object') throw new Error(`${p} is a ${t}, which is not JSON`);
    if (seen.has(v)) throw new Error(`${p} is circular`);
    seen.add(v);
    if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${p}[${i}]`));
    else for (const [k, x] of Object.entries(v)) walk(x, `${p}.${k}`);
    seen.delete(v);
  };
  walk(value, path);
}

/** Run a tool and also exercise its render(), which the host always calls. */
async function call(tool, args = {}) {
  const value = await tool.execute(args);
  assertLosslessJson(value, `${tool.name} result`);
  const rendered = tool.output.render(args, value);
  assert.ok(Array.isArray(rendered), `${tool.name}: render must return an array`);
  for (const block of rendered) {
    assert.equal(block.type, 'text', `${tool.name}: render blocks must be text`);
    assert.equal(typeof block.text, 'string', `${tool.name}: block.text must be a string`);
  }
  return { value, text: rendered.map((b) => b.text).join('\n') };
}

const read = (p) => fs.readFileSync(p, 'utf8');

// ---------------------------------------------------------------- registration

test('registers the six tools with stable names', () => {
  const { registered, byName } = mount({ ballDir: freshBallDir() });
  assert.equal(registered.length, 6);
  for (const n of ['ball_say', 'ball_mood', 'ball_listen', 'ball_panel', 'ball_status', 'ball_launch']) {
    assert.ok(byName[n], `missing tool ${n}`);
    assert.ok(byName[n].description.length > 40, `${n}: description too thin for a model`);
  }
});

test('stays idle instead of throwing when the tools service is absent', () => {
  // The host boots services in some order; a plugin that throws here would take the
  // whole process down with it (DSH boot is all-or-nothing).
  const ctx = { get: () => undefined };
  assert.doesNotThrow(() => apply(ctx, { ballDir: freshBallDir() }));
});

test('exports the host-facing shape', () => {
  assert.equal(pluginName, 'dsh-ai-ball');
  assert.deepEqual(inject, ['tools']);
});

// ---------------------------------------------------------------- ball_say

test('ball_say appends and leaves a blank line so statements separate', async () => {
  const dir = freshBallDir();
  const { byName } = mount({ ballDir: dir });
  await call(byName.ball_say, { text: '八发弹。四实四空。' });
  assert.equal(read(path.join(dir, 'monologue.log')), '八发弹。四实四空。\n\n');
  await call(byName.ball_say, { text: '……我最烦这种局。' });
  assert.equal(
    read(path.join(dir, 'monologue.log')),
    '八发弹。四实四空。\n\n……我最烦这种局。\n\n',
  );
});

test('ball_say clear=true starts a fresh panel', async () => {
  const dir = freshBallDir();
  const { byName } = mount({ ballDir: dir });
  await call(byName.ball_say, { text: 'old' });
  const { value } = await call(byName.ball_say, { text: 'new', clear: true });
  assert.equal(value.cleared, true);
  assert.equal(read(path.join(dir, 'monologue.log')), 'new\n\n');
});

test('ball_say refuses empty text rather than writing a blank line', async () => {
  const { byName } = mount({ ballDir: freshBallDir() });
  await assert.rejects(() => byName.ball_say.execute({ text: '   ' }), /text is required/);
  await assert.rejects(() => byName.ball_say.execute({}), /text is required/);
});

test('ball_say wait=true waits about as long as the ball takes to type it', async () => {
  const { byName } = mount({ ballDir: freshBallDir(), cps: 100 });
  const t0 = Date.now();
  const { value } = await call(byName.ball_say, { text: 'x'.repeat(50), wait: true });
  const elapsed = Date.now() - t0;
  assert.equal(value.spoke_for_ms, 500);
  assert.ok(elapsed >= 450, `waited only ${elapsed}ms`);
});

// ---------------------------------------------------------------- ball_mood

test('ball_mood writes the mood AND a fresh heartbeat', async () => {
  const dir = freshBallDir();
  const { byName } = mount({ ballDir: dir });
  const before = Date.now() / 1000;
  await call(byName.ball_mood, { mood: 'nervous' });
  const status = JSON.parse(read(path.join(dir, 'status.json')));
  assert.equal(status.mood, 'nervous');
  // A stale heartbeat makes the ball render grey and override the mood entirely, so a
  // mood write that skips `alive` looks exactly like the tool doing nothing.
  assert.equal(typeof status.alive, 'number');
  assert.ok(status.alive >= before, 'alive must be refreshed');
});

test('ball_mood replaces the file atomically and leaves no temp behind', async () => {
  const dir = freshBallDir();
  const { byName } = mount({ ballDir: dir });
  fs.writeFileSync(path.join(dir, 'status.json'), '{"alive": 1, "mood": "idle"}', 'utf8');
  await call(byName.ball_mood, { mood: 'smug' });
  const leftovers = fs.readdirSync(dir).filter((f) => f.includes('.tmp'));
  assert.deepEqual(leftovers, [], 'a temp file survived the rename');
});

test('ball_mood keeps beating so the orb does not go grey 20 s later', async () => {
  // The ball treats a stale `alive` as "the brain died" and renders grey, which overrides
  // the mood. A one-shot mood write therefore looks like it worked and then quietly
  // un-works. The plugin has to own the heartbeat for as long as it owns the mood.
  const dir = freshBallDir();
  const app = mount({ ballDir: dir, heartbeatMs: 40 });
  try {
    await call(app.byName.ball_mood, { mood: 'nervous' });
    const first = JSON.parse(read(path.join(dir, 'status.json')));
    await new Promise((r) => setTimeout(r, 250));
    const later = JSON.parse(read(path.join(dir, 'status.json')));
    assert.ok(later.alive > first.alive, 'the heartbeat stopped after the first write');
    assert.equal(later.mood, 'nervous', 'the heartbeat clobbered the mood it was keeping');
  } finally {
    app.dispose();
  }
});

test('dispose stops the heartbeat', async () => {
  const dir = freshBallDir();
  const app = mount({ ballDir: dir, heartbeatMs: 40 });
  await call(app.byName.ball_mood, { mood: 'smug' });
  await new Promise((r) => setTimeout(r, 120));
  app.dispose();
  const after = JSON.parse(read(path.join(dir, 'status.json'))).alive;
  await new Promise((r) => setTimeout(r, 150));
  const still = JSON.parse(read(path.join(dir, 'status.json'))).alive;
  assert.equal(still, after, 'the heartbeat kept running after dispose');
});

test('ball_mood rejects a mood the ball would not understand', async () => {
  const { byName } = mount({ ballDir: freshBallDir() });
  await assert.rejects(() => byName.ball_mood.execute({ mood: 'furious' }), /must be one of/);
  await assert.rejects(() => byName.ball_mood.execute({}), /must be one of/);
});

// ---------------------------------------------------------------- ball_listen

test('ball_listen returns new lines once, then nothing', async () => {
  const dir = freshBallDir();
  const { byName } = mount({ ballDir: dir });
  fs.writeFileSync(path.join(dir, 'input.log'), '你在干嘛\n弹仓里还剩几发\n', 'utf8');

  const first = await call(byName.ball_listen, {});
  assert.deepEqual(first.value.lines, ['你在干嘛', '弹仓里还剩几发']);

  const second = await call(byName.ball_listen, {});
  assert.deepEqual(second.value.lines, [], 'the cursor did not advance');
});

test('ball_listen consume=false peeks without advancing', async () => {
  const dir = freshBallDir();
  const { byName } = mount({ ballDir: dir });
  fs.writeFileSync(path.join(dir, 'input.log'), '你好\n', 'utf8');
  const peek = await call(byName.ball_listen, { consume: false });
  assert.deepEqual(peek.value.lines, ['你好']);
  const again = await call(byName.ball_listen, {});
  assert.deepEqual(again.value.lines, ['你好'], 'the peek consumed the line');
});

test('ball_listen holds back a half-written line', async () => {
  const dir = freshBallDir();
  const { byName } = mount({ ballDir: dir });
  const p = path.join(dir, 'input.log');
  fs.writeFileSync(p, 'complete\npart', 'utf8');
  const first = await call(byName.ball_listen, {});
  assert.deepEqual(first.value.lines, ['complete']);
  fs.appendFileSync(p, 'ial\n', 'utf8');
  const second = await call(byName.ball_listen, {});
  assert.deepEqual(second.value.lines, ['partial']);
});

test('ball_listen survives a UTF-8 character split across two writes', async () => {
  // The bug this exists for: a cursor measured in characters (or decoded with
  // replacement) turns the half-written tail into U+FFFD PERMANENTLY, because those
  // bytes are then behind the offset. Stopping at the last newline makes the partial
  // tail re-readable instead.
  const dir = freshBallDir();
  const { byName } = mount({ ballDir: dir });
  const p = path.join(dir, 'input.log');

  const full = Buffer.from('第一行\n你好\n', 'utf8');
  fs.writeFileSync(p, full.subarray(0, full.length - 3), 'utf8'); // cut inside 好
  const first = await call(byName.ball_listen, {});
  assert.deepEqual(first.value.lines, ['第一行'], 'the complete line should still arrive');

  fs.appendFileSync(p, full.subarray(full.length - 3));
  const second = await call(byName.ball_listen, {});
  assert.deepEqual(second.value.lines, ['你好'], 'the split character was corrupted or lost');
});

test('ball_listen resets when the file is cleared', async () => {
  const dir = freshBallDir();
  const { byName } = mount({ ballDir: dir });
  const p = path.join(dir, 'input.log');
  fs.writeFileSync(p, '一\n二\n三\n', 'utf8');
  await call(byName.ball_listen, {});
  fs.writeFileSync(p, '重新开始\n', 'utf8'); // shorter -> cleared/rewritten
  const after = await call(byName.ball_listen, {});
  assert.deepEqual(after.value.lines, ['重新开始']);
});

// ---------------------------------------------------------------- ball_panel

test('ball_panel writes the request with a sequence number', async () => {
  const dir = freshBallDir();
  const app = mount({ ballDir: dir, heartbeatMs: 40 });
  try {
    const { value } = await call(app.byName.ball_panel, { visible: true });
    assert.equal(value.visible, true);
    assert.equal(value.panel_seq, 1);
    const status = JSON.parse(read(path.join(dir, 'status.json')));
    assert.equal(status.panel, true);
    assert.equal(status.panel_seq, 1);
  } finally {
    app.dispose();
  }
});

test('every ball_panel call is a NEW request, so a repeat still acts', async () => {
  // The ball only moves the panel when the sequence changes, which is what keeps it from
  // fighting the human. The cost is that asking for the same thing twice has to look like
  // a new request, or "show it again after they closed it" would be a silent no-op.
  const dir = freshBallDir();
  const app = mount({ ballDir: dir, heartbeatMs: 40 });
  try {
    const first = await call(app.byName.ball_panel, { visible: true });
    const second = await call(app.byName.ball_panel, { visible: true });
    assert.ok(second.value.panel_seq > first.value.panel_seq, 'the sequence did not advance');
    assert.equal(JSON.parse(read(path.join(dir, 'status.json'))).panel_seq, second.value.panel_seq);
  } finally {
    app.dispose();
  }
});

test('ball_panel also takes over the heartbeat', async () => {
  const dir = freshBallDir();
  const app = mount({ ballDir: dir, heartbeatMs: 40 });
  try {
    await call(app.byName.ball_panel, { visible: false });
    const first = JSON.parse(read(path.join(dir, 'status.json')));
    await new Promise((r) => setTimeout(r, 250));
    const later = JSON.parse(read(path.join(dir, 'status.json')));
    assert.ok(later.alive > first.alive, 'no heartbeat after ball_panel');
    assert.equal(later.panel_seq, first.panel_seq, 'the heartbeat re-sent the request');
  } finally {
    app.dispose();
  }
});

test('no panel request means the field is absent entirely', async () => {
  // A ball that sees `panel` without a sequence ignores it on purpose. Sending one
  // anyway would be noise, and noise here looks like a command to whoever reads it next.
  const dir = freshBallDir();
  const app = mount({ ballDir: dir, heartbeatMs: 40 });
  try {
    await call(app.byName.ball_mood, { mood: 'smug' });
    const status = JSON.parse(read(path.join(dir, 'status.json')));
    assert.equal(Object.hasOwn(status, 'panel'), false, 'panel was sent without being asked for');
    assert.equal(Object.hasOwn(status, 'panel_seq'), false);
  } finally {
    app.dispose();
  }
});

test('ball_panel rejects a non-boolean rather than guessing', async () => {
  const { byName } = mount({ ballDir: freshBallDir() });
  await assert.rejects(() => byName.ball_panel.execute({}), /visible must be true or false/);
  await assert.rejects(() => byName.ball_panel.execute({ visible: 'yes' }), /visible must be true or false/);
});

// ---------------------------------------------------------------- ball_status

test('ball_status reports the wiring when configured', async () => {
  const dir = freshBallDir();
  const { byName } = mount({ ballDir: dir });
  fs.writeFileSync(path.join(dir, 'monologue.log'), '三实两空。别问了。\n\n', 'utf8');
  fs.writeFileSync(path.join(dir, 'input.log'), '你好\n', 'utf8');
  fs.writeFileSync(
    path.join(dir, 'status.json'),
    JSON.stringify({ alive: Date.now() / 1000, mood: 'smug' }),
    'utf8',
  );
  const { value, text } = await call(byName.ball_status, {});
  assert.equal(value.configured, true);
  assert.equal(value.last_said, '三实两空。别问了。');
  assert.equal(value.mood, 'smug');
  assert.ok(value.heartbeat_age_s < 5);
  assert.match(text, /三实两空/);
});

test('ball_status says so when nothing is writing status.json', async () => {
  const { byName } = mount({ ballDir: freshBallDir() });
  const { value, text } = await call(byName.ball_status, {});
  assert.equal(value.configured, true);
  // -1, not NaN: the host refuses non-lossless JSON and NaN passes every typeof test.
  assert.equal(value.heartbeat_age_s, -1);
  assert.match(text, /no heartbeat yet/);
});

test('ball_status flags a stale heartbeat as the reason the orb looks grey', async () => {
  const dir = freshBallDir();
  const { byName } = mount({ ballDir: dir });
  fs.writeFileSync(
    path.join(dir, 'status.json'),
    JSON.stringify({ alive: Date.now() / 1000 - 120, mood: 'nervous' }),
    'utf8',
  );
  const { value, text } = await call(byName.ball_status, {});
  assert.ok(value.heartbeat_age_s > 20);
  assert.match(text, /STALE/);
});

test('ball_status explains an unconfigured plugin instead of guessing a path', async () => {
  const { byName } = mount({});
  const { value, text } = await call(byName.ball_status, {});
  assert.equal(value.configured, false);
  assert.match(text, /not configured/);
  assert.match(text, /ballDir/);
});

test('a ballDir without ball.py is refused rather than written into', async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'aiball-wrong-'));
  const { byName } = mount({ ballDir: empty });
  await assert.rejects(
    () => byName.ball_say.execute({ text: 'hi' }),
    /does not look like an ai-ball folder/,
  );
  assert.deepEqual(fs.readdirSync(empty), [], 'files were written into the wrong folder');
});

// ---------------------------------------------------------------- ball_launch

test('ball_launch refuses to guess a start command', async () => {
  const { byName } = mount({ ballDir: freshBallDir() });
  await assert.rejects(() => byName.ball_launch.execute({}), /No startCommand configured/);
});

// ---------------------------------------------------------------- run

let failed = 0;
console.log(`dsh-ai-ball self-test (${cases.length} cases)\n`);
for (const { title, fn } of cases) {
  try {
    await fn();
    console.log(`  [ok] ${title}`);
  } catch (error) {
    failed += 1;
    console.log(`  [x]  ${title}`);
    console.log(`       ${error?.message ?? error}`);
  }
}
console.log(`\n${cases.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
