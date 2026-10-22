// dsh-ai-ball — give the agent a mouth.
//
// ai-ball is a Windows overlay: a floating orb that streams whatever gets appended to
// monologue.log, colours its rim from the mood in status.json, and appends whatever the
// human types into input.log. The ball is deliberately dumb — it watches files and knows
// nothing else.
//
// So this plugin is thin on purpose. It does not talk to the ball, drive its window, or
// spawn Python: it writes the files the ball is already watching. That is the whole
// integration, and it is why any process can be the brain.
//
// Four things an obvious implementation gets wrong, all of them learned the hard way:
//
//   * `ball_mood` must refresh `alive` too. The ball reads a stale `alive` as "the brain
//     died" and renders grey — which OVERRIDES the mood you just set. A mood write
//     without the heartbeat looks like it silently did nothing.
//
//   * If `brain.py` is running, it rewrites status.json every three seconds and will
//     stomp your mood back to "idle". Set `"write_mood": false` in brain.json if you want
//     to own the ball's face. The tool description says this out loud, because otherwise
//     you lose an afternoon to it.
//
//   * Reading input.log must advance the offset only to the LAST NEWLINE. A concurrent
//     writer can be caught mid-character; decoding that tail turns half a UTF-8 sequence
//     into U+FFFD permanently, because those bytes are then behind the offset. Stopping
//     at the last newline makes the partial tail re-readable, which is simply correct.
//
//   * status.json is replaced atomically (tmp + rename). The ball polls it about once a
//     second and a half-written file fails to parse, which silently reverts the mood.
//
// No path is hardcoded. `ballDir` has no default on purpose: guessing where somebody
// unpacked the ball is how plugins end up writing into the wrong directory.
//
// ---------------------------------------------------------------------------------------
// The listening half.
//
// Writing to the ball makes it a puppet: the agent talks and nothing comes back. Real
// conversation needs the other direction, and it needs it to be PUSH, not poll — an agent
// that only hears you when it happens to call ball_listen does not have a conversation,
// it has a stage.
//
// So the plugin watches input.log itself and hands each new line to `agent.followup(...)`
// as a genuine user message. The contract (dsh-agent runtime-types):
//
//     followup(message) — "Queue an ordinary follow-up turn and wake the driver. The item
//     becomes the sole ordinary message of its own turn."
//
// which is exactly what a user typing a message means, and why `followup` is right here
// and its three siblings are not: `steer` wedges into the current step, `inject` does not
// wake an idle driver, and `send` needs an explicit inbox target.
//
// The agent comes from `exec.agent` on a tool call (dsh-tools declares `readonly agent?:
// Agent` on the execution). A plugin-level context has no agent, so the ball learns whose
// mouth it is the first time any ball tool runs.
//
// `followInput` (default on) is the switch. With it on, the watcher owns the read cursor
// and ball_listen will normally report nothing new — the words already reached you as a
// user message, which is strictly better. Turn it off to go back to polling, and remember
// that brain.py reads input.log too: two readers means two replies.
// ---------------------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { defineTool } from '@deepseek-ai/dsh-tools';

export const name = 'dsh-ai-ball';

// We only need the tool registry. Cordsis will not call apply() until it exists.
export const inject = ['tools'];

// `createUserMessage` lives in the host's dsh-llm. Import it defensively: a static import
// that fails takes the plugin (or, worse, the host's boot) down with it, and this is a
// nicety, not a reason to break anything.
let createUserMessage = null;
try {
  ({ createUserMessage } = await import('@deepseek-ai/dsh-llm'));
} catch {
  /* fallback below */
}

/**
 * Build the user message the ball's input turns into.
 *
 * `createUserMessage` only stamps `role: 'user'` and a fresh id onto the input, so the
 * fallback is the same shape by hand — worth having, because the alternative is "listening
 * silently does nothing" on a host where dsh-llm isn't importable from here.
 */
