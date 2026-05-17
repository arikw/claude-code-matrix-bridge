// rx-claude-matrix-bridge — daemon ↔ MCP socket protocol.
// Line-delimited JSON over AF_UNIX. Both directions.

// ---------- client → daemon ----------

export interface RegisterMsg {
  type: 'register'
  session_id: string
  cwd: string
}

export interface UnregisterMsg {
  type: 'unregister'
  session_id: string
}

export interface LinkChatMsg {
  type: 'link_chat'
  id: number
  session_id: string
  cwd: string
  room_id?: string
  name?: string
  topic?: string
}

export interface ReplyMsg {
  type: 'reply'
  id: number
  room_id: string
  text: string
}

export interface PingMsg {
  type: 'ping'
  id: number
}

export interface ListRoomsMsg {
  type: 'list_rooms'
  id: number
}

export interface LinkStatusMsg {
  type: 'link_status'
  id: number
  session_id: string
}

export interface UnlinkMsg {
  type: 'unlink'
  id: number
  session_id: string
}

export interface SessionStoppedMsg {
  type: 'session_stopped'
  session_id: string
}

export type ClientMessage =
  | RegisterMsg
  | UnregisterMsg
  | LinkChatMsg
  | ReplyMsg
  | PingMsg
  | ListRoomsMsg
  | LinkStatusMsg
  | UnlinkMsg
  | SessionStoppedMsg

// ---------- daemon → client ----------

export interface AckMsg {
  type: 'ack'
  id: number
  room_id?: string
  link?: { session_id: string; room_id: string; cwd: string; name: string; created_at: string } | null
}

export interface ErrMsg {
  type: 'err'
  id: number
  message: string
}

export interface InboundMsg {
  type: 'inbound'
  room_id: string
  room_name: string
  message_id: string
  sender: string
  body: string
  ts: string
}

export interface RegisteredMsg {
  type: 'registered'
  session_id: string
}

export interface RoomInfo {
  room_id: string
  name: string
  linked_session_id?: string
  linked_cwd?: string
}

export interface RoomsAckMsg {
  type: 'rooms_ack'
  id: number
  rooms: RoomInfo[]
}

export type DaemonMessage =
  | AckMsg
  | ErrMsg
  | InboundMsg
  | RegisteredMsg
  | RoomsAckMsg

// ---------- helpers ----------

export function encode(msg: ClientMessage | DaemonMessage): string {
  return JSON.stringify(msg) + '\n'
}

/** Buffer-aware decoder. Caller maintains a string buffer of bytes seen so
 * far; calls `decodeAll(buf)` which returns parsed messages and the leftover
 * (partial) suffix. */
export function decodeAll(buf: string): {
  messages: Array<ClientMessage | DaemonMessage>
  leftover: string
} {
  const out: Array<ClientMessage | DaemonMessage> = []
  let rest = buf
  while (true) {
    const i = rest.indexOf('\n')
    if (i < 0) break
    const line = rest.slice(0, i).trim()
    rest = rest.slice(i + 1)
    if (!line) continue
    try {
      out.push(JSON.parse(line))
    } catch {
      // skip malformed line
    }
  }
  return { messages: out, leftover: rest }
}
