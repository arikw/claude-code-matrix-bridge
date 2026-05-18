#!/usr/bin/env -S npx --yes tsx
// rx-claude-matrix-bridge — standalone Matrix daemon.
//
// Always-on Node process. Owns Matrix /sync. Maintains a registry of
// connected TUIs (session_id → socket) and a persistent map of
// (session_id → room_id) in links.tsv. Routes inbound m.text events:
//   1. If a TUI is connected for the session, push over its socket.
//   2. Else, spawn `claude --print --resume <session_id>` headlessly,
//      parse stream-json, post the assistant text back to Matrix.
//   3. Orphan rooms (no link): if exactly one TUI connected, route there
//      as a fallback; else drop + log.
//
// Spawned by server.ts (or manually) via `npx tsx daemon.ts`.

import { spawn } from 'node:child_process'
import { promises as fs, readFileSync } from 'node:fs'
import * as net from 'node:net'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  type ClientMessage,
  type DaemonMessage,
  decodeAll,
  encode,
  type InboundMsg,
} from './protocol.js'

// ---------- paths ----------

const STATE_DIR = join(
  process.env.MX_STATE_DIR ??
    join(process.env.XDG_STATE_HOME ?? join(homedir(), '.claude'), 'channels', 'rx-claude-matrix-bridge'),
)
const SINCE_FILE   = join(STATE_DIR, 'since-token')
const LINKS_FILE   = join(STATE_DIR, 'links.tsv')
const LOG_FILE     = join(STATE_DIR, 'daemon.log')
const PID_FILE     = join(STATE_DIR, 'daemon.pid')
const VERSION_FILE = join(STATE_DIR, 'daemon.version')
const SOCK_FILE    = join(STATE_DIR, 'daemon.sock')

// Daemon advertises its own version via VERSION_FILE; server.ts checks
// on connect and SIGTERMs + respawns a stale daemon after a plugin
// update. Version is read at startup from package.json (single source of
// truth) — never hardcoded.
const DAEMON_VERSION = readOwnVersion()

function readOwnVersion(): string {
  let d = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(d, 'package.json'), 'utf8'))
      if (pkg?.name === 'rx-claude-matrix-bridge') return String(pkg.version || '0.0.0')
    } catch {}
    const parent = dirname(d)
    if (parent === d) break
    d = parent
  }
  return '0.0.0'
}
const TYPING_DIR   = join(STATE_DIR, 'typing')
const LAST_PROMPT_DIR = join(STATE_DIR, 'last-tui-prompt')
const LAST_MATRIX_DIR = join(STATE_DIR, 'last-matrix-msg')
const ROOM_NAMES_DIR = join(STATE_DIR, 'room-names')

function sanitizeRoomId(rid: string): string {
  return rid.replace(/[^A-Za-z0-9_-]/g, '_')
}

async function writeTypingFlag(roomId: string, on: boolean): Promise<void> {
  const file = join(TYPING_DIR, sanitizeRoomId(roomId))
  try {
    if (on) {
      await fs.mkdir(TYPING_DIR, { recursive: true })
      await fs.writeFile(file, '1')
    } else {
      await fs.unlink(file).catch(() => {})
    }
  } catch {}
}

// ---------- channel-switch timestamps ----------
// last-tui-prompt/<sid> is written by the UserPromptSubmit hook on every
// TUI prompt. last-matrix-msg/<sid> is written here on every inbound from
// the linked room. Comparing the two on each turn detects whether the
// owner switched channels (and therefore needs a cross-channel recap).

async function readLastTuiPrompt(sid: string): Promise<string | undefined> {
  try {
    const t = (await fs.readFile(join(LAST_PROMPT_DIR, sid), 'utf8')).trim()
    return t || undefined
  } catch { return undefined }
}

async function readLastMatrixMsg(sid: string): Promise<string | undefined> {
  try {
    const t = (await fs.readFile(join(LAST_MATRIX_DIR, sid), 'utf8')).trim()
    return t || undefined
  } catch { return undefined }
}

