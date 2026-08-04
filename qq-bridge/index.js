#!/usr/bin/env node
/**
 * sooya-qq-bridge — 把 QQ(经 NapCat / OneBot 11)接到 SOOYA 聊天主线的独立桥接进程。
 *
 * 数据流:
 *   QQ 消息  --WS-->  NapCat  --WS-->  本桥接  --HTTP-->  SOOYA /api/messages
 *   SOOYA 回复 <--SSE-- /api/stream  --HTTP-->  NapCat send_msg  --> QQ
 *
 * 零第三方依赖(Node>=22:内置 WebSocket 与 fetch),systemd 托管。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

/* ------------------------------- 配置 ------------------------------- */

const CFG = {
  sooyaBase: process.env.SOOYA_URL || 'http://127.0.0.1:8788',
  sooyaToken: process.env.SOOYA_TOKEN || '',
  napcatWs: process.env.NAPCAT_WS_URL || 'ws://127.0.0.1:3002',
  napcatToken: process.env.NAPCAT_ACCESS_TOKEN || '',
  /** NapCat 容器内可见的共享媒体目录(与容器 /app/bridge-media 对应)。 */
  mediaDirHost: process.env.MEDIA_DIR_HOST || '/opt/napcat/bridge-media',
  /** 容器内挂载点,send_msg 时 file:// 路径要用容器视角。 */
  mediaDirContainer: process.env.MEDIA_DIR_CONTAINER || '/app/bridge-media',
  /** 只响应这些 QQ 号(逗号分隔);空 = 所有人。 */
  allowUsers: (process.env.QQ_ALLOW_USERS || '').split(',').map((s) => s.trim()).filter(Boolean),
  /** 群聊里是否必须 @机器人 才响应。 */
  groupRequireAt: process.env.QQ_GROUP_REQUIRE_AT !== 'false',
  /** 群聊是否转发回复(私聊永远转发)。 */
  groupReply: process.env.QQ_GROUP_REPLY !== 'false',
  stateFile: process.env.STATE_FILE || '/opt/sooya-qq-bridge/state.json',
};

if (!CFG.sooyaToken) {
  console.error('[bridge] SOOYA_TOKEN 未配置,退出');
  process.exit(1);
}

const log = (...args) => console.log(new Date().toISOString(), '[bridge]', ...args);
const err = (...args) => console.error(new Date().toISOString(), '[bridge][err]', ...args);

/* ------------------------------ 状态持久化 ------------------------------ */

let state = { lastEventSeq: 0, lastSession: null, seenAssistant: {} };
try {
  state = { ...state, ...JSON.parse(fs.readFileSync(CFG.stateFile, 'utf8')) };
} catch { /* 首次运行 */ }

let stateTimer = null;
function saveState() {
  if (stateTimer) return;
  stateTimer = setTimeout(() => {
    stateTimer = null;
    try {
      // 只保留最近 500 条已转发助手消息记录,防无限膨胀
      const ids = Object.keys(state.seenAssistant);
      if (ids.length > 500) for (const id of ids.slice(0, ids.length - 500)) delete state.seenAssistant[id];
      fs.writeFileSync(CFG.stateFile, JSON.stringify(state));
    } catch (e) { err('状态保存失败', e.message); }
  }, 500);
}

/* ------------------------------ SOOYA HTTP 客户端 ------------------------------ */

