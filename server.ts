#!/usr/bin/env -S npx --yes tsx
// rx-claude-matrix-bridge — MCP stdio server (daemon client).
//
// Spawned by Claude Code per TUI. Connects to the always-on daemon over
// AF_UNIX, registers (session_id, cwd), receives routed Matrix events as
// channel notifications, forwards `reply` and `link_chat` tool calls to
// the daemon. Auto-spawns daemon if not running.

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { spawn } from 'node:child_process'
import * as net from 'node:net'
import { promises as fs, readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import {
  type ClientMessage,
  type DaemonMessage,
  decodeAll,
  encode,
} from './protocol.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// ---------- paths ----------

const STATE_DIR = join(
  process.env.MX_STATE_DIR ??
    join(process.env.XDG_STATE_HOME ?? join(homedir(), '.claude'), 'channels', 'rx-claude-matrix-bridge'),
)
const SOCK_FILE = join(STATE_DIR, 'daemon.sock')
const PID_FILE  = join(STATE_DIR, 'daemon.pid')
const LOG_FILE  = join(STATE_DIR, 'server.log')

// ---------- logging ----------

async function log(level: string, msg: string): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, pid: process.pid }) + '\n'
  process.stderr.write(line)
  try { await fs.appendFile(LOG_FILE, line) } catch {}
}

// ---------- config presence check ----------
//
// The bridge needs config.env with MATRIX_HOMESERVER / MATRIX_USER_ID /
// MATRIX_ACCESS_TOKEN / MATRIX_OWNER. If anything is missing, write a
// needs-setup flag (read by statusLine and the link_chat error path) and
// return a reason string. Caller decides what to do with it.

const REQUIRED_CONFIG_VARS = [
  'MATRIX_HOMESERVER',
  'MATRIX_USER_ID',
  'MATRIX_ACCESS_TOKEN',
  'MATRIX_OWNER',
] as const

// Values that look syntactically valid but are obviously the example
// placeholders shipped in config.env.example. If any required var matches
// one of these, treat the config as not-set.
const CONFIG_PLACEHOLDERS = new Set<string>([
  'replace-me',
  'https://matrix.example.org',
  'https://matrix.example.com',
  '@yourbot:example.org',
  '@yourbot:example.com',
  '@you:example.org',
  '@you:example.com',
])

async function checkConfigPresence(): Promise<{ ok: true } | { ok: false; reason: string }> {
  const configPath =
    process.env.MX_CONFIG_FILE ??
    join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
      'rx-claude-matrix-bridge',
      'config.env',
    )
  let contents: string
  try {
    contents = await fs.readFile(configPath, 'utf8')
  } catch {
    return { ok: false, reason: `config file missing at ${configPath}` }
  }
  const env: Record<string, string> = {}
  for (const line of contents.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m) env[m[1]] = m[2]
  }
  const missing = REQUIRED_CONFIG_VARS.filter((k) => !env[k] || CONFIG_PLACEHOLDERS.has(env[k]))
  if (missing.length > 0) {
    return { ok: false, reason: `config missing/placeholder vars: ${missing.join(', ')}` }
  }
  return { ok: true }
}

function setupCommandHint(): string {
  const script = join(__dirname, 'bin', 'mx-setup')
  return (
    `bridge is not configured. Run this in a separate terminal (NOT inside Claude Code), then relaunch CC:\n\n` +
    `    bash "${script}"\n\n` +
    `The wizard will collect your matrix homeserver / bot / owner, do a one-shot password login to obtain an access token, and write ~/.config/rx-claude-matrix-bridge/config.env (chmod 0600).`
  )
}

async function writeNeedsSetupFlag(reason: string): Promise<void> {
  try {
    await fs.mkdir(STATE_DIR, { recursive: true })
    await fs.writeFile(join(STATE_DIR, 'needs-setup'), reason + '\n')
  } catch {}
}

async function clearNeedsSetupFlag(): Promise<void> {
  try { await fs.unlink(join(STATE_DIR, 'needs-setup')) } catch {}
}