async function writeLastMatrixMsg(sid: string, iso: string): Promise<void> {
  try {
    await fs.mkdir(LAST_MATRIX_DIR, { recursive: true })
    await fs.writeFile(join(LAST_MATRIX_DIR, sid), iso)
  } catch {}
}

// ---------- config ----------

interface Config {
  homeserver: string
  user: string
  token: string
  owner: string
}

let cfg: Config

async function loadConfigFile(): Promise<void> {
  const path =
    process.env.MX_CONFIG_FILE ??
    join(
      process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'),
      'rx-claude-matrix-bridge',
      'config.env',
    )
  let contents: string
  try {
    contents = await fs.readFile(path, 'utf8')
  } catch {
    return
  }
  for (const line of contents.split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/)
    if (m && process.env[m[1]] === undefined) {
      process.env[m[1]] = m[2]
    }
  }
}

function buildConfig(): Config {
  const req = (k: string) => {
    const v = process.env[k]
    if (!v) throw new Error(`${k} unset`)
    return v
  }
  return {
    homeserver: req('MATRIX_HOMESERVER').replace(/\/$/, ''),
    user: req('MATRIX_USER_ID'),
    token: req('MATRIX_ACCESS_TOKEN'),
    owner: req('MATRIX_OWNER'),
  }
}

// ---------- logging ----------

async function log(level: string, msg: string): Promise<void> {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg }) + '\n'
  process.stderr.write(line)
  try {
    await fs.appendFile(LOG_FILE, line)
  } catch {}
}

// ---------- matrix API ----------