async function sooyaFetch(pathname, init = {}) {
  const res = await fetch(CFG.sooyaBase + pathname, {
    ...init,
    headers: { 'x-sooya-token': CFG.sooyaToken, ...(init.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`SOOYA ${pathname} -> ${res.status} ${body.slice(0, 200)}`);
  }
  return res;
}

/** 上传媒体(QQ 图片/语音 -> SOOYA mediaId) */
async function uploadMedia(buffer, mime, kind) {
  const form = new FormData();
  form.append(kind === 'image' ? 'image' : 'file', new Blob([buffer], { type: mime }), `qq.${kind}`);
  const res = await sooyaFetch('/api/media', { method: 'POST', body: form });
  const json = await res.json();
  if (!json.media || !json.media.length) throw new Error(`媒体上传失败: ${JSON.stringify(json).slice(0, 200)}`);
  return json.media[0].id;
}

/** 发送用户消息到 SOOYA(异步接口,回复靠 SSE 事件取) */
async function sendToSooya(parts, clientMsgId) {
  const res = await sooyaFetch('/api/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientMsgId, content: parts }),
  });
  return res.json();
}

/** 下载 SOOYA 媒体(助手发的图/表情/语音) */
async function downloadMedia(mediaId) {
  const res = await sooyaFetch(`/api/media/${encodeURIComponent(mediaId)}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  const mime = res.headers.get('content-type') || 'application/octet-stream';
  return { buffer, mime };
}

/* ------------------------------ NapCat OneBot 11 客户端 ------------------------------ */

let ws = null;
let wsReady = false;
let echoSeq = 0;
const pending = new Map(); // echo -> { resolve, reject, timer }

function obCall(action, params, timeoutMs = 30_000) {
  return new Promise((resolve, reject) => {
    if (!wsReady || !ws) return reject(new Error('NapCat WS 未连接'));
    const echo = `bridge-${++echoSeq}`;
    const timer = setTimeout(() => { pending.delete(echo); reject(new Error(`OneBot ${action} 超时`)); }, timeoutMs);
    pending.set(echo, { resolve, reject, timer });
    ws.send(JSON.stringify({ action, params, echo }));
  });
}

async function sendQqSegments(session, segments) {
  if (!segments.length) return;
  const params = session.type === 'group'
    ? { group_id: Number(session.id), message: segments }
    : { user_id: Number(session.id), message: segments };
  try {
    await obCall('send_msg', params);
  } catch (e) {
    err('QQ 发送失败', e.message, JSON.stringify(segments).slice(0, 200));
  }
}

function connectNapCat() {
  const headers = CFG.napcatToken ? { Authorization: `Bearer ${CFG.napcatToken}` } : undefined;
  ws = new WebSocket(CFG.napcatWs, { headers });

  ws.addEventListener('open', () => {
    wsReady = true;
    log('NapCat WS 已连接', CFG.napcatWs);
  });

  ws.addEventListener('message', (ev) => {
    let data;
    try { data = JSON.parse(typeof ev.data === 'string' ? ev.data : Buffer.from(ev.data).toString('utf8')); }
    catch { return; }
    if (data.echo && pending.has(data.echo)) {
      const p = pending.get(data.echo);
      pending.delete(data.echo);
      clearTimeout(p.timer);
      if (data.status === 'ok' || data.retcode === 0) p.resolve(data.data);
      else p.reject(new Error(`OneBot retcode=${data.retcode} ${data.msg || data.wording || ''}`));
      return;
    }
    if (data.post_type === 'message') void handleQqMessage(data).catch((e) => err('处理 QQ 消息失败', e.message));
    else if (data.post_type === 'meta_event' && data.sub_type === 'lifecycle') log('NapCat 生命周期:', data.connect_id ? '已连接' : data.sub_type);
  });

  const scheduleReconnect = () => {
    wsReady = false;
    for (const [echo, p] of pending) { clearTimeout(p.timer); p.reject(new Error('WS 断开')); pending.delete(echo); }
    setTimeout(connectNapCat, 3000);
  };
  ws.addEventListener('close', () => { log('NapCat WS 断开,3s 后重连'); scheduleReconnect(); });
  ws.addEventListener('error', (e) => err('NapCat WS 错误', e.message || ''));
}

/* ------------------------------ QQ -> SOOYA ------------------------------ */

async function handleQqMessage(data) {
  const isGroup = data.message_type === 'group';
  const senderId = String(data.user_id);
  const session = isGroup ? { type: 'group', id: String(data.group_id) } : { type: 'private', id: senderId };

  // 白名单
  if (CFG.allowUsers.length && !CFG.allowUsers.includes(senderId)) return;
  // 不响应机器人自己
  if (data.self_id && data.user_id === data.self_id) return;

  // 群聊:必须 @机器人(可通过配置关闭)
  let text = '';
  let atBot = false;
  const imageUrls = [];
  const voiceUrls = [];
  for (const seg of data.message || []) {
    if (seg.type === 'text') text += seg.data?.text || '';
    else if (seg.type === 'at') {
      if (String(seg.data?.qq) === String(data.self_id)) atBot = true;
    } else if (seg.type === 'image' && seg.data?.url) imageUrls.push(seg.data.url);
    else if (seg.type === 'record' && seg.data?.url) voiceUrls.push(seg.data.url);
  }
  if (isGroup && CFG.groupRequireAt && !atBot) return;
  text = text.replace(/\s*@我\s*/g, '').trim();

  if (!text && !imageUrls.length && !voiceUrls.length) return;

  state.lastSession = session;
  saveState();
  log(`QQ 来信 ${session.type}/${session.id} 来自${senderId}: ${text.slice(0, 60)}${imageUrls.length ? ` [+${imageUrls.length}图]` : ''}${voiceUrls.length ? ` [+${voiceUrls.length}语音]` : ''}`);

  const parts = [];
  try {
    for (const url of imageUrls) {
      const img = await fetch(url);
      if (!img.ok) { err('QQ 图片下载失败', url, img.status); continue; }
      const mediaId = await uploadMedia(Buffer.from(await img.arrayBuffer()), img.headers.get('content-type') || 'image/jpeg', 'image');
      parts.push({ type: 'image', mediaId });
    }
    for (const url of voiceUrls) {
      const rec = await fetch(url);
      if (!rec.ok) { err('QQ 语音下载失败', url, rec.status); continue; }
      const mediaId = await uploadMedia(Buffer.from(await rec.arrayBuffer()), rec.headers.get('content-type') || 'audio/amr', 'audio');
      parts.push({ type: 'audio', mediaId });
    }
    if (text) parts.push({ type: 'text', text });
    if (!parts.length) return;

    // clientMsgId 用 QQ 消息 id,天然去重(重启重放也不重复入库)
    const result = await sendToSooya(parts, `qq-${data.message_id}`);
    if (result.duplicate) log('SOOYA 判定重复消息,忽略:', `qq-${data.message_id}`);
  } catch (e) {
    err('转发到 SOOYA 失败:', e.message);
  }
}

/* ------------------------------ SOOYA -> QQ ------------------------------ */

const EXT_BY_MIME = {
  'image/jpeg': '.jpg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp',
  'audio/mpeg': '.mp3', 'audio/ogg': '.ogg', 'audio/amr': '.amr', 'audio/mp4': '.m4a', 'audio/wav': '.wav', 'audio/silk': '.silk',
};

/** 把一条助手消息拆成 QQ 消息段并发出 */
async function deliverAssistant(message, session) {
  if (state.seenAssistant[message.id]) return; // 已转发(重连重放保护)
  const segments = [];
  const textChunks = [];

  for (const part of message.content || []) {
    if (part.type === 'text' && part.text) {
      textChunks.push(part.text);
    } else if ((part.type === 'sticker' || part.type === 'image') && part.mediaId) {
      try {
        const { buffer, mime } = await downloadMedia(part.mediaId);
        const file = path.join(CFG.mediaDirHost, `${part.mediaId}${EXT_BY_MIME[mime] || '.bin'}`);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, buffer);
        // NapCat 容器内视角的本地文件路径
        segments.push({ type: 'image', data: { file: `file://${file.replace(CFG.mediaDirHost, CFG.mediaDirContainer)}` } });
      } catch (e) { err('下载 SOOYA 媒体失败', part.mediaId, e.message); }
    } else if (part.type === 'audio' && part.mediaId) {
      // QQ 语音要求 silk 编码,直接发 mp3 大概率失败;有转写文本就发文本,否则发文件
      if (part.transcript) textChunks.push(part.transcript);
      else {
        try {
          const { buffer, mime } = await downloadMedia(part.mediaId);
          const file = path.join(CFG.mediaDirHost, `${part.mediaId}${EXT_BY_MIME[mime] || '.bin'}`);
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, buffer);
          segments.push({ type: 'file', data: { file: `file://${file.replace(CFG.mediaDirHost, CFG.mediaDirContainer)}` } });
        } catch (e) { err('下载语音失败', part.mediaId, e.message); }
      }
    }
  }

  // 先发文本(单条),再逐个发媒体
  const text = textChunks.join('\n').trim();
  if (text) await sendQqSegments(session, [{ type: 'text', data: { text } }]);
  for (const seg of segments) await sendQqSegments(session, [seg]);

  if (text || segments.length) {
    state.seenAssistant[message.id] = Date.now();
    saveState();
    log(`已转发助手消息 ${message.id} -> ${session.type}/${session.id}(文${text ? '有' : '无'} 媒体${segments.length})`);
  }
}

