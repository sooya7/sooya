# SOOYA 数据库结构说明

单文件 SQLite，位于 `$DATA_DIR/database/sooya.db`。

```
data/
├── database/
│   ├── sooya.db          主库
│   ├── sooya.db-wal      WAL
│   └── sooya.db-shm      共享内存索引
├── media/
│   ├── images/           上传与生成的图片
│   ├── audio/            用户语音与 TTS 音频
│   ├── stickers/         表情包
│   ├── files/            其他文件
│   └── tmp/              原子写入的临时文件（定期清理）
├── backups/              自动与手动备份 + .sha256 + .json 清单
└── logs/                 app.log / error.log
```

**媒体文件不以 Base64 存进 SQLite。** `media` 表只保存相对路径和元数据，
字节存在磁盘上。这一点有测试断言（`media` 表不存在 `data` / `base64` 字段，
且路径字段总长远小于文件字节总量）。

---

## 连接参数

打开连接后立即执行：

| PRAGMA | 值 | 原因 |
| --- | --- | --- |
| `journal_mode` | `WAL` | 读写并发；备份期间不阻塞聊天 |
| `foreign_keys` | `ON` | 外键约束真正生效（SQLite 默认关闭） |
| `synchronous` | `NORMAL` | WAL 下兼顾安全与写入性能 |
| `busy_timeout` | `8000` | 避免瞬时锁竞争直接报错 |
| `temp_store` | `MEMORY` | 减少小机器上的临时文件 IO |

---

## 迁移机制

`schema_migrations` 记录已应用的版本，启动时按序补齐缺失的迁移，每个迁移在**单个事务**内执行。
迁移只增不改：已发布的迁移永不修改，需要变更就追加新版本。

```sql
CREATE TABLE schema_migrations (
  version    INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  applied_at TEXT NOT NULL
);
```

| 版本 | 名称 | 内容 |
| --- | --- | --- |
| 1 | `initial_schema` | 全部核心表、索引、FTS5、触发器、计数器 |
| 2 | `error_log` | 错误日志表 |
| 3 | `fts_trigram_tokenizer` | FTS5 改用 `trigram` 分词器并重建索引 |

> **迁移 3 的原因**：`unicode61` 会把整句中文当成一个 token，导致中文记忆的全文检索
> 几乎永远命中不了。`trigram` 对中英文都有效。

---

## 表结构

### `messages` — 消息主体

```sql
CREATE TABLE messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL DEFAULT 'main',
  role            TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  created_at      TEXT NOT NULL,          -- ISO8601
  updated_at      TEXT NOT NULL,
  seq             INTEGER NOT NULL,       -- 单调递增，来自 counters
  status          TEXT NOT NULL DEFAULT 'sent'
                  CHECK (status IN ('pending','sending','sent','failed')),
  client_msg_id   TEXT,                   -- 幂等键
  reply_to        TEXT,
  error           TEXT,
  meta_json       TEXT NOT NULL DEFAULT '{}'
);
CREATE UNIQUE INDEX idx_messages_seq     ON messages(conversation_id, seq);
CREATE INDEX        idx_messages_created ON messages(conversation_id, created_at DESC);
CREATE UNIQUE INDEX idx_messages_client  ON messages(conversation_id, client_msg_id)
       WHERE client_msg_id IS NOT NULL;   -- 部分唯一索引 = 数据库层面的幂等
```

`seq` 来自 `counters` 表的原子自增，不是 `MAX(seq)+1`，所以并发写入不会撞号，
删除消息也不会让新消息复用旧号。

### `message_parts` — 消息片段

```sql
CREATE TABLE message_parts (
  id         TEXT PRIMARY KEY,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,            -- 片段顺序
  type       TEXT NOT NULL CHECK (type IN ('text','sticker','image','audio','file','system')),
  text       TEXT,
  media_id   TEXT REFERENCES media(id) ON DELETE SET NULL,
  status     TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('pending','sent','failed')),
  error      TEXT,
  duration   REAL,                        -- 音频秒数
  transcript TEXT,                        -- 语音文稿
  meta_json  TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_parts_message ON message_parts(message_id, idx);
CREATE INDEX idx_parts_media   ON message_parts(media_id);
```

- 删除消息时片段级联删除。
- 删除媒体时片段保留，`media_id` 置空——历史记录不会因为清理媒体而出现空洞。

### `media` — 媒体元数据