async function api(
  method: 'GET' | 'POST' | 'PUT',
  path: string,
  body?: unknown,
  timeoutMs = 60_000,
): Promise<any> {
  const url = `${cfg.homeserver}/_matrix/client/v3${path}`
  const ctrl = new AbortController()
  const t = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    })
    if (!resp.ok) {
      const text = await resp.text().catch(() => '')
      const err: any = new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`)
      err.status = resp.status
      throw err
    }
    return await resp.json()
  } finally {
    clearTimeout(t)
  }
}

// ---------- helpers ----------

let txnCounter = 0
function txnId(): string {
  return `mxbr-${Date.now()}-${process.pid}-${++txnCounter}`
}

function redactControls(s: string): string {
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '')
}

function truncate(s: string, max = 16_384): string {
  return s.length <= max ? s : s.slice(0, max - 16) + '… (truncated)'
}

async function sinceRead(): Promise<string | undefined> {
  try {
    const t = (await fs.readFile(SINCE_FILE, 'utf8')).trim()
    return t || undefined
  } catch {
    return undefined
  }
}

async function sinceWrite(token: string): Promise<void> {
  const tmp = SINCE_FILE + '.tmp'
  await fs.writeFile(tmp, token)
  await fs.rename(tmp, SINCE_FILE)
}

async function roomName(roomId: string): Promise<string> {
  try {
    const r = await api('GET', `/rooms/${encodeURIComponent(roomId)}/state/m.room.name`, undefined, 10_000)
    const name = String(r?.name ?? '')
    if (name) {
      // Cache for statusLine + any other zero-token consumer.
      const cacheFile = join(ROOM_NAMES_DIR, sanitizeRoomId(roomId))
      try {
        await fs.mkdir(ROOM_NAMES_DIR, { recursive: true })
        await fs.writeFile(cacheFile, name)
      } catch {}
    }
    return name
  } catch {
    return ''
  }
}

async function postRoom(roomId: string, body: string): Promise<void> {
  const safe = truncate(redactControls(body))
  if (!safe) return
  // Stop typing BEFORE posting so the client sees the indicator clear
  // at the moment the reply lands.
  await stopTyping(roomId, 'reply')
  const txn = txnId()
  await api(
    'PUT',
    `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txn)}`,
    { msgtype: 'm.text', body: safe },
    30_000,
  )
}

// ---------- typing indicator ----------
// Debounced 2s before showing m.typing. Auto-stop after 5min safety.

const TYPING_DEBOUNCE_MS = 2_000

interface TypingState {
  pending?: NodeJS.Timeout
  interval?: NodeJS.Timeout
  autoStop?: NodeJS.Timeout
}
const typingState = new Map<string, TypingState>()

async function pingTyping(roomId: string, on: boolean): Promise<void> {
  try {
    await api(
      'PUT',
      `/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(cfg.user)}`,
      on ? { typing: true, timeout: 30_000 } : { typing: false },
      10_000,
    )
  } catch (e: any) {
    await log('warn', `typing room=${roomId} on=${on} err=${e?.message ?? e}`)
  }
}

function startTyping(roomId: string): void {
  if (typingState.has(roomId)) return
  const pending = setTimeout(() => {
    const st = typingState.get(roomId)
    if (!st) return
    st.pending = undefined
    void pingTyping(roomId, true)
    st.interval = setInterval(() => void pingTyping(roomId, true), 20_000)
    st.autoStop = setTimeout(() => void stopTyping(roomId, 'auto-stop-5min'), 300_000)
  }, TYPING_DEBOUNCE_MS)
  typingState.set(roomId, { pending })
}

async function stopTyping(roomId: string, reason = 'reply'): Promise<void> {
  const st = typingState.get(roomId)
  if (!st) return
  const wasActive = st.interval !== undefined
  if (st.pending) clearTimeout(st.pending)
  if (st.interval) clearInterval(st.interval)
  if (st.autoStop) clearTimeout(st.autoStop)
  typingState.delete(roomId)
  if (wasActive) await pingTyping(roomId, false)
  await log('info', `typing-stop room=${roomId} reason=${reason} sent=${wasActive}`)
}

// ---------- links.tsv ----------
// columns: session_id<TAB>room_id<TAB>cwd<TAB>name<TAB>created_at

interface Link {
  session_id: string
  room_id: string
  cwd: string
  name: string
  created_at: string
}

async function linksRead(): Promise<Link[]> {
  try {
    const text = await fs.readFile(LINKS_FILE, 'utf8')
    return text
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => {
        const [session_id, room_id, cwd, name, created_at] = l.split('\t')
        return { session_id, room_id, cwd, name, created_at }
      })
  } catch {
    return []
  }
}

async function linksWrite(links: Link[]): Promise<void> {
  const text = links
    .map((l) => `${l.session_id}\t${l.room_id}\t${l.cwd}\t${l.name}\t${l.created_at}`)
    .join('\n') + (links.length ? '\n' : '')
  const tmp = LINKS_FILE + '.tmp'
  await fs.writeFile(tmp, text)
  await fs.rename(tmp, LINKS_FILE)
}

async function linksAddOrUpdate(link: Link): Promise<void> {
  const all = await linksRead()
  const filtered = all.filter((l) => l.session_id !== link.session_id && l.room_id !== link.room_id)
  filtered.push(link)
  await linksWrite(filtered)
}

async function linkBySession(session_id: string): Promise<Link | undefined> {
  return (await linksRead()).find((l) => l.session_id === session_id)
}

async function linkByRoom(room_id: string): Promise<Link | undefined> {
  return (await linksRead()).find((l) => l.room_id === room_id)
}

async function linksRemoveSession(session_id: string): Promise<boolean> {
  const all = await linksRead()
  const filtered = all.filter((l) => l.session_id !== session_id)
  if (filtered.length === all.length) return false
  await linksWrite(filtered)
  return true
}

// ---------- registry: connected TUIs ----------

interface Registration {
  session_id: string
  cwd: string
  socket: net.Socket
}

// Multiple sockets per session_id allowed (handles /mcp reconnect race,
// multiple MCP processes for the same TUI). Each socket is independent.
const registered = new Map<string, Set<Registration>>() // session_id → set of regs

function regsFor(session_id: string): Set<Registration> {
  let s = registered.get(session_id)
  if (!s) { s = new Set(); registered.set(session_id, s) }
  return s
}

function regCount(): number {
  let n = 0
  for (const s of registered.values()) n += s.size
  return n
}

function send(socket: net.Socket, msg: DaemonMessage): void {
  try {
    socket.write(encode(msg))
  } catch {}
}

function broadcastToSession(session_id: string, msg: DaemonMessage): boolean {
  const s = registered.get(session_id)
  if (!s || s.size === 0) return false
  for (const reg of s) send(reg.socket, msg)
  return true
}


// ---------- routing ----------

async function deliverInbound(roomId: string, evt: any): Promise<void> {
  let body = redactControls(String(evt.content?.body ?? ''))
  await log('debug', `DBG inbound recv room=${roomId} evt=${evt.event_id} sender=${evt.sender} bytes=${body.length} registered=[${[...registered.keys()].map((k) => `${k}:${registered.get(k)?.size ?? 0}`).join(',')}]`)
  if (!body) {
    await log('debug', `DBG inbound drop room=${roomId} evt=${evt.event_id} (empty body)`)
    return
  }
  const name = await roomName(roomId)
  const evtIso = new Date(Number(evt.origin_server_ts) || Date.now()).toISOString()

  // 1. Linked? Look up session_id.
  const link = await linkByRoom(roomId)
  await log('debug', `DBG inbound link room=${roomId} evt=${evt.event_id} link=${link ? `sid=${link.session_id}` : 'NONE'}`)
  if (link) {
    startTyping(roomId)
    const sid = link.session_id

    // Channel-switch detection: if the owner's last TUI prompt is newer
    // than their last matrix message, they were typing on TUI in between.
    // Tell the main model to summarize TUI activity before answering.
    const lastTui = await readLastTuiPrompt(sid)
    const prevMatrix = await readLastMatrixMsg(sid)
    const switched =
      lastTui &&
      (!prevMatrix || Date.parse(lastTui) > Date.parse(prevMatrix))
    if (switched) {
      const sinceLabel = prevMatrix ?? 'the start of this session'
      body =
        `[matrix-bridge recap-since ${sinceLabel}] The user was active on the TUI since ` +
        `their last matrix message at ${sinceLabel}. Before answering:\n` +
        `1. Give a brief 3-6 bullet recap of TUI activity since that time using your existing session context.\n` +
        `2. Classify the user's incoming message below: substantive request, OR presence-only ping ` +
        `(short greetings like "hi", "back", "I'm here", "ping", "you there", "what's up", etc.).\n` +
        `3. If presence-only ping: reply with ONLY the recap plus one final line stating whether your ` +
        `attention is required (a pending question to answer, a decision to confirm, an error to react ` +
        `to) or whether they can resume what they were doing. Do NOT invent follow-up questions; do ` +
        `NOT ask "what would you like next?".\n` +
        `4. If substantive: give the recap, then handle the request normally.\n\n${body}`
      await log('info', `recap-since tui→matrix sid=${sid} prevMatrix=${prevMatrix ?? '(none)'} lastTui=${lastTui}`)
    }
    await writeLastMatrixMsg(sid, evtIso)

    const inbound: InboundMsg = {
      type: 'inbound',
      room_id: roomId,
      room_name: name,
      message_id: evt.event_id,
      sender: evt.sender,
      body,
      ts: evtIso,
    }

    const regs = registered.get(sid)
    await log('debug', `DBG inbound broadcast sid=${sid} sockets=${regs?.size ?? 0}`)
    if (regs && regs.size > 0) {
      const encoded = encode(inbound)
      let i = 0
      for (const reg of regs) {
        i++
        const writable = reg.socket.writable
        const destroyed = reg.socket.destroyed
        try {
          const ok = reg.socket.write(encoded)
          await log('debug', `DBG inbound socket-write sid=${sid} sock#${i} writable=${writable} destroyed=${destroyed} write-ok=${ok} bytes=${encoded.length}`)
        } catch (e: any) {
          await log('warn', `DBG inbound socket-write sid=${sid} sock#${i} ERR ${e?.message ?? e}`)
        }
      }
      await log('info', `inbound→tui room=${roomId} sid=${sid} evt=${evt.event_id}`)
      return
    }
    // Socket unreachable (TUI never connected or disconnected without a
    // Stop) → headless fallback.
    await log('debug', `DBG inbound no-socket sid=${sid} → headless`)
    void runHeadless(link, body, roomId)
    return
  }

  const inbound: InboundMsg = {
    type: 'inbound',
    room_id: roomId,
    room_name: name,
    message_id: evt.event_id,
    sender: evt.sender,
    body,
    ts: new Date(Number(evt.origin_server_ts) || Date.now()).toISOString(),
  }

  // 2. Orphan room. If exactly one TUI session registered (one or more
  //    sockets all belonging to it), route there.
  if (registered.size === 1) {
    const [session_id] = registered.keys()
    startTyping(roomId)
    broadcastToSession(session_id, inbound)
    await log('info', `inbound→tui room=${roomId} sid=${session_id} (orphan→sole)`)
    return
  }

  await log('warn', `inbound dropped room=${roomId} (orphan, ${regCount()} sockets across ${registered.size} sessions)`)
}

