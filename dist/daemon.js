#!/usr/bin/env -S npx --yes tsx
import { createRequire as __mxCreateRequire } from 'node:module';
const require = __mxCreateRequire(import.meta.url);


// daemon.ts
import { spawn } from "node:child_process";
import { promises as fs, readFileSync } from "node:fs";
import * as net from "node:net";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// protocol.ts
function encode(msg) {
  return JSON.stringify(msg) + "\n";
}
function decodeAll(buf) {
  const out = [];
  let rest = buf;
  while (true) {
    const i = rest.indexOf("\n");
    if (i < 0) break;
    const line = rest.slice(0, i).trim();
    rest = rest.slice(i + 1);
    if (!line) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
    }
  }
  return { messages: out, leftover: rest };
}

// daemon.ts
var STATE_DIR = join(
  process.env.MX_STATE_DIR ?? join(process.env.XDG_STATE_HOME ?? join(homedir(), ".claude"), "channels", "rx-claude-matrix-bridge")
);
var SINCE_FILE = join(STATE_DIR, "since-token");
var LINKS_FILE = join(STATE_DIR, "links.tsv");
var LOG_FILE = join(STATE_DIR, "daemon.log");
var PID_FILE = join(STATE_DIR, "daemon.pid");
var VERSION_FILE = join(STATE_DIR, "daemon.version");
var SOCK_FILE = join(STATE_DIR, "daemon.sock");
var DAEMON_VERSION = readOwnVersion();
function readOwnVersion() {
  let d = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(readFileSync(join(d, "package.json"), "utf8"));
      if (pkg?.name === "rx-claude-matrix-bridge") return String(pkg.version || "0.0.0");
    } catch {
    }
    const parent = dirname(d);
    if (parent === d) break;
    d = parent;
  }
  return "0.0.0";
}
var TYPING_DIR = join(STATE_DIR, "typing");
var LAST_PROMPT_DIR = join(STATE_DIR, "last-tui-prompt");
var LAST_MATRIX_DIR = join(STATE_DIR, "last-matrix-msg");
var ROOM_NAMES_DIR = join(STATE_DIR, "room-names");
function sanitizeRoomId(rid) {
  return rid.replace(/[^A-Za-z0-9_-]/g, "_");
}
async function writeTypingFlag(roomId, on) {
  const file = join(TYPING_DIR, sanitizeRoomId(roomId));
  try {
    if (on) {
      await fs.mkdir(TYPING_DIR, { recursive: true });
      await fs.writeFile(file, "1");
    } else {
      await fs.unlink(file).catch(() => {
      });
    }
  } catch {
  }
}
async function readLastTuiPrompt(sid) {
  try {
    const t = (await fs.readFile(join(LAST_PROMPT_DIR, sid), "utf8")).trim();
    return t || void 0;
  } catch {
    return void 0;
  }
}
async function readLastMatrixMsg(sid) {
  try {
    const t = (await fs.readFile(join(LAST_MATRIX_DIR, sid), "utf8")).trim();
    return t || void 0;
  } catch {
    return void 0;
  }
}
async function writeLastMatrixMsg(sid, iso) {
  try {
    await fs.mkdir(LAST_MATRIX_DIR, { recursive: true });
    await fs.writeFile(join(LAST_MATRIX_DIR, sid), iso);
  } catch {
  }
}
var cfg;
async function loadConfigFile() {
  const path = process.env.MX_CONFIG_FILE ?? join(
    process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
    "rx-claude-matrix-bridge",
    "config.env"
  );
  let contents;
  try {
    contents = await fs.readFile(path, "utf8");
  } catch {
    return;
  }
  for (const line of contents.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && process.env[m[1]] === void 0) {
      process.env[m[1]] = m[2];
    }
  }
}
function buildConfig() {
  const req = (k) => {
    const v = process.env[k];
    if (!v) throw new Error(`${k} unset`);
    return v;
  };
  return {
    homeserver: req("MATRIX_HOMESERVER").replace(/\/$/, ""),
    user: req("MATRIX_USER_ID"),
    token: req("MATRIX_ACCESS_TOKEN"),
    owner: req("MATRIX_OWNER")
  };
}
async function log(level, msg) {
  const line = JSON.stringify({ ts: (/* @__PURE__ */ new Date()).toISOString(), level, msg }) + "\n";
  process.stderr.write(line);
  try {
    await fs.appendFile(LOG_FILE, line);
  } catch {
  }
}
async function api(method, path, body, timeoutMs = 6e4) {
  const url = `${cfg.homeserver}/_matrix/client/v3${path}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${cfg.token}`,
        ...body !== void 0 ? { "Content-Type": "application/json" } : {}
      },
      body: body !== void 0 ? JSON.stringify(body) : void 0,
      signal: ctrl.signal
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      const err = new Error(`HTTP ${resp.status}: ${text.slice(0, 200)}`);
      err.status = resp.status;
      throw err;
    }
    return await resp.json();
  } finally {
    clearTimeout(t);
  }
}
var txnCounter = 0;
function txnId() {
  return `mxbr-${Date.now()}-${process.pid}-${++txnCounter}`;
}
function redactControls(s) {
  return s.replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}