```sql
CREATE TABLE media (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('image','audio','sticker','file')),
  rel_path   TEXT NOT NULL,               -- 相对 media/<kind>/ 的文件名
  mime       TEXT NOT NULL,               -- 内容嗅探得出，不信任客户端声明
  bytes      INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  width      INTEGER,
  height     INTEGER,
  duration   REAL,
  origin     TEXT NOT NULL CHECK (origin IN ('upload','generated','builtin','remote')),
  created_at TEXT NOT NULL,
  transcript TEXT,
  meta_json  TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_media_created ON media(created_at DESC);
CREATE INDEX idx_media_sha     ON media(sha256);
```

### `stickers` — 表情包库

```sql
CREATE TABLE stickers (
  id           TEXT PRIMARY KEY,
  media_id     TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  tags_json    TEXT NOT NULL DEFAULT '[]',     -- ["开心","高兴","笑"]
  emotion      TEXT NOT NULL DEFAULT 'neutral',
  use_count    INTEGER NOT NULL DEFAULT 0,
  last_used_at TEXT,
  enabled      INTEGER NOT NULL DEFAULT 1,
  created_at   TEXT NOT NULL
);
CREATE INDEX idx_stickers_emotion ON stickers(emotion, enabled);
```

`use_count` 与 `last_used_at` 参与选择打分，实现「避免连续重复」。
应用层还会检查文件是否真的存在：文件丢失的表情不会出现在可用列表里。

### `memories` — 长期记忆

```sql
CREATE TABLE memories (
  id              TEXT PRIMARY KEY,
  kind            TEXT NOT NULL CHECK (kind IN
                    ('profile','preference','relationship','project','event','summary')),
  content         TEXT NOT NULL,
  normalized      TEXT NOT NULL,      -- 归一化文本，用于精确去重
  importance      REAL NOT NULL DEFAULT 0.5,
  confidence      REAL NOT NULL DEFAULT 0.6,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  expires_at      TEXT,               -- 近期事件类记忆会过期
  hits            INTEGER NOT NULL DEFAULT 0,
  embedding       BLOB,               -- Float32Array 原始字节
  embedding_dim   INTEGER,            -- 随向量一起存，不写死全局常量
  embedding_model TEXT,
  active          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX        idx_memories_kind ON memories(kind, active);
CREATE UNIQUE INDEX idx_memories_norm ON memories(normalized) WHERE active = 1;
```

六类记忆对应需求中的分类：`profile`（用户稳定信息）、`preference`（偏好）、
`relationship`（关系经历）、`project`（项目与任务）、`event`（近期事件）、`summary`（摘要）。

`embedding_dim` 逐行存储，切换 embedding 模型后旧向量不会被误用于相似度计算——
召回时只取维度匹配的那批。

### `memory_sources` — 记忆来源

```sql
CREATE TABLE memory_sources (
  memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (memory_id, message_id)
);
```

合并重复记忆时来源会累加，因此一条记忆可以指向多条原始消息。

### `memories_fts` — 全文检索

```sql
CREATE VIRTUAL TABLE memories_fts USING fts5(
  content, content='memories', content_rowid='rowid', tokenize="trigram"
);
-- memories_ai / memories_ad / memories_au 三个触发器保持索引同步
```

Embedding 不可用时的兜底。检索分三层：

1. **trigram FTS** — 查询串切成重叠 3-gram 后 `OR` 匹配；
2. **bigram 重叠打分** — FTS 无命中时扫描活跃记忆，按共享 2-gram 的 Jaccard 相似度排序
   （单用户规模下开销可忽略）；
3. 仍无结果则返回空，**绝不编造**。

### `summaries` — 阶段摘要

```sql
CREATE TABLE summaries (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL DEFAULT 'main',
  version         INTEGER NOT NULL,   -- 递增版本号
  from_seq        INTEGER NOT NULL,   -- 覆盖范围（消息 seq）
  to_seq          INTEGER NOT NULL,
  content         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  model           TEXT,
  active          INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX idx_summaries_range ON summaries(conversation_id, from_seq, to_seq);
```

`MAX(to_seq)` 就是「已摘要水位」，只向前推进，所以同一段消息不会被重复摘要。
**原始消息永远保留**，摘要只用于压缩送给模型的上下文。

### `jobs` — 后台任务