// ---------- headless fallback ----------

async function runHeadless(link: Link, msg: string, roomId: string): Promise<void> {
  await log('info', `headless room=${roomId} sid=${link.session_id} cwd=${link.cwd}`)
  const args = [
    '--print',
    '--output-format', 'stream-json',
    '--verbose',
    '--resume', link.session_id,
    '--add-dir', link.cwd,
    '--', msg,
  ]
  const env: NodeJS.ProcessEnv = { ...process.env, MX_HEADLESS: '1' }
  // permission mode: caller may have set MX_CLAUDE_PERMISSION_MODE
  if (env.MX_CLAUDE_PERMISSION_MODE) {
    args.splice(args.length - 2, 0, '--permission-mode', env.MX_CLAUDE_PERMISSION_MODE)
  }

  // MX_HEADLESS tells the UserPromptSubmit hook to skip the [TUI]
  // prompt-mirror — without it, every headless turn echoes the matrix
  // user's message back to the room as `[TUI] <their-own-text>`.
  const child = spawn('claude', args, {
    cwd: link.cwd,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let stdout = ''
  let stderr = ''
  child.stdout.on('data', (d) => { stdout += d.toString() })
  child.stderr.on('data', (d) => { stderr += d.toString() })

  child.on('close', async (code) => {
    if (code !== 0) {
      await log('error', `headless rc=${code} room=${roomId} stderr=${stderr.slice(0, 500)}`)
      try {
        await postRoom(roomId, `[bridge] claude exited rc=${code}`)
      } catch {}
      return
    }
    // Extract assistant text from stream-json (last `result` event = final reply)
    const lines = stdout.split('\n').filter((l) => l.trim())
    let reply = ''
    for (const line of lines) {
      try {
        const evt = JSON.parse(line)
        if (evt.type === 'assistant') {
          for (const c of evt.message?.content ?? []) {
            if (c.type === 'text' && c.text) {
              reply += (reply ? '\n\n' : '') + c.text
            }
          }
        }
      } catch {}
    }
    if (!reply) {
      // fallback: look at result event
      for (const line of lines) {
        try {
          const evt = JSON.parse(line)
          if (evt.type === 'result' && evt.result) {
            reply = String(evt.result)
            break
          }
        } catch {}
      }
    }
    if (!reply) reply = '[bridge] (no assistant text in response)'
    try {
      await postRoom(roomId, reply)
      await log('info', `headless reply room=${roomId} bytes=${reply.length}`)
    } catch (e: any) {
      await log('error', `headless post-fail room=${roomId} err=${e?.message ?? e}`)
    }
  })
}

// ---------- handle client commands ----------

async function handleMessage(socket: net.Socket, msg: ClientMessage): Promise<void> {
  switch (msg.type) {
    case 'register': {
      // Allow multiple sockets per session_id. Old (stale) sockets are
      // cleaned up when they actually close, not on new registers.
      const reg: Registration = { session_id: msg.session_id, cwd: msg.cwd, socket }
      regsFor(msg.session_id).add(reg)
      send(socket, { type: 'registered', session_id: msg.session_id })
      await log('info', `register sid=${msg.session_id} cwd=${msg.cwd} (${regCount()} sockets across ${registered.size} sessions)`)
      return
    }
    case 'unregister': {
      const set = registered.get(msg.session_id)
      if (set) {
        for (const reg of set) {
          if (reg.socket === socket) set.delete(reg)
        }
        if (set.size === 0) registered.delete(msg.session_id)
      }
      await log('info', `unregister sid=${msg.session_id} (${regCount()} sockets)`)
      return
    }
    case 'reply': {
      try {
        await postRoom(msg.room_id, msg.text)
        send(socket, { type: 'ack', id: msg.id })
        await log('info', `reply room=${msg.room_id} bytes=${msg.text.length}`)
      } catch (e: any) {
        send(socket, { type: 'err', id: msg.id, message: e?.message ?? String(e) })
      }
      return
    }
    case 'link_chat': {
      try {
        let room_id = msg.room_id
        let name = msg.name ?? ''
        if (!room_id) {
          // Create new room.
          name = name || msg.cwd.split('/').filter(Boolean).pop() || 'session'
          const payload = {
            name: `[claude] ${name}`,
            topic: msg.topic ?? `Claude session ${msg.session_id} · cwd=${msg.cwd}`,
            invite: [cfg.owner],
            preset: process.env.MX_ROOM_PRESET ?? 'trusted_private_chat',
            is_direct: true,
          }
          const resp = await api('POST', '/createRoom', payload, 30_000)
          room_id = String(resp.room_id)
          await log('info', `created room=${room_id} for sid=${msg.session_id}`)
        } else {
          // Join existing room (if not already member). Idempotent.
          try {
            await api('POST', `/rooms/${encodeURIComponent(room_id)}/join`, {}, 15_000)
            await log('info', `joined room=${room_id} for sid=${msg.session_id}`)
          } catch (e: any) {
            // Already-joined errors are 403 with M_FORBIDDEN; harmless.
            await log('info', `join room=${room_id} (probably already joined): ${e?.message}`)
          }
        }
        await linksAddOrUpdate({
          session_id: msg.session_id,
          room_id,
          cwd: msg.cwd,
          name: name || '',
          created_at: new Date().toISOString(),
        })
        send(socket, { type: 'ack', id: msg.id, room_id })
      } catch (e: any) {
        send(socket, { type: 'err', id: msg.id, message: e?.message ?? String(e) })
      }
      return
    }
    case 'ping': {
      send(socket, { type: 'ack', id: msg.id })
      return
    }
    case 'link_status': {
      try {
        const link = await linkBySession(msg.session_id)
        send(socket, { type: 'ack', id: msg.id, link: link ?? null })
      } catch (e: any) {
        send(socket, { type: 'err', id: msg.id, message: e?.message ?? String(e) })
      }
      return
    }
    case 'unlink': {
      try {
        const removed = await linksRemoveSession(msg.session_id)
        await log('info', `unlink sid=${msg.session_id} removed=${removed}`)
        send(socket, { type: 'ack', id: msg.id })
      } catch (e: any) {
        send(socket, { type: 'err', id: msg.id, message: e?.message ?? String(e) })
      }
      return
    }
    case 'session_stopped': {
      // Stop hook fired for this session → Claude's turn is done. Stop any
      // room typing (Claude either replied via the reply tool — which
      // already called stopTyping — or chose not to).
      try {
        const link = await linkBySession(msg.session_id)
        if (link) {
          await stopTyping(link.room_id, 'session-stopped')
        }
      } catch {}
      return
    }
    case 'list_rooms': {
      try {
        const joined = await api('GET', '/joined_rooms', undefined, 15_000)
        const roomIds: string[] = joined?.joined_rooms ?? []
        const links = await linksRead()
        const rooms = await Promise.all(
          roomIds.map(async (room_id) => {
            const link = links.find((l) => l.room_id === room_id)
            const name = await roomName(room_id)
            return {
              room_id,
              name,
              linked_session_id: link?.session_id,
              linked_cwd: link?.cwd,
            }
          }),
        )
        send(socket, { type: 'rooms_ack', id: msg.id, rooms })
      } catch (e: any) {
        send(socket, { type: 'err', id: msg.id, message: e?.message ?? String(e) })
      }
      return
    }
  }
}

// ---------- socket server ----------

async function startSocketServer(): Promise<net.Server> {
  // Remove stale socket file if present.
  try { await fs.unlink(SOCK_FILE) } catch {}

  const server = net.createServer((socket) => {
    let buf = ''
    let session_id_for_socket: string | null = null

    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      const { messages, leftover } = decodeAll(buf)
      buf = leftover
      for (const m of messages) {
        if (m.type === 'register') session_id_for_socket = m.session_id
        void handleMessage(socket, m as ClientMessage)
      }
    })

    socket.on('close', () => {
      if (session_id_for_socket) {
        const set = registered.get(session_id_for_socket)
        if (set) {
          for (const reg of set) {
            if (reg.socket === socket) set.delete(reg)
          }
          if (set.size === 0) registered.delete(session_id_for_socket)
        }
        void log('info', `disconnect sid=${session_id_for_socket} (${regCount()} sockets across ${registered.size} sessions)`)
      }
    })

    socket.on('error', () => {/* ignore */})
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(SOCK_FILE, () => resolve())
  })

  // 0700 perms — owner-only.
  await fs.chmod(SOCK_FILE, 0o700).catch(() => {})

  return server
}