// ---------- daemon ensure ----------

async function daemonAlive(): Promise<boolean> {
  try {
    const pid = Number((await fs.readFile(PID_FILE, 'utf8')).trim())
    if (!pid) return false
    process.kill(pid, 0) // throws if dead
    return true
  } catch {
    return false
  }
}

// Locate the daemon entry point. Three modes:
//  1. Production bundle: server.js sits at <plugin>/dist/server.js,
//     daemon.js is its sibling.
//  2. Dev with build: tsx server.ts from repo root; dist/daemon.js exists.
//  3. Dev no build: fall back to spawning daemon.ts via tsx.
function resolveDaemonSpawn(): { cmd: string; args: string[] } {
  const sibling = join(__dirname, 'daemon.js')
  if (existsSync(sibling)) return { cmd: 'node', args: [sibling] }
  const distJs = join(__dirname, 'dist', 'daemon.js')
  if (existsSync(distJs)) return { cmd: 'node', args: [distJs] }
  const sourceTs = join(__dirname, 'daemon.ts')
  return { cmd: 'npx', args: ['--yes', 'tsx', sourceTs] }
}

async function spawnDaemon(): Promise<void> {
  const { cmd, args } = resolveDaemonSpawn()
  await log('info', `spawning daemon cmd=${cmd} args=${args.join(' ')}`)
  const out = await fs.open(LOG_FILE + '.daemon-stdio', 'a').catch(() => null)
  const child = spawn(cmd, args, {
    detached: true,
    stdio: out ? ['ignore', out.fd, out.fd] : 'ignore',
    cwd: __dirname,
    env: { ...process.env, MX_DAEMON_AUTOSPAWN: '1' },
  })
  child.unref()
  if (out) await out.close()
  // give daemon up to 5s to come up + open socket
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 100))
    if (await daemonAlive()) {
      try {
        await fs.access(SOCK_FILE)
        return
      } catch {}
    }
  }
}

// ---------- daemon socket client ----------

class DaemonClient {
  private socket: net.Socket | null = null
  private buf = ''
  private pending = new Map<number, (msg: DaemonMessage) => void>()
  private nextId = 1
  private inboundHandler: ((msg: any) => void) | null = null
  private registeredHandler: (() => void) | null = null

  async connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      const sock = net.createConnection(SOCK_FILE, () => {
        this.socket = sock
        resolve()
      })
      sock.on('error', (e) => reject(e))
      sock.on('data', (chunk) => this.onData(chunk))
      sock.on('close', () => {
        void log('warn', 'daemon socket closed; exiting MCP')
        process.exit(0)
      })
    })
  }

  private onData(chunk: Buffer): void {
    this.buf += chunk.toString('utf8')
    const { messages, leftover } = decodeAll(this.buf)
    this.buf = leftover
    for (const m of messages) {
      const msg = m as DaemonMessage
      void log('debug', `DBG daemon→mcp msg type=${msg.type}${msg.type === 'inbound' ? ` room=${msg.room_id} eid=${msg.message_id} bytes=${msg.body.length}` : ''}`)
      if (msg.type === 'inbound') {
        this.inboundHandler?.(msg)
      } else if (msg.type === 'registered') {
        this.registeredHandler?.()
      } else if (
        (msg.type === 'ack' || msg.type === 'err' || msg.type === 'rooms_ack') &&
        'id' in msg
      ) {
        const cb = this.pending.get(msg.id)
        if (cb) {
          this.pending.delete(msg.id)
          cb(msg)
        }
      }
    }
  }

  send(msg: ClientMessage): void {
    if (!this.socket) throw new Error('not connected')
    this.socket.write(encode(msg))
  }

  async request(
    msg: { type: 'link_chat'; session_id: string; cwd: string; room_id?: string; name?: string; topic?: string }
       | { type: 'reply'; room_id: string; text: string }
       | { type: 'ping' }
       | { type: 'list_rooms' }
       | { type: 'link_status'; session_id: string }
       | { type: 'unlink'; session_id: string },
    timeoutMs = 30_000,
  ): Promise<DaemonMessage> {
    const id = this.nextId++
    const full = { ...msg, id } as ClientMessage
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('daemon request timeout'))
      }, timeoutMs)
      this.pending.set(id, (resp) => {
        clearTimeout(t)
        resolve(resp)
      })
      this.send(full)
    })
  }

  onInbound(h: (msg: any) => void): void { this.inboundHandler = h }
  onRegistered(h: () => void): void { this.registeredHandler = h }
}