function truncate(s, max = 16384) {
  return s.length <= max ? s : s.slice(0, max - 16) + "\u2026 (truncated)";
}
async function sinceRead() {
  try {
    const t = (await fs.readFile(SINCE_FILE, "utf8")).trim();
    return t || void 0;
  } catch {
    return void 0;
  }
}
async function sinceWrite(token) {
  const tmp = SINCE_FILE + ".tmp";
  await fs.writeFile(tmp, token);
  await fs.rename(tmp, SINCE_FILE);
}
async function roomName(roomId) {
  try {
    const r = await api("GET", `/rooms/${encodeURIComponent(roomId)}/state/m.room.name`, void 0, 1e4);
    const name = String(r?.name ?? "");
    if (name) {
      const cacheFile = join(ROOM_NAMES_DIR, sanitizeRoomId(roomId));
      try {
        await fs.mkdir(ROOM_NAMES_DIR, { recursive: true });
        await fs.writeFile(cacheFile, name);
      } catch {
      }
    }
    return name;
  } catch {
    return "";
  }
}
async function postRoom(roomId, body) {
  const safe = truncate(redactControls(body));
  if (!safe) return;
  await stopTyping(roomId, "reply");
  const txn = txnId();
  await api(
    "PUT",
    `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txn)}`,
    { msgtype: "m.text", body: safe },
    3e4
  );
}
var TYPING_DEBOUNCE_MS = 2e3;
var typingState = /* @__PURE__ */ new Map();
async function pingTyping(roomId, on) {
  try {
    await api(
      "PUT",
      `/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(cfg.user)}`,
      on ? { typing: true, timeout: 3e4 } : { typing: false },
      1e4
    );
  } catch (e) {
    await log("warn", `typing room=${roomId} on=${on} err=${e?.message ?? e}`);
  }
}
function startTyping(roomId) {
  if (typingState.has(roomId)) return;
  const pending = setTimeout(() => {
    const st = typingState.get(roomId);
    if (!st) return;
    st.pending = void 0;
    void pingTyping(roomId, true);
    st.interval = setInterval(() => void pingTyping(roomId, true), 2e4);
    st.autoStop = setTimeout(() => void stopTyping(roomId, "auto-stop-5min"), 3e5);
  }, TYPING_DEBOUNCE_MS);
  typingState.set(roomId, { pending });
}
async function stopTyping(roomId, reason = "reply") {
  const st = typingState.get(roomId);
  if (!st) return;
  const wasActive = st.interval !== void 0;
  if (st.pending) clearTimeout(st.pending);
  if (st.interval) clearInterval(st.interval);
  if (st.autoStop) clearTimeout(st.autoStop);
  typingState.delete(roomId);
  if (wasActive) await pingTyping(roomId, false);
  await log("info", `typing-stop room=${roomId} reason=${reason} sent=${wasActive}`);
}
async function linksRead() {
  try {
    const text = await fs.readFile(LINKS_FILE, "utf8");
    return text.split("\n").filter((l) => l.trim()).map((l) => {
      const [session_id, room_id, cwd, name, created_at] = l.split("	");
      return { session_id, room_id, cwd, name, created_at };
    });
  } catch {
    return [];
  }
}
async function linksWrite(links) {
  const text = links.map((l) => `${l.session_id}	${l.room_id}	${l.cwd}	${l.name}	${l.created_at}`).join("\n") + (links.length ? "\n" : "");
  const tmp = LINKS_FILE + ".tmp";
  await fs.writeFile(tmp, text);
  await fs.rename(tmp, LINKS_FILE);
}
async function linksAddOrUpdate(link) {
  const all = await linksRead();
  const filtered = all.filter((l) => l.session_id !== link.session_id && l.room_id !== link.room_id);
  filtered.push(link);
  await linksWrite(filtered);
}
async function linkBySession(session_id) {
  return (await linksRead()).find((l) => l.session_id === session_id);
}
async function linkByRoom(room_id) {
  return (await linksRead()).find((l) => l.room_id === room_id);
}
async function linksRemoveSession(session_id) {
  const all = await linksRead();
  const filtered = all.filter((l) => l.session_id !== session_id);
  if (filtered.length === all.length) return false;
  await linksWrite(filtered);
  return true;
}
var registered = /* @__PURE__ */ new Map();
function regsFor(session_id) {
  let s = registered.get(session_id);
  if (!s) {
    s = /* @__PURE__ */ new Set();
    registered.set(session_id, s);
  }
  return s;
}
function regCount() {
  let n = 0;
  for (const s of registered.values()) n += s.size;
  return n;
}
function send(socket, msg) {
  try {
    socket.write(encode(msg));
  } catch {
  }
}
function broadcastToSession(session_id, msg) {
  const s = registered.get(session_id);
  if (!s || s.size === 0) return false;
  for (const reg of s) send(reg.socket, msg);
  return true;
}
async function deliverInbound(roomId, evt) {
  let body = redactControls(String(evt.content?.body ?? ""));
  await log("debug", `DBG inbound recv room=${roomId} evt=${evt.event_id} sender=${evt.sender} bytes=${body.length} registered=[${[...registered.keys()].map((k) => `${k}:${registered.get(k)?.size ?? 0}`).join(",")}]`);
  if (!body) {
    await log("debug", `DBG inbound drop room=${roomId} evt=${evt.event_id} (empty body)`);
    return;
  }
  const name = await roomName(roomId);
  const evtIso = new Date(Number(evt.origin_server_ts) || Date.now()).toISOString();
  const link = await linkByRoom(roomId);
  await log("debug", `DBG inbound link room=${roomId} evt=${evt.event_id} link=${link ? `sid=${link.session_id}` : "NONE"}`);
  if (link) {
    startTyping(roomId);
    const sid = link.session_id;
    const lastTui = await readLastTuiPrompt(sid);
    const prevMatrix = await readLastMatrixMsg(sid);
    const switched = lastTui && (!prevMatrix || Date.parse(lastTui) > Date.parse(prevMatrix));
    if (switched) {
      const sinceLabel = prevMatrix ?? "the start of this session";
      body = `[matrix-bridge recap-since ${sinceLabel}] The user was active on the TUI since their last matrix message at ${sinceLabel}. Before answering:
1. Give a brief 3-6 bullet recap of TUI activity since that time using your existing session context.
2. Classify the user's incoming message below: substantive request, OR presence-only ping (short greetings like "hi", "back", "I'm here", "ping", "you there", "what's up", etc.).
3. If presence-only ping: reply with ONLY the recap plus one final line stating whether your attention is required (a pending question to answer, a decision to confirm, an error to react to) or whether they can resume what they were doing. Do NOT invent follow-up questions; do NOT ask "what would you like next?".
4. If substantive: give the recap, then handle the request normally.

${body}`;
      await log("info", `recap-since tui\u2192matrix sid=${sid} prevMatrix=${prevMatrix ?? "(none)"} lastTui=${lastTui}`);
    }
    await writeLastMatrixMsg(sid, evtIso);
    const inbound2 = {
      type: "inbound",
      room_id: roomId,
      room_name: name,
      message_id: evt.event_id,
      sender: evt.sender,
      body,
      ts: evtIso
    };
    const regs = registered.get(sid);
    await log("debug", `DBG inbound broadcast sid=${sid} sockets=${regs?.size ?? 0}`);
    if (regs && regs.size > 0) {
      const encoded = encode(inbound2);
      let i = 0;
      for (const reg of regs) {
        i++;
        const writable = reg.socket.writable;
        const destroyed = reg.socket.destroyed;
        try {
          const ok = reg.socket.write(encoded);
          await log("debug", `DBG inbound socket-write sid=${sid} sock#${i} writable=${writable} destroyed=${destroyed} write-ok=${ok} bytes=${encoded.length}`);
        } catch (e) {
          await log("warn", `DBG inbound socket-write sid=${sid} sock#${i} ERR ${e?.message ?? e}`);
        }
      }
      await log("info", `inbound\u2192tui room=${roomId} sid=${sid} evt=${evt.event_id}`);
      return;
    }
    await log("debug", `DBG inbound no-socket sid=${sid} \u2192 headless`);
    void runHeadless(link, body, roomId);
    return;
  }
  const inbound = {
    type: "inbound",
    room_id: roomId,
    room_name: name,
    message_id: evt.event_id,
    sender: evt.sender,
    body,
    ts: new Date(Number(evt.origin_server_ts) || Date.now()).toISOString()
  };
  if (registered.size === 1) {
    const [session_id] = registered.keys();
    startTyping(roomId);
    broadcastToSession(session_id, inbound);
    await log("info", `inbound\u2192tui room=${roomId} sid=${session_id} (orphan\u2192sole)`);
    return;
  }
  await log("warn", `inbound dropped room=${roomId} (orphan, ${regCount()} sockets across ${registered.size} sessions)`);
}
async function runHeadless(link, msg, roomId) {
  await log("info", `headless room=${roomId} sid=${link.session_id} cwd=${link.cwd}`);
  const args = [
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
    "--resume",
    link.session_id,
    "--add-dir",
    link.cwd,
    "--",
    msg
  ];
  const env = { ...process.env };
  if (env.MX_CLAUDE_PERMISSION_MODE) {
    args.splice(args.length - 2, 0, "--permission-mode", env.MX_CLAUDE_PERMISSION_MODE);
  }
  const child = spawn("claude", args, {
    cwd: link.cwd,
    env,
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => {
    stdout += d.toString();
  });
  child.stderr.on("data", (d) => {
    stderr += d.toString();
  });
  child.on("close", async (code) => {
    if (code !== 0) {
      await log("error", `headless rc=${code} room=${roomId} stderr=${stderr.slice(0, 500)}`);
      try {
        await postRoom(roomId, `[bridge] claude exited rc=${code}`);
      } catch {
      }
      return;
    }
    const lines = stdout.split("\n").filter((l) => l.trim());
    let reply = "";
    for (const line of lines) {
      try {
        const evt = JSON.parse(line);
        if (evt.type === "assistant") {
          for (const c of evt.message?.content ?? []) {
            if (c.type === "text" && c.text) {
              reply += (reply ? "\n\n" : "") + c.text;
            }
          }
        }
      } catch {
      }
    }
    if (!reply) {
      for (const line of lines) {
        try {
          const evt = JSON.parse(line);
          if (evt.type === "result" && evt.result) {
            reply = String(evt.result);
            break;
          }
        } catch {
        }
      }
    }
    if (!reply) reply = "[bridge] (no assistant text in response)";
    try {
      await postRoom(roomId, reply);
      await log("info", `headless reply room=${roomId} bytes=${reply.length}`);
    } catch (e) {
      await log("error", `headless post-fail room=${roomId} err=${e?.message ?? e}`);
    }
  });
}
async function handleMessage(socket, msg) {
  switch (msg.type) {
    case "register": {
      const reg = { session_id: msg.session_id, cwd: msg.cwd, socket };
      regsFor(msg.session_id).add(reg);
      send(socket, { type: "registered", session_id: msg.session_id });
      await log("info", `register sid=${msg.session_id} cwd=${msg.cwd} (${regCount()} sockets across ${registered.size} sessions)`);
      return;
    }
    case "unregister": {
      const set = registered.get(msg.session_id);
      if (set) {
        for (const reg of set) {
          if (reg.socket === socket) set.delete(reg);
        }
        if (set.size === 0) registered.delete(msg.session_id);
      }
      await log("info", `unregister sid=${msg.session_id} (${regCount()} sockets)`);
      return;
    }
    case "reply": {
      try {
        await postRoom(msg.room_id, msg.text);
        send(socket, { type: "ack", id: msg.id });
        await log("info", `reply room=${msg.room_id} bytes=${msg.text.length}`);
      } catch (e) {
        send(socket, { type: "err", id: msg.id, message: e?.message ?? String(e) });
      }
      return;
    }
    case "link_chat": {
      try {
        let room_id = msg.room_id;
        let name = msg.name ?? "";
        if (!room_id) {
          name = name || msg.cwd.split("/").filter(Boolean).pop() || "session";
          const payload = {
            name: `[claude] ${name}`,
            topic: msg.topic ?? `Claude session ${msg.session_id} \xB7 cwd=${msg.cwd}`,
            invite: [cfg.owner],
            preset: process.env.MX_ROOM_PRESET ?? "trusted_private_chat",
            is_direct: true
          };
          const resp = await api("POST", "/createRoom", payload, 3e4);
          room_id = String(resp.room_id);
          await log("info", `created room=${room_id} for sid=${msg.session_id}`);
        } else {
          try {
            await api("POST", `/rooms/${encodeURIComponent(room_id)}/join`, {}, 15e3);
            await log("info", `joined room=${room_id} for sid=${msg.session_id}`);
          } catch (e) {
            await log("info", `join room=${room_id} (probably already joined): ${e?.message}`);
          }
        }
        await linksAddOrUpdate({
          session_id: msg.session_id,
          room_id,
          cwd: msg.cwd,
          name: name || "",
          created_at: (/* @__PURE__ */ new Date()).toISOString()
        });
        send(socket, { type: "ack", id: msg.id, room_id });
      } catch (e) {
        send(socket, { type: "err", id: msg.id, message: e?.message ?? String(e) });
      }
      return;
    }
    case "ping": {
      send(socket, { type: "ack", id: msg.id });
      return;
    }
    case "link_status": {
      try {
        const link = await linkBySession(msg.session_id);
        send(socket, { type: "ack", id: msg.id, link: link ?? null });
      } catch (e) {
        send(socket, { type: "err", id: msg.id, message: e?.message ?? String(e) });
      }
      return;
    }
    case "unlink": {
      try {
        const removed = await linksRemoveSession(msg.session_id);
        await log("info", `unlink sid=${msg.session_id} removed=${removed}`);
        send(socket, { type: "ack", id: msg.id });
      } catch (e) {
        send(socket, { type: "err", id: msg.id, message: e?.message ?? String(e) });
      }
      return;
    }
    case "session_stopped": {
      try {
        const link = await linkBySession(msg.session_id);
        if (link) {
          await stopTyping(link.room_id, "session-stopped");
        }
      } catch {
      }
      return;
    }
    case "list_rooms": {
      try {
        const joined = await api("GET", "/joined_rooms", void 0, 15e3);
        const roomIds = joined?.joined_rooms ?? [];
        const links = await linksRead();
        const rooms = await Promise.all(
          roomIds.map(async (room_id) => {
            const link = links.find((l) => l.room_id === room_id);
            const name = await roomName(room_id);
            return {
              room_id,
              name,
              linked_session_id: link?.session_id,
              linked_cwd: link?.cwd
            };
          })
        );
        send(socket, { type: "rooms_ack", id: msg.id, rooms });
      } catch (e) {
        send(socket, { type: "err", id: msg.id, message: e?.message ?? String(e) });
      }
      return;
    }
  }
}
async function startSocketServer() {
  try {
    await fs.unlink(SOCK_FILE);
  } catch {
  }
  const server = net.createServer((socket) => {
    let buf = "";
    let session_id_for_socket = null;
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const { messages, leftover } = decodeAll(buf);
      buf = leftover;
      for (const m of messages) {
        if (m.type === "register") session_id_for_socket = m.session_id;
        void handleMessage(socket, m);
      }
    });
    socket.on("close", () => {
      if (session_id_for_socket) {
        const set = registered.get(session_id_for_socket);
        if (set) {
          for (const reg of set) {
            if (reg.socket === socket) set.delete(reg);
          }
          if (set.size === 0) registered.delete(session_id_for_socket);
        }
        void log("info", `disconnect sid=${session_id_for_socket} (${regCount()} sockets across ${registered.size} sessions)`);
      }
    });
    socket.on("error", () => {
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(SOCK_FILE, () => resolve());
  });
  await fs.chmod(SOCK_FILE, 448).catch(() => {
  });
  return server;
}
async function syncLoop() {
  let since = await sinceRead();
  const seen = /* @__PURE__ */ new Set();
  const seenOrder = [];
  let backoff = 5e3;
  while (true) {
    try {
      const url = since ? `/sync?timeout=30000&since=${encodeURIComponent(since)}` : `/sync?timeout=30000`;
      const resp = await api("GET", url, void 0, 6e4);
      backoff = 5e3;
      const next = resp.next_batch;
      if (next) {
        await sinceWrite(next);
        since = next;
      }
      const invites = resp.rooms?.invite ?? {};
      for (const roomId of Object.keys(invites)) {
        const inviteEvents = invites[roomId].invite_state?.events ?? [];
        const fromOwner = inviteEvents.some(
          (e) => e.type === "m.room.member" && e.state_key === cfg.user && e.content?.membership === "invite" && e.sender === cfg.owner
        );
        if (!fromOwner) {
          await log("warn", `ignoring invite room=${roomId} (not from owner)`);
          continue;
        }
        try {
          await api("POST", `/rooms/${encodeURIComponent(roomId)}/join`, {}, 15e3);
          await log("info", `auto-joined room=${roomId}`);
        } catch (e) {
          await log("warn", `join-fail room=${roomId} err=${e.message}`);
        }
      }
      const joined = resp.rooms?.join ?? {};
      for (const roomId of Object.keys(joined)) {
        const ephem = joined[roomId].ephemeral?.events ?? [];
        for (const e of ephem) {
          if (e.type !== "m.typing") continue;
          const userIds = e.content?.user_ids ?? [];
          const ownerTyping = userIds.includes(cfg.owner);
          await writeTypingFlag(roomId, ownerTyping);
        }
        const events = joined[roomId].timeline?.events ?? [];
        for (const evt of events) {
          if (!evt.event_id) continue;
          if (seen.has(evt.event_id)) continue;
          seen.add(evt.event_id);
          seenOrder.push(evt.event_id);
          if (seenOrder.length > 256) {
            const dropped = seenOrder.shift();
            if (dropped) seen.delete(dropped);
          }
          if (evt.type !== "m.room.message") continue;
          if (evt.content?.msgtype !== "m.text") continue;
          if (evt.sender !== cfg.owner) continue;
          await deliverInbound(roomId, evt);
        }
      }
    } catch (e) {
      if (e?.status === 401) {
        await log("error", "401 unauthorized \u2014 token invalid; halting");
        process.exit(1);
      }
      await log("warn", `sync-fail backoff=${backoff}ms err=${e?.message ?? e}`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 6e4);
    }
  }
}
async function tryClaimPid() {
  try {
    const existing = (await fs.readFile(PID_FILE, "utf8")).trim();
    if (existing) {
      const pid = Number(existing);
      if (pid > 0) {
        try {
          process.kill(pid, 0);
          return false;
        } catch {
        }
      }
    }
  } catch {
  }
  await fs.mkdir(dirname(PID_FILE), { recursive: true });
  await fs.writeFile(PID_FILE, String(process.pid));
  await fs.writeFile(VERSION_FILE, DAEMON_VERSION);
  return true;
}
async function releasePid() {
  try {
    const existing = (await fs.readFile(PID_FILE, "utf8")).trim();
    if (existing === String(process.pid)) {
      await fs.unlink(PID_FILE);
    }
  } catch {
  }
  try {
    await fs.unlink(SOCK_FILE);
  } catch {
  }
}
async function main() {
  await loadConfigFile();
  cfg = buildConfig();
  await fs.mkdir(STATE_DIR, { recursive: true });
  if (!await tryClaimPid()) {
    await log("warn", "another daemon is alive, exiting");
    process.exit(0);
  }
  process.on("SIGTERM", () => {
    void releasePid().then(() => process.exit(0));
  });
  process.on("SIGINT", () => {
    void releasePid().then(() => process.exit(0));
  });
  const server = await startSocketServer();
  await log("info", `started homeserver=${cfg.homeserver} owner=${cfg.owner} sock=${SOCK_FILE}`);
  void (async () => {
    try {
      const joined = await api("GET", "/joined_rooms", void 0, 15e3);
      const ids = joined?.joined_rooms ?? [];
      await Promise.all(ids.map((rid) => roomName(rid).catch(() => "")));
      await log("info", `prewarm room-names count=${ids.length}`);
    } catch (e) {
      await log("warn", `prewarm room-names err=${e?.message ?? e}`);
    }
  })();
  void syncLoop();
  await new Promise(() => {
    void server;
  });
}
main().catch((e) => {
  process.stderr.write(`fatal: ${e?.message ?? e}
`);
  process.exit(1);
});