// ---------- sync loop ----------

async function syncLoop(): Promise<never> {
  let since = await sinceRead()
  const seen = new Set<string>()
  const seenOrder: string[] = []
  let backoff = 5_000

  while (true) {
    try {
      const url = since
        ? `/sync?timeout=30000&since=${encodeURIComponent(since)}`
        : `/sync?timeout=30000`
      const resp = await api('GET', url, undefined, 60_000)
      backoff = 5_000

      const next = resp.next_batch
      if (next) {
        await sinceWrite(next)
        since = next
      }

      // Auto-join invites from MATRIX_OWNER.
      const invites = resp.rooms?.invite ?? {}
      for (const roomId of Object.keys(invites)) {
        const inviteEvents: any[] = invites[roomId].invite_state?.events ?? []
        const fromOwner = inviteEvents.some(
          (e) =>
            e.type === 'm.room.member' &&
            e.state_key === cfg.user &&
            e.content?.membership === 'invite' &&
            e.sender === cfg.owner,
        )
        if (!fromOwner) {
          await log('warn', `ignoring invite room=${roomId} (not from owner)`)
          continue
        }
        try {
          await api('POST', `/rooms/${encodeURIComponent(roomId)}/join`, {}, 15_000)
          await log('info', `auto-joined room=${roomId}`)
        } catch (e: any) {
          await log('warn', `join-fail room=${roomId} err=${e.message}`)
        }
      }

      // Inbound msgs + ephemeral m.typing → owner-typing flag files.
      const joined = resp.rooms?.join ?? {}
      for (const roomId of Object.keys(joined)) {
        // Owner-typing state (statusLine reads this).
        const ephem: any[] = joined[roomId].ephemeral?.events ?? []
        for (const e of ephem) {
          if (e.type !== 'm.typing') continue
          const userIds: string[] = e.content?.user_ids ?? []
          const ownerTyping = userIds.includes(cfg.owner)
          await writeTypingFlag(roomId, ownerTyping)
        }
        // Inbound messages.
        const events: any[] = joined[roomId].timeline?.events ?? []
        for (const evt of events) {
          if (!evt.event_id) continue
          if (seen.has(evt.event_id)) continue
          seen.add(evt.event_id)
          seenOrder.push(evt.event_id)
          if (seenOrder.length > 256) {
            const dropped = seenOrder.shift()
            if (dropped) seen.delete(dropped)
          }
          if (evt.type !== 'm.room.message') continue
          if (evt.content?.msgtype !== 'm.text') continue
          if (evt.sender !== cfg.owner) continue
          await deliverInbound(roomId, evt)
        }
      }
    } catch (e: any) {
      if (e?.status === 401) {
        await log('error', '401 unauthorized — token invalid; halting')
        process.exit(1)
      }
      await log('warn', `sync-fail backoff=${backoff}ms err=${e?.message ?? e}`)
      await new Promise((r) => setTimeout(r, backoff))
      backoff = Math.min(backoff * 2, 60_000)
    }
  }
}