// ---------- main ----------

function findCcPid(): number {
  // Walk parent PIDs (Linux /proc) until we find the `claude` process.
  // server.ts → tsx node wrapper → npm → claude. process.ppid alone is
  // not enough.
  let pid = process.ppid
  for (let i = 0; i < 20; i++) {
    if (!pid || pid <= 1) break
    try {
      const comm = readFileSync(`/proc/${pid}/comm`, 'utf8').trim()
      if (comm === 'claude') return pid
      const stat = readFileSync(`/proc/${pid}/stat`, 'utf8')
      // stat format: "pid (comm) state ppid ..."
      const m = stat.match(/\)\s+\S+\s+(\d+)/)
      if (!m) break
      pid = Number(m[1])
    } catch {
      break
    }
  }
  return process.ppid // fallback if /proc unreadable (e.g. macOS)
}

async function channelsCapableWarning(sid: string): Promise<string> {
  try {
    const flag = (await fs.readFile(join(STATE_DIR, 'channels-capable', sid), 'utf8')).trim()
    if (flag === 'false') {
      return (
        `⚠ WARNING: this CC was launched WITHOUT --dangerously-load-development-channels server:matrix-bridge.\n` +
        `Matrix messages sent to this room will NOT reach this TUI (silent drop).\n` +
        `Relaunch CC with: claude --dangerously-load-development-channels server:matrix-bridge [other flags]`
      )
    }
  } catch {}
  return ''
}

async function statusLineHint(cwd: string): Promise<string> {
  // Returns a hint string if this project's .claude/settings.json lacks a
  // matrix-bridge statusLine entry; empty otherwise.
  const settingsFile = join(cwd, '.claude', 'settings.json')
  try {
    const txt = await fs.readFile(settingsFile, 'utf8')
    const obj = JSON.parse(txt)
    const cmd = obj?.statusLine?.command ?? ''
    if (String(cmd).includes('mx-status-line')) return ''
  } catch {}
  return `Tip: run /mx-enable-statusline to enable the 🔗/✏️ status indicator in this project.`
}

async function readSessionFromHook(timeoutMs = 8_000, verbose = false): Promise<{ session_id: string; cwd: string } | undefined> {
  // The SessionStart hook writes the real session_id to
  // ~/.claude/channels/.../sessions/<CC-PID>.json. We walk the parent
  // process tree to find Claude Code's PID (server.ts's process.ppid
  // is tsx wrapper, NOT CC itself).
  const ccPid = findCcPid()
  const file = join(STATE_DIR, 'sessions', `${ccPid}.json`)
  if (verbose) await log('info', `looking for session file ${file} (ccPid=${ccPid}, ppid=${process.ppid})`)
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const txt = await fs.readFile(file, 'utf8')
      const obj = JSON.parse(txt)
      if (obj?.session_id) {
        return { session_id: String(obj.session_id), cwd: String(obj.cwd || process.cwd()) }
      }
    } catch {}
    await new Promise((r) => setTimeout(r, 200))
  }
  return undefined
}