/** 事件携带完整 message 时直接转发;只带 id 时走 REST 拉全量 */
async function handleAssistantEvent(payload) {
  const message = payload?.message;
  if (!message || message.role !== 'assistant') return;
  const session = state.lastSession;
  if (!session) { log('收到助手消息但没有 QQ 会话上下文,跳过', message.id); return; }
  let full = message;
  if (!Array.isArray(full.content)) {
    try { full = (await (await sooyaFetch(`/api/messages/${encodeURIComponent(message.id)}`)).json()).message; }
    catch (e) { err('拉取助手消息失败', message.id, e.message); return; }
  }
  await deliverAssistant(full, session);
}

/* ------------------------------ SSE 订阅 ------------------------------ */

async function streamLoop() {
  // 首次运行(lastEventSeq 从未记录过)时,从当前位置开始,避免把历史消息全量重放到 QQ
  if (state.lastEventSeq === 0 && !state.seqInitialized) {
    try {
      const json = await (await sooyaFetch('/api/conversation')).json();
      state.lastEventSeq = json.lastEventSeq ?? 0;
      state.seqInitialized = true;
      saveState();
      log('SSE 起点初始化为当前事件 seq:', state.lastEventSeq);
    } catch (e) {
      err('初始化 SSE 起点失败,稍后重试:', e.message);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  let backoff = 1000;
  for (;;) {
    try {
      const url = `${CFG.sooyaBase}/api/stream?lastEventId=${state.lastEventSeq}`;
      const res = await fetch(url, { headers: { 'x-sooya-token': CFG.sooyaToken, accept: 'text/event-stream' } });
      if (!res.ok || !res.body) throw new Error(`SSE ${res.status}`);
      backoff = 1000;
      log('SOOYA SSE 已连接, 从 seq', state.lastEventSeq, '续传');

      let buffer = '';
      const decoder = new TextDecoder();
      for await (const chunk of res.body) {
        buffer += decoder.decode(chunk, { stream: true });
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const block = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          void handleSseBlock(block).catch((e) => err('SSE 事件处理失败', e.message));
        }
      }
      throw new Error('SSE 流结束');
    } catch (e) {
      err('SSE 断开:', e.message, `${backoff / 1000}s 后重连`);
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 30_000);
    }
  }
}