```sql
CREATE TABLE jobs (
  id           TEXT PRIMARY KEY,
  type         TEXT NOT NULL,        -- memory.extract | memory.embed.backfill
                                     -- summary.build | maintenance | backup.create
  payload_json TEXT NOT NULL DEFAULT '{}',
  status       TEXT NOT NULL DEFAULT 'pending'
               CHECK (status IN ('pending','running','done','failed','cancelled')),
  attempts     INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  last_error   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  run_after    TEXT                  -- 退避重试时间
);
CREATE INDEX idx_jobs_status ON jobs(status, run_after);
```

任务持久化在数据库里，进程异常退出后重启时 `status='running'` 的任务会被重置为
`pending` 重新执行——这就是「未完成任务恢复」。

### `events` — 事件日志（SSE 补偿）

```sql
CREATE TABLE events (
  id           TEXT PRIMARY KEY,
  seq          INTEGER NOT NULL,
  type         TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE UNIQUE INDEX idx_events_seq     ON events(seq);
CREATE INDEX        idx_events_created ON events(created_at);
```

事件**先落库再推送**。`seq` 同样来自 `counters`，所以裁剪旧事件不会让高水位回退——
如果用 `MAX(seq)`，裁剪后重连的客户端会拿到比自己还小的位置从而漏事件。

### `settings` — 键值设置

```sql
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL, updated_at TEXT NOT NULL);
```

### `error_log` — 错误日志

```sql
CREATE TABLE error_log (
  id TEXT PRIMARY KEY, created_at TEXT NOT NULL,
  scope TEXT NOT NULL, message TEXT NOT NULL, detail TEXT
);
CREATE INDEX idx_error_created ON error_log(created_at DESC);
```

写入前对 `message` 和 `detail` 做密钥脱敏（`sk-***`、`Bearer ***`），
因为管理接口会原样返回这张表。表容量上限 500 条。

### `counters` — 原子序号

```sql
CREATE TABLE counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);
INSERT INTO counters(name, value) VALUES ('message_seq', 0), ('event_seq', 0);
```

通过 `UPDATE ... RETURNING value` 原子取号。

---

## 损坏检测与恢复

启动时执行 `PRAGMA integrity_check` 与 `PRAGMA foreign_key_check`。任一失败时：

1. 把损坏的 `.db` / `-wal` / `-shm` 改名为 `sooya.db.corrupt-<时间戳>`（**保留证据，不删除**）；
2. 在 `backups/` 里按时间倒序寻找第一个能通过 `integrity_check` 的备份并复制回来；
3. 备份也不可用时，创建一个全新的空库并跑完迁移；
4. 无论走哪条路径，进程都**正常启动**，`/health/ready` 通过 `dbRecovered` 与
   `dbRecoveredFrom`（`backup` / `fresh`）如实上报。

---

## 备份

`BackupService` 使用 SQLite **在线备份 API**（`db.backup()`），运行中执行也安全。

每次备份产出三个文件：

```
sooya-2026-07-28T06-38-04-090Z.db          数据库快照
sooya-2026-07-28T06-38-04-090Z.db.sha256   校验和
sooya-2026-07-28T06-38-04-090Z.db.json     清单（大小、媒体文件数、原因）
```

快照在**改名为最终文件名之前**先用只读连接跑一次 `integrity_check` 并查询 `messages`
表，验证不通过就删除临时文件并报错，因此 `backups/` 里不会留下坏备份。
保留策略由 `BACKUP_KEEP` 控制。

**恢复**会先关闭现有连接再替换文件（否则活动连接的 WAL 会被回放到刚恢复的库上，
把想要回滚掉的数据又写回来），原库保留为 `sooya.db.pre-restore-<时间戳>`。

`deploy/backup.sh` 在数据库之外还打包 `media/` 和 `config/`，产出带校验和的 tar.gz；
默认**不包含** `.env`（含密钥），需要时用 `INCLUDE_ENV=1` 显式开启。

---

## 典型查询

```sql
-- 最近 30 条（前端首屏）
SELECT * FROM messages WHERE conversation_id='main' ORDER BY seq DESC LIMIT 30;

-- 向上翻页
SELECT * FROM messages WHERE conversation_id='main' AND seq < ? ORDER BY seq DESC LIMIT 30;

-- 断线对账
SELECT * FROM messages WHERE conversation_id='main' AND seq > ? ORDER BY seq ASC;

-- 待摘要水位
SELECT COALESCE(MAX(to_seq),0) FROM summaries WHERE conversation_id='main' AND active=1;

-- 记忆向量召回候选（按维度过滤）
SELECT * FROM memories
 WHERE active=1 AND embedding IS NOT NULL AND embedding_dim=?
   AND (expires_at IS NULL OR expires_at > ?);
```