async function main(): Promise<void> {
  await fs.mkdir(STATE_DIR, { recursive: true })

  // Self-locate: write our installation root so slash-command bash scripts
  // can find bin/ without relying on CLAUDE_PLUGIN_ROOT (unset in dev mode
  // without --plugin-dir).
  try {
    await fs.writeFile(join(STATE_DIR, 'plugin-root'), __dirname)
  } catch {}

  // Determine session_id + cwd. Three sources, in order:
  //   1. CC SessionStart hook writes the real session_id under sessions/<CC-PID>.json
  //   2. CLAUDE_SESSION_ID env (rare; manual override)
  //   3. random UUID fallback — used immediately; swapped to real id by the
  //      session-watcher poll below when the hook file appears.
  //
  // CRITICAL: do NOT block here. Blocking >5s on hook poll causes CC's MCP
  // initialize to time out (-32000). Start with whatever we have; the
  // setInterval below upgrades the session_id when the hook writes.
  const quickHook = await readSessionFromHook(300, true)
  let session_id = quickHook?.session_id ?? process.env.CLAUDE_SESSION_ID ?? randomUUID()
  let cwd = quickHook?.cwd ?? process.cwd()

  // ---------- DEBUG DUMP (every startup) ----------
  // All keyed by sid so logs from multiple instances are distinguishable.
  const ccPid = findCcPid()
  const sessionFile = join(STATE_DIR, 'sessions', `${ccPid}.json`)
  let sessionFilePresent = false
  let sessionFileBody = ''
  try {
    sessionFileBody = await fs.readFile(sessionFile, 'utf8')
    sessionFilePresent = true
  } catch {}
  const daemonPidPath = join(STATE_DIR, 'daemon.pid')
  let daemonPidContent = ''
  try { daemonPidContent = (await fs.readFile(daemonPidPath, 'utf8')).trim() } catch {}
  const dump = {
    sid: session_id,
    cwd,
    sid_source: quickHook ? 'hook' : (process.env.CLAUDE_SESSION_ID ? 'env' : 'random-fallback'),
    process: { pid: process.pid, ppid: process.ppid, ccPid, argv: process.argv },
    dirname: __dirname,
    env: {
      CLAUDE_PLUGIN_ROOT: process.env.CLAUDE_PLUGIN_ROOT ?? null,
      CLAUDE_PROJECT_DIR: process.env.CLAUDE_PROJECT_DIR ?? null,
      CLAUDE_SESSION_ID: process.env.CLAUDE_SESSION_ID ?? null,
      PWD: process.env.PWD ?? null,
      HOME: process.env.HOME ?? null,
      PATH_first: (process.env.PATH ?? '').split(':').slice(0, 5),
    },
    paths: {
      state_dir: STATE_DIR,
      sock: SOCK_FILE,
      daemon_pid_path: daemonPidPath,
      daemon_pid_content: daemonPidContent,
      session_file: sessionFile,
      session_file_present: sessionFilePresent,
      session_file_body: sessionFileBody.trim(),
    },
  }
  await log('debug', `STARTUP_DUMP ${JSON.stringify(dump)}`)
  await log('info', `session_id source=${dump.sid_source} sid=${session_id}`)

  // Config presence check. If missing or placeholder, set needsSetup so
  // tool calls return an onboarding hint and statusLine shows ⚙. Daemon
  // spawn + connection are skipped entirely — daemon would crash on
  // missing config, and the MCP server should stay alive to surface the
  // setup instructions to Claude/the user.
  let needsSetup = false
  let needsSetupReason = ''
  const cfgCheck = await checkConfigPresence()
  if (!cfgCheck.ok) {
    needsSetup = true
    needsSetupReason = cfgCheck.reason
    await writeNeedsSetupFlag(cfgCheck.reason)
    await log('warn', `needs-setup: ${cfgCheck.reason}`)
  } else {
    await clearNeedsSetupFlag()
    if (!(await daemonAlive())) {
      await spawnDaemon()
    }
  }

  const client = new DaemonClient()

  if (!needsSetup) {
    // Try connect with backoff (daemon may still be starting)
    let connected = false
    for (let i = 0; i < 30; i++) {
      try {
        await client.connect()
        connected = true
        break
      } catch {
        await new Promise((r) => setTimeout(r, 200))
      }
    }
    if (!connected) {
      await log('error', 'cannot reach daemon socket')
      process.exit(1)
    }

    // Register.
    const registeredP = new Promise<void>((resolve) => client.onRegistered(resolve))
    client.send({ type: 'register', session_id, cwd })
    await Promise.race([
      registeredP,
      new Promise<void>((_, rej) => setTimeout(() => rej(new Error('register timeout')), 5_000)),
    ])
    await log('info', `registered sid=${session_id} cwd=${cwd}`)
  } else {
    await log('warn', `skipping daemon connect — needs setup: ${needsSetupReason}`)
  }

  // Watch for session_id changes (CC /clear, /resume mid-TUI, etc.) — the
  // SessionStart hook re-writes the sessions/<CC-PID>.json file each time.
  // Poll it every 5s; on change, unregister old + register new with daemon.
  // Skipped in needs-setup mode (no daemon connection to register against).
  if (!needsSetup) {
    setInterval(async () => {
      const fresh = await readSessionFromHook(500)
      if (!fresh) return
      if (fresh.session_id !== session_id) {
        const old = session_id
        session_id = fresh.session_id
        cwd = fresh.cwd
        client.send({ type: 'unregister', session_id: old })
        client.send({ type: 'register', session_id, cwd })
        await log('info', `session change old=${old} → new=${session_id}; re-registered`)
      }
    }, 5_000).unref()
  }

  // ---------- MCP server ----------

  const baseInstructions =
    `Matrix messages arrive as <channel source="matrix-bridge" chat_id="!room:server" room_name="..." message_id="..." user="..." ts="...">body</channel>.\n` +
    `\n` +
    `Tools:\n` +
    `  - reply(chat_id, text): post m.text to a Matrix room. Use the chat_id from the inbound <channel> tag.\n` +
    `  - link_chat({room_id?, name?, topic?}): bind THIS Claude session to a Matrix room. ` +
    `Pass room_id to join an existing room (bot must be invited). Omit room_id to create a new room with the given name (defaults to project basename) and invite MATRIX_OWNER. Returns room_id. ` +
    `After link, all messages in that room route to this session even after TUI restart (--resume).\n` +
    `\n` +
    `Your terminal output never reaches the user; only reply tool delivers messages back to Matrix.`

  const setupInstructions =
    `MATRIX-BRIDGE IS NOT YET CONFIGURED.\n\n` +
    setupCommandHint() +
    `\n\nUntil setup is complete, all bridge tools (reply, link_chat, list_rooms, etc.) will refuse with the same hint. Tell the user to run the setup script in their own terminal.`

  const mcp = new Server(
    { name: 'matrix-bridge', version: '0.4.3' },
    {
      capabilities: {
        tools: {},
        experimental: { 'claude/channel': {} },
      },
      instructions: needsSetup ? setupInstructions : baseInstructions,
    },
  )

  // Detect whether CC was launched with the channels flag for THIS MCP server.
  // The flag is `--dangerously-load-development-channels server:matrix-bridge`.
  // Without it, MCP tools work but `notifications/claude/channel` is dropped.
  // The flag's state is internal to CC and does NOT appear in MCP capability
  // handshake — so we read the parent CC's /proc/<pid>/cmdline instead.
  mcp.oninitialized = () => {
    const caps = mcp.getClientCapabilities()
    const ver = mcp.getClientVersion()
    let cmdline = ''
    try {
      cmdline = readFileSync(`/proc/${ccPid}/cmdline`, 'utf8').replace(/\0/g, ' ').trim()
    } catch {}
    // Match the exact pair of args: `--dangerously-load-development-channels server:matrix-bridge`.
    // Tolerate any arg ordering / whitespace between them.
    const flagRe = /--dangerously-load-development-channels\s+server:matrix-bridge\b/
    const channelsCapable = flagRe.test(cmdline)
    void log(
      channelsCapable ? 'info' : 'warn',
      `client init sid=${session_id} name=${ver?.name ?? '?'} ver=${ver?.version ?? '?'} channels-capable=${channelsCapable} experimental=${JSON.stringify(caps?.experimental ?? {})} ccPid=${ccPid}`,
    )
    void fs.mkdir(join(STATE_DIR, 'channels-capable'), { recursive: true })
      .then(() => fs.writeFile(join(STATE_DIR, 'channels-capable', session_id), channelsCapable ? 'true' : 'false'))
      .catch(() => {})
    if (!channelsCapable) {
      void log('warn',
        `MATRIX-BRIDGE: CC launched WITHOUT --dangerously-load-development-channels server:matrix-bridge. ` +
        `Matrix→TUI inbound will NOT reach this session. Relaunch with that flag.`)
    }
  }

  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: 'reply',
        description: 'Send an m.text message to a Matrix room. Use chat_id from the <channel> tag.',
        inputSchema: {
          type: 'object',
          properties: {
            chat_id: { type: 'string', description: 'Matrix room id, e.g. !abc:server.tld' },
            text:    { type: 'string', description: 'Message body (utf-8, plain text).' },
          },
          required: ['chat_id', 'text'],
        },
      },
      {
        name: 'link_chat',
        description:
          'Bind this Claude session to a Matrix room. ' +
          'Pass room_id to join an existing room, or omit to create a new one. ' +
          'Returns the room_id; subsequent messages from that room route to this session even after --resume.',
        inputSchema: {
          type: 'object',
          properties: {
            room_id: { type: 'string', description: 'Existing Matrix room id to join (optional).' },
            name:    { type: 'string', description: 'Room name when creating new (defaults to project basename).' },
            topic:   { type: 'string', description: 'Room topic when creating new (optional).' },
          },
        },
      },
      {
        name: 'list_rooms',
        description:
          'List all Matrix rooms the bot has joined. Each room includes its current ' +
          'link status (which Claude session, if any, it routes to). Use this before ' +
          'link_chat to let the user choose from existing rooms.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'link_status',
        description:
          'Return the current link for THIS Claude session (room_id, name, cwd, created_at) ' +
          'or null if not linked. Use this before /mx-link-chat to know if user is already linked.',
        inputSchema: { type: 'object', properties: {} },
      },
      {
        name: 'unlink_chat',
        description:
          'Remove the link for THIS Claude session. After unlink, Matrix messages for the ' +
          'former room route by orphan rules (sole TUI or drop). The Matrix room itself ' +
          'is not deleted, and the bot stays a member.',
        inputSchema: { type: 'object', properties: {} },
      },
    ],
  }))

  mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>
    await log('debug', `DBG tool-call sid=${session_id} tool=${req.params.name} args=${JSON.stringify(args).slice(0, 200)}`)
    if (needsSetup) {
      return { isError: true, content: [{ type: 'text' as const, text: setupCommandHint() }] }
    }
    if (req.params.name === 'reply') {
      const chat_id = String(args.chat_id ?? '')
      const text = String(args.text ?? '')
      if (!chat_id || !text) {
        return { isError: true, content: [{ type: 'text' as const, text: 'chat_id and text required' }] }
      }
      try {
        const resp = await client.request({ type: 'reply', room_id: chat_id, text })
        if (resp.type === 'err') {
          return { isError: true, content: [{ type: 'text' as const, text: `failed: ${resp.message}` }] }
        }
        return { content: [{ type: 'text' as const, text: `sent to ${chat_id}` }] }
      } catch (e: any) {
        return { isError: true, content: [{ type: 'text' as const, text: `daemon: ${e.message}` }] }
      }
    }
    if (req.params.name === 'link_status') {
      try {
        const resp = await client.request({ type: 'link_status', session_id })
        if (resp.type === 'err') {
          return { isError: true, content: [{ type: 'text' as const, text: `failed: ${resp.message}` }] }
        }
        if (resp.type === 'ack') {
          const link = resp.link
          if (link) {
            return {
              content: [{
                type: 'text' as const,
                text: `linked: session=${link.session_id} room=${link.room_id}${link.name ? ` "${link.name}"` : ''} cwd=${link.cwd} created=${link.created_at}`,
              }],
            }
          }
          return { content: [{ type: 'text' as const, text: 'not linked' }] }
        }
        return { isError: true, content: [{ type: 'text' as const, text: 'unexpected daemon response' }] }
      } catch (e: any) {
        return { isError: true, content: [{ type: 'text' as const, text: `daemon: ${e.message}` }] }
      }
    }
    if (req.params.name === 'unlink_chat') {
      try {
        const resp = await client.request({ type: 'unlink', session_id })
        if (resp.type === 'err') {
          return { isError: true, content: [{ type: 'text' as const, text: `failed: ${resp.message}` }] }
        }
        return { content: [{ type: 'text' as const, text: `unlinked session=${session_id}` }] }
      } catch (e: any) {
        return { isError: true, content: [{ type: 'text' as const, text: `daemon: ${e.message}` }] }
      }
    }
    if (req.params.name === 'list_rooms') {
      try {
        const resp = await client.request({ type: 'list_rooms' })
        if (resp.type === 'err') {
          return { isError: true, content: [{ type: 'text' as const, text: `failed: ${resp.message}` }] }
        }
        if (resp.type === 'rooms_ack') {
          const lines = resp.rooms.map((r) => {
            const linked = r.linked_session_id
              ? ` [linked: session=${r.linked_session_id.slice(0, 8)}… cwd=${r.linked_cwd}]`
              : r.linked_session_id === undefined ? '' : ''
            return `- ${r.room_id} ${r.name ? `"${r.name}"` : '(unnamed)'}${linked}`
          })
          const summary = `${resp.rooms.length} room(s):\n${lines.join('\n')}`
          return { content: [{ type: 'text' as const, text: summary }] }
        }
        return { isError: true, content: [{ type: 'text' as const, text: 'unexpected daemon response' }] }
      } catch (e: any) {
        return { isError: true, content: [{ type: 'text' as const, text: `daemon: ${e.message}` }] }
      }
    }
    if (req.params.name === 'link_chat') {
      try {
        const resp = await client.request({
          type: 'link_chat',
          session_id,
          cwd,
          room_id: args.room_id ? String(args.room_id) : undefined,
          name: args.name ? String(args.name) : undefined,
          topic: args.topic ? String(args.topic) : undefined,
        })
        if (resp.type === 'err') {
          return { isError: true, content: [{ type: 'text' as const, text: `failed: ${resp.message}` }] }
        }
        const rid = (resp as any).room_id ?? '(unknown)'
        const hint = await statusLineHint(cwd)
        const chanWarn = await channelsCapableWarning(session_id)
        return {
          content: [{
            type: 'text' as const,
            text:
              `linked session=${session_id} room=${rid}. ` +
              `Accept Matrix invite from MATRIX_OWNER if it's a new room.` +
              (chanWarn ? `\n\n${chanWarn}` : '') +
              (hint ? `\n\n${hint}` : ''),
          }],
        }
      } catch (e: any) {
        return { isError: true, content: [{ type: 'text' as const, text: `daemon: ${e.message}` }] }
      }
    }
    return { isError: true, content: [{ type: 'text' as const, text: `unknown tool: ${req.params.name}` }] }
  })

  // Wire daemon-pushed inbounds → CC channel notifications.
  client.onInbound(async (m) => {
    await log('debug', `DBG onInbound enter sid=${session_id} room=${m.room_id} eid=${m.message_id} bytes=${m.body.length}`)
    try {
      await mcp.notification({
        method: 'notifications/claude/channel',
        params: {
          content: m.body,
          meta: {
            chat_id: m.room_id,
            room_name: m.room_name,
            message_id: m.message_id,
            user: m.sender,
            ts: m.ts,
          },
        },
      })
      await log('info', `DBG mcp.notification SENT sid=${session_id} room=${m.room_id} eid=${m.message_id} bytes=${m.body.length}`)
    } catch (e: any) {
      await log('error', `DBG mcp.notification FAILED sid=${session_id} room=${m.room_id} eid=${m.message_id} err=${e?.message ?? e}`)
    }
  })

  await mcp.connect(new StdioServerTransport())
  await log('info', `started session=${session_id} cwd=${cwd}`)
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e?.message ?? e}\n`)
  process.exit(1)
})