function userMessageFrom(text) {
  const input = {
    content: [{ type: 'text', text }],
    // `kind: 'user'` because that is what this is — the human really did type it, just
    // through an orb instead of a chat box. It is also what the host's own prompt
    // injection uses (dsh-subagent-in-process-driver: `child.followup(createUserMessage({
    // content: prompt, source: { kind: 'user' } }))`). `kind: 'plugin'` is a real source
    // kind too, but it belongs to exec.deferContext, and a plugin-flagged user message may
    // be treated as untrusted input rather than as the human speaking.
    source: { kind: 'user' },
  };
  if (createUserMessage) return createUserMessage(input);
  return { ...input, role: 'user', id: globalThis.crypto.randomUUID() };
}

const MOODS = ['idle', 'thinking', 'nervous', 'smug', 'broken'];
const DEFAULT_FILES = {
  monologue: 'monologue.log',
  input: 'input.log',
  status: 'status.json',
};
const STALE_AFTER_S = 20; // must match ball.py's status.stale_s default
const DEFAULT_CPS = 50;   // ball's reveal speed, chars/second
const FOLLOW_MS = 700;    // input.log poll interval for the follow watcher

const objectSchema = (properties, required) => ({
  type: 'object',
  properties,
  ...(required ? { required } : {}),
  additionalProperties: false,
});

const textBlock = (text) => [{ type: 'text', text }];

function configOf(config = {}) {
  const raw = config.ballDir || process.env.AIBALL_DIR || '';
  return {
    dir: raw ? path.resolve(String(raw)) : '',
    files: { ...DEFAULT_FILES, ...(config.files || {}) },
    startCommand: config.startCommand || process.env.AIBALL_START || '',
    cps: Number.isFinite(config.cps) && config.cps > 0 ? config.cps : DEFAULT_CPS,
    heartbeatMs: Number.isFinite(config.heartbeatMs) && config.heartbeatMs > 0
      ? config.heartbeatMs
      : HEARTBEAT_MS,
    // Deliver what the human types into the orb as a real user message. See the header.
    followInput: config.followInput !== false,
    followMs: Number.isFinite(config.followMs) && config.followMs > 0
      ? config.followMs
      : FOLLOW_MS,
  };
}

function pathsOf(cfg) {
  return {
    monologue: path.join(cfg.dir, cfg.files.monologue),
    input: path.join(cfg.dir, cfg.files.input),
    status: path.join(cfg.dir, cfg.files.status),
  };
}

/**
 * Fail loudly and usefully when the ball is not where we were told.
 *
 * Writing into a directory that merely exists is worse than refusing: you get a plugin
 * that reports success and a ball that never says anything.
 */
/**
 * The non-throwing form of the same question, for code that runs on a timer and has nobody
 * to report to. `keepAlive` used to run unconditionally at load, which quietly wrote
 * status.json into whatever directory happened to be configured — exactly the "wrote into
 * the wrong folder" failure `ensureBall` exists to prevent, caught by its own regression
 * test the moment the heartbeat moved to load.
 */
function looksLikeBall(cfg) {
  return Boolean(
    cfg.dir
    && fs.existsSync(cfg.dir)
    && fs.existsSync(path.join(cfg.dir, 'ball.py')),
  );
}

function ensureBall(cfg) {
  if (!cfg.dir) {
    throw new Error(
      'ai-ball is not configured. Set "ballDir" in this plugin\'s config (or the ' +
      'AIBALL_DIR environment variable) to the folder that contains ball.py — for ' +
      'example C:\\tools\\ai-ball.',
    );
  }
  if (!fs.existsSync(cfg.dir)) {
    throw new Error(`ballDir does not exist: ${cfg.dir}`);
  }
  const ballPy = path.join(cfg.dir, 'ball.py');
  if (!fs.existsSync(ballPy)) {
    throw new Error(
      `ballDir does not look like an ai-ball folder (no ball.py): ${cfg.dir}`,
    );
  }
}

function statSize(p) {
  try {
    return fs.statSync(p).size;
  } catch {
    return -1;
  }
}

/** Last non-empty line of a file, bounded. Used for the status readout. */
function tailLine(p, max = 200) {
  try {
    const text = fs.readFileSync(p, 'utf8');
    const lines = text.split('\n').map((s) => s.trim()).filter(Boolean);
    const last = lines[lines.length - 1] || '';
    return last.length > max ? `${last.slice(0, max)}…` : last;
  } catch {
    return '';
  }
}