async function handleSseBlock(block) {
  let eventType = 'message';
  let dataRaw = '';
  let seq = null;
  for (const line of block.split('\n')) {
    if (line.startsWith('event: ')) eventType = line.slice(7).trim();
    else if (line.startsWith('data: ')) dataRaw += line.slice(6);
    else if (line.startsWith('id: ')) seq = Number(line.slice(4));
  }
  if (seq !== null && Number.isFinite(seq)) {
    state.lastEventSeq = seq;
    saveState();
  }
  if (!dataRaw) return;
  let data;
  try { data = JSON.parse(dataRaw); } catch { return; }

  if (eventType === 'reply.completed') {
    await handleAssistantEvent(data);
  } else if (eventType === 'message.received') {
    // 网页/其他入口产生的助手消息(如主动关怀)也要推到 QQ
    if (data?.message?.role === 'assistant') await handleAssistantEvent(data);
  }
}

/* ------------------------------ 启动 ------------------------------ */

process.on('SIGTERM', () => { saveState(); setTimeout(() => process.exit(0), 600); });
process.on('SIGINT', () => { saveState(); setTimeout(() => process.exit(0), 600); });

(async () => {
  log('sooya-qq-bridge 启动', JSON.stringify({
    sooyaBase: CFG.sooyaBase, napcatWs: CFG.napcatWs,
    allowUsers: CFG.allowUsers.length ? CFG.allowUsers : '(不限)',
    groupRequireAt: CFG.groupRequireAt, groupReply: CFG.groupReply,
  }));
  fs.mkdirSync(CFG.mediaDirHost, { recursive: true });
  connectNapCat();
  // 定期清理超过 3 天的桥接媒体文件
  setInterval(() => {
    try {
      for (const f of fs.readdirSync(CFG.mediaDirHost)) {
        const p = path.join(CFG.mediaDirHost, f);
        if (Date.now() - fs.statSync(p).mtimeMs > 3 * 86400_000) fs.unlinkSync(p);
      }
    } catch { /* ignore */ }
  }, 6 * 3600_000).unref();
  await streamLoop();
})();