// ---------- pid file + lock ----------

async function tryClaimPid(): Promise<boolean> {
  try {
    const existing = (await fs.readFile(PID_FILE, 'utf8')).trim()
    if (existing) {
      const pid = Number(existing)
      if (pid > 0) {
        try {
          process.kill(pid, 0) // throws if dead
          // alive
          return false
        } catch {
          // dead, can claim
        }
      }
    }
  } catch {}
  await fs.mkdir(dirname(PID_FILE), { recursive: true })
  await fs.writeFile(PID_FILE, String(process.pid))
  // Advertise our version so a newer MCP server can detect a stale daemon
  // and SIGTERM it before connecting.
  await fs.writeFile(VERSION_FILE, DAEMON_VERSION)
  return true
}

async function releasePid(): Promise<void> {
  try {
    const existing = (await fs.readFile(PID_FILE, 'utf8')).trim()
    if (existing === String(process.pid)) {
      await fs.unlink(PID_FILE)
    }
  } catch {}
  try { await fs.unlink(SOCK_FILE) } catch {}
}

// ---------- main ----------

async function main(): Promise<void> {
  await loadConfigFile()
  cfg = buildConfig()
  await fs.mkdir(STATE_DIR, { recursive: true })

  if (!(await tryClaimPid())) {
    await log('warn', 'another daemon is alive, exiting')
    process.exit(0)
  }

  process.on('SIGTERM', () => { void releasePid().then(() => process.exit(0)) })
  process.on('SIGINT', () => { void releasePid().then(() => process.exit(0)) })

  const server = await startSocketServer()
  await log('info', `started homeserver=${cfg.homeserver} owner=${cfg.owner} sock=${SOCK_FILE}`)

  // Pre-warm the room-name cache so statusLine shows the friendly name
  // immediately, without waiting for the first inbound or list_rooms call.
  void (async () => {
    try {
      const joined = await api('GET', '/joined_rooms', undefined, 15_000)
      const ids: string[] = joined?.joined_rooms ?? []
      await Promise.all(ids.map((rid) => roomName(rid).catch(() => '')))
      await log('info', `prewarm room-names count=${ids.length}`)
    } catch (e: any) {
      await log('warn', `prewarm room-names err=${e?.message ?? e}`)
    }
  })()

  void syncLoop()

  // Keep process alive
  await new Promise(() => { /* never resolve */ void server })
}

main().catch((e) => {
  process.stderr.write(`fatal: ${e?.message ?? e}\n`)
  process.exit(1)
})