function readStatus(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    return null;
  }
}

/** How often to refresh `alive`. Comfortably inside ball.py's 20 s stale window. */
const HEARTBEAT_MS = 3000;

export function apply(ctx, config = {}) {
  // DSH boots all-or-nothing: a plugin that throws while registering takes the whole
  // process down with it — including the settings UI you would use to switch it back off.
  // So a mistake here must cost you the plugin, not the harness. Fail soft, fail loud.
  try {
    registerTools(ctx, config);
  } catch (error) {
    console.error('[dsh-ai-ball] registration failed; plugin idle:', error);
  }
}

function registerTools(ctx, config) {
  const cfg = configOf(config);
  const tools = ctx.get('tools');
  if (tools === undefined) {
    // Not an error: the host may have started us before the registry.
    console.log('[dsh-ai-ball] tools service unavailable; plugin idle');
    return;
  }

  // ---- heartbeat and standing requests ------------------------------------------
  //
  // The ball reads a stale `alive` as "the brain died" and renders grey, which OVERRIDES
  // the mood. So a plugin that claims the mood must also claim the heartbeat, or the face
  // it just set quietly turns grey ~20 seconds later and looks like a bug in the ball.
  //
  // `panel` carries a SEQUENCE. `panel` alone is a level, and a level re-asserted every
  // few seconds would fight the human for the panel toggle: they close it, we open it
  // again a second later. A new sequence means "this is a new request"; an unchanged one
  // means "still what I said last time", which leaves their toggle alone.
  const desired = { mood: 'idle', panel: null };
  let panelSeq = 0;
  let heartbeat = null;

  /** Write the whole status file once. Atomic: the ball polls it about once a second. */
  const beatOnce = (mood) => {
    const p = pathsOf(cfg);
    const payload = { alive: Date.now() / 1000, mood };
    if (desired.panel !== null) {
      payload.panel = desired.panel;
      payload.panel_seq = panelSeq;
    }
    const tmp = `${p.status}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(payload), 'utf8');
    fs.renameSync(tmp, p.status);
  };

  /**
   * Start (or keep) the heartbeat. Idempotent.
   *
   * An explicit mood wins. Otherwise the first beat KEEPS whatever mood is already in the
   * file, so merely loading the plugin does not stomp a game mod's face. Later beats also
   * preserve the file, so another writer's mood survives us instead of being steamrolled
   * every few seconds.
   */
  const keepAlive = (takeMood) => {
    if (takeMood !== undefined) desired.mood = takeMood;
    try {
      const current = readStatus(pathsOf(cfg).status);
      const mood = takeMood !== undefined
        ? takeMood
        : (typeof current?.mood === 'string' ? current.mood : desired.mood);
      beatOnce(mood);
    } catch {
      /* the ball tolerates a missing status file; so do we */
    }
    if (heartbeat !== null) return;
    heartbeat = setInterval(() => {
      try {
        const current = readStatus(pathsOf(cfg).status);
        beatOnce(typeof current?.mood === 'string' ? current.mood : desired.mood);
      } catch {
        /* transient: a locked file is not worth killing the timer over */
      }
    }, cfg.heartbeatMs);
    // Do not hold the host open on our account; it has its own reasons to run.
    heartbeat.unref?.();
  };

  const stopAlive = () => {
    if (heartbeat !== null) {
      clearInterval(heartbeat);
      heartbeat = null;
    }
  };

  // Cordis disposes plugins on reload; a leaked interval would keep writing to a file the
  // next instance is also writing to. Optional-chained because a missing lifecycle API
  // must not be the thing that breaks the plugin.
  ctx.on?.('dispose', stopAlive);

  // ---- the ball's owner, learned from a tool call --------------------------------
  //
  // A plugin-level context carries no agent (dsh-agent: "the agent association installed
  // as an own property on Agent.ctx"). Tool executions do. So the first time any ball tool
  // runs, the plugin learns whose mouth this is and can push to it afterwards.
  let ballAgent = null;

  const track = (tool) => {
    const inner = tool.execute;
    return defineTool({
      ...tool,
      async execute(args, exec) {
        if (exec?.agent) ballAgent = exec.agent;
        return inner(args, exec);
      },
    });
  };

  // ---- one read cursor, shared by the watcher and ball_listen --------------------
  //
  // Two independent cursors over one file means the same sentence gets consumed twice: once
  // as a delivered message and once as a tool result. Whoever reads first wins, and the
  // other correctly finds nothing.
  let listenOffset = 0;
  // Fingerprint of the file's first bytes. Length alone cannot tell "cleared and rewritten
  // with something longer" from "appended to" — same bug, same fix as ball.py's `head`.
  let listenHead = null;

  /**
   * Byte-accurate incremental read of input.log, advancing the shared cursor.
   *
   * The cursor only ever moves to the LAST NEWLINE. A concurrent writer can be caught
   * mid-character, and decoding that tail would turn half a UTF-8 sequence into U+FFFD
   * permanently, because those bytes then sit behind the offset. Stopping at the last
   * newline makes the partial tail re-readable, which is simply correct.
   */
  const readNewInput = (consume) => {
    const p = pathsOf(cfg);
    if (!fs.existsSync(p.input)) return [];
    const buf = fs.readFileSync(p.input);

    const head = buf.subarray(0, 64);
    const rewritten = listenHead !== null
      && !head.subarray(0, listenHead.length).equals(listenHead);
    listenHead = Buffer.from(head);

    if (buf.length < listenOffset || rewritten) listenOffset = 0;
    if (buf.length === listenOffset) return [];

    const chunk = buf.subarray(listenOffset).toString('utf8');
    const cut = chunk.lastIndexOf('\n');
    if (cut < 0) return [];   // mid-line; leave it for next time

    const complete = chunk.slice(0, cut);
    const lines = complete.split('\n').map((s) => s.trim()).filter(Boolean);
    // Byte length of the consumed prefix, not the character count.
    if (consume) listenOffset += Buffer.byteLength(complete, 'utf8') + 1;
    return lines;
  };

  // ---- the watcher: input.log -> a real user message ------------------------------
  let watcher = null;
  // Why the last delivery failed, if it did. `console.error` goes to a host log nobody can
  // read from here, and "listening silently does nothing" is exactly the bug this feature
  // exists to fix — so the failure surfaces through ball_status instead.
  let followError = '';
  let followDelivered = 0;

  const startWatcher = () => {
    if (!cfg.followInput || watcher !== null) return;
    watcher = setInterval(() => {
      if (ballAgent === null) return;   // nobody has spoken through the ball yet
      let lines;
      try {
        lines = readNewInput(true);
      } catch {
        return;                          // a transient read error is not worth a crash
      }
      if (!lines.length) return;
      const text = lines.join('\n');
      try {
        ballAgent.followup(userMessageFrom(text));
        followDelivered += 1;
        followError = '';
      } catch (error) {
        // Put the words back so the next tick retries instead of losing what the human
        // typed, and remember why so ball_status can say it out loud.
        listenOffset -= Buffer.byteLength(`${text}\n`, 'utf8');
        followError = error instanceof Error ? error.message : String(error);
      }
    }, cfg.followMs);
    watcher.unref?.();
  };

  const stopWatcher = () => {
    if (watcher !== null) {
      clearInterval(watcher);
      watcher = null;
    }
  };

  ctx.on?.('dispose', stopWatcher);

  // The harness being up means the ball's owner is up. Beat from load rather than waiting
  // for the first ball_mood, so the orb does not sit grey until somebody happens to set a
  // mood. The first beat keeps any mood already in the file.
  //
  // Gated on the directory actually being an ai-ball folder: beating into an arbitrary
  // configured path is how this plugin would write status.json into the wrong place.
  if (looksLikeBall(cfg)) {
    keepAlive();
    startWatcher();
  } else if (cfg.dir) {
    console.log(`[dsh-ai-ball] ${cfg.dir} does not look like an ai-ball folder; not beating`);
  }

  // ---- ball_say ---------------------------------------------------------------------
  tools.register(track({
    name: 'ball_say',
    description:
      'Say something through the ai-ball orb. The text is appended to monologue.log and the ' +
      'ball types it out on screen, character by character, like speech. Multiple calls queue ' +
      'up and are spoken in order. Use this for anything a viewer should read in the moment — ' +
      'it is a mouth, not a log. Set clear=true to wipe the panel first (it reads as starting a ' +
      'fresh thought rather than adding to the pile).',
    parameters: {
      text: {
        type: 'string',
        description: 'What to say. Newlines are kept; Markdown is not rendered.',
        required: true,
      },
      clear: {
        type: 'boolean',
        description: 'Empty the panel before speaking. Default false.',
      },
      wait: {
        type: 'boolean',
        description:
          'Also wait out the typing animation, so the next thing you do happens after the ' +
          'ball has finished speaking. Default false (calls queue in the ball instead).',
      },
    },
    output: {
      schema: objectSchema({
        chars: { type: 'integer' },
        bytes: { type: 'integer' },
        cleared: { type: 'boolean' },
        spoke_for_ms: { type: 'integer' },
      }),
      render: (args, v) => textBlock(
        `Spoke ${v.chars} chars${v.cleared ? ' (panel cleared first)' : ''}`
        + (v.spoke_for_ms ? ` — waited ~${v.spoke_for_ms} ms for the typewriter` : ''),
      ),
    },
    async execute(args) {
      ensureBall(cfg);
      const text = String(args?.text ?? '').replace(/\s+$/, '');
      if (!text) throw new Error('text is required');
      const p = pathsOf(cfg);
      const cleared = Boolean(args?.clear);
      if (cleared) fs.writeFileSync(p.monologue, '', 'utf8');
      // Trailing blank line: the ball reveals "\n\n" as a pause, which is what makes
      // two consecutive statements read as two statements.
      fs.appendFileSync(p.monologue, `${text}\n\n`, 'utf8');

      let waited = 0;
      if (args?.wait) {
        waited = Math.round((text.length / cfg.cps) * 1000);
        await new Promise((r) => setTimeout(r, Math.min(waited, 60000)));
      }
      return {
        chars: text.length,
        bytes: statSize(p.monologue),
        cleared,
        spoke_for_ms: waited,
      };
    },
  }));

  // ---- ball_mood --------------------------------------------------------------------
  tools.register(track({
    name: 'ball_mood',
    description:
      'Set the orb\'s colour to signal what you are doing. Also refreshes the heartbeat, ' +
      'because a stale heartbeat makes the ball render grey and OVERRIDE the mood — which ' +
      'looks exactly like the tool did nothing. IMPORTANT: if brain.py is running it rewrites ' +
      'status.json every few seconds and will reset this to "idle"; set "write_mood": false in ' +
      'brain.json when you want the agent to own the ball\'s face.',
    parameters: {
      mood: {
        type: 'string',
        description: `One of: ${MOODS.join(', ')}.`,
        required: true,
      },
    },
    output: {
      schema: objectSchema({
        mood: { type: 'string' },
        alive: { type: 'number' },
      }),
      render: (args, v) => textBlock(`Orb mood: ${v.mood}`),
    },
    async execute(args) {
      ensureBall(cfg);
      const mood = String(args?.mood ?? '').toLowerCase();
      if (!MOODS.includes(mood)) {
        throw new Error(`mood must be one of: ${MOODS.join(', ')}`);
      }
      // Writes now and keeps it fresh from here on. Without the ongoing beat the ball
      // turns grey after ball.py's 20 s stale window and the mood disappears with it.
      keepAlive(mood);
      return { mood, alive: Date.now() / 1000 };
    },
  }));

  // ---- ball_listen ------------------------------------------------------------------
  tools.register(track({
    name: 'ball_listen',
    description:
      'Read what the human typed into the ball\'s input box (input.log). Returns only what is '
      + 'new since the previous call; pass consume=false to look without advancing. '
      + 'With followInput on (the default) the plugin ALREADY delivers each new line to you as '
      + 'a real user message, and owns the read cursor — so this normally reports nothing, and '
      + 'that is success, not silence: the words reached you as a message instead. It remains '
      + 'useful for anything typed before the watcher started, and it is the only reader when '
      + 'followInput is off.',
    parameters: {
      consume: {
        type: 'boolean',
        description: 'Advance the read cursor. Default true; false peeks.',
      },
    },
    output: {
      schema: objectSchema({
        lines: { type: 'array', items: { type: 'string' } },
        offset: { type: 'integer' },
        following: { type: 'boolean' },
        truncated: { type: 'boolean' },
      }),
      render: (args, v) => textBlock(
        v.lines.length
          ? v.lines.map((l) => `> ${l}`).join('\n')
          : (v.following
            ? '(nothing pending — new input is delivered to you as a message automatically)'
            : '(nothing new typed into the ball)'),
      ),
    },
    async execute(args) {
      ensureBall(cfg);
      const consume = args?.consume !== false;
      const lines = readNewInput(consume);
      return { lines, offset: listenOffset, following: cfg.followInput, truncated: false };
    },
  }));

  // ---- ball_panel -------------------------------------------------------------------
  tools.register(track({
    name: 'ball_panel',
    description:
      'Show or hide the orb\'s monologue panel. A hidden panel still receives ball_say text — ' +
      'it just is not on screen — so if you are about to say something a human should read, ' +
      'this is how you make sure they can. Every call counts as a NEW request (it carries a ' +
      'sequence number), so calling it again re-asserts it even if you asked for the same ' +
      'thing before; between requests the human\'s own toggling is left alone.',
    parameters: {
      visible: {
        type: 'boolean',
        description: 'true to show the panel, false to hide it.',
        required: true,
      },
    },
    output: {
      schema: objectSchema({
        visible: { type: 'boolean' },
        panel_seq: { type: 'integer' },
      }),
      render: (args, v) => textBlock(
        `Panel ${v.visible ? 'shown' : 'hidden'} (request #${v.panel_seq})`,
      ),
    },
    async execute(args) {
      ensureBall(cfg);
      if (typeof args?.visible !== 'boolean') {
        throw new Error('visible must be true or false');
      }
      desired.panel = args.visible;
      panelSeq += 1;          // a new request, so the ball acts even on a repeat
      keepAlive();
      return { visible: desired.panel, panel_seq: panelSeq };
    },
  }));

  // ---- ball_status ------------------------------------------------------------------
  tools.register(track({
    name: 'ball_status',
    description:
      'Report the orb\'s wiring without touching it: where ballDir points, which files exist ' +
      'and how big they are, the last thing said, and how fresh the heartbeat is. Call this ' +
      'first when something looks wrong — it distinguishes "the ball is not running" from ' +
      '"the ball is running but nobody is writing to it".',
    parameters: {},
    output: {
      schema: objectSchema({
        configured: { type: 'boolean' },
        dir: { type: 'string' },
        monologue_bytes: { type: 'integer' },
        input_bytes: { type: 'integer' },
        last_said: { type: 'string' },
        heartbeat_age_s: { type: 'number' },
        mood: { type: 'string' },
        beating: { type: 'boolean' },
        following: { type: 'boolean' },
        agent_known: { type: 'boolean' },
        delivered: { type: 'integer' },
        follow_error: { type: 'string' },
        note: { type: 'string' },
      }),
      render: (args, v) => textBlock(
        v.configured
          ? [
              `ai-ball: ${v.dir}`,
              `monologue.log ${v.monologue_bytes} B, input.log ${v.input_bytes} B`,
              v.last_said ? `last said: ${v.last_said}` : 'last said: (nothing yet)',
              v.heartbeat_age_s >= 0
                ? `heartbeat ${v.heartbeat_age_s.toFixed(1)}s old`
                  + (v.heartbeat_age_s > STALE_AFTER_S
                    ? ' — STALE, so the ball is rendering grey regardless of mood'
                    : '')
                : 'no heartbeat yet — nothing is writing status.json',
              v.mood ? `mood: ${v.mood}` : '',
              v.beating
                ? 'heartbeat: this plugin is keeping status.json fresh'
                : 'heartbeat: not from this plugin — call ball_mood once to take it over',
              // The listening half, which is the part that silently does nothing when it
              // is broken. Say enough here to diagnose it without a restart-and-guess loop.
              v.following
                ? (v.agent_known
                  ? `listening: on, ${v.delivered} message(s) delivered to you so far`
                  : 'listening: on, but no agent has called a ball tool yet — the plugin '
                    + 'cannot know whose mouth the ball is, so nothing is delivered yet')
                : 'listening: OFF (followInput is false) — use ball_listen to poll',
              v.follow_error ? `listening ERROR: ${v.follow_error}` : '',
              v.note,
            ].filter(Boolean).join('\n')
          : `ai-ball is not configured. ${v.note}`,
      ),
    },
    async execute() {
      // -1, never NaN. The host rejects tool output that is not lossless JSON, and NaN
      // is the quiet way to fail that check — it survives every `typeof x === 'number'`
      // test you would write and only blows up in the transport.
      const base = {
        configured: false,
        dir: cfg.dir,
        monologue_bytes: -1,
        input_bytes: -1,
        last_said: '',
        heartbeat_age_s: -1,
        mood: '',
        beating: heartbeat !== null,
        following: cfg.followInput,
        agent_known: ballAgent !== null,
        delivered: followDelivered,
        follow_error: followError,
        note: '',
      };
      if (!cfg.dir) {
        return { ...base, note: 'Set "ballDir" to the folder containing ball.py.' };
      }
      if (!fs.existsSync(path.join(cfg.dir, 'ball.py'))) {
        return { ...base, note: `No ball.py in ${cfg.dir} — wrong folder?` };
      }
      const p = pathsOf(cfg);
      const status = readStatus(p.status);
      const alive = typeof status?.alive === 'number' && Number.isFinite(status.alive)
        ? status.alive
        : null;
      return {
        ...base,
        configured: true,
        monologue_bytes: statSize(p.monologue),
        input_bytes: statSize(p.input),
        last_said: tailLine(p.monologue),
        heartbeat_age_s: alive === null ? -1 : Date.now() / 1000 - alive,
        mood: typeof status?.mood === 'string' ? status.mood : '',
        note: 'The ball owns the files; nothing here proves its window is on screen.',
      };
    },
  }));

  // ---- ball_launch ------------------------------------------------------------------
  tools.register(track({
    name: 'ball_launch',
    description:
      'Start the ball using the command in this plugin\'s "startCommand" config (for example ' +
      'the path to start.bat). Detached, so it outlives this call. Deliberately has no default: ' +
      'guessing where somebody installed the ball is how you end up launching the wrong exe. ' +
      'Write-only — this cannot tell whether a ball is already running, so calling it twice ' +
      'gives you two orbs.',
    parameters: {
      command: {
        type: 'string',
        description: 'Override the configured startCommand for this call.',
      },
    },
    output: {
      schema: objectSchema({
        pid: { type: "integer" },
        command: { type: 'string' },
      }),
      render: (args, v) => textBlock(`Started ai-ball (pid ${v.pid}) via: ${v.command}`),
    },
    async execute(args) {
      const cmd = String(args?.command || cfg.startCommand || '');
      if (!cmd) {
        throw new Error(
          'No startCommand configured. Set "startCommand" in this plugin\'s config to '
          + 'the path of ai-ball start.bat, or to the python command that runs ball.py.',
        );
      }
      // stdio: 'ignore' is not laziness. Under the DSH sandbox a child that inherits a
      // named pipe fails with EPERM, so the default 'pipe' cannot be used at all.
      const child = spawn(cmd, {
        cwd: cfg.dir || process.cwd(),
        shell: true,
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      return { pid: child.pid ?? 0, command: cmd };
    },
  }));

  console.log(
    `[dsh-ai-ball] registered 6 tools`
    + (cfg.dir ? ` against ${cfg.dir}` : ' (ballDir not configured yet)'),
  );
}
