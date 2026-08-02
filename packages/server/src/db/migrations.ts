import type BetterSqlite3 from 'better-sqlite3';

// Kept local because migration 5 must remain able to upgrade an old database
// after the live world feature has been removed.
function legacyWorldIdentityKey(value: string): string {
  return value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
}

export interface Migration {
  version: number;
  name: string;
  up: (db: BetterSqlite3.Database) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: 'initial_schema',
    up: (db) => {
      db.exec(`
        CREATE TABLE messages (
          id            TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL DEFAULT 'main',
          role          TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL,
          seq           INTEGER NOT NULL,
          status        TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('pending','sending','sent','failed')),
          client_msg_id TEXT,
          reply_to      TEXT,
          error         TEXT,
          meta_json     TEXT NOT NULL DEFAULT '{}'
        );
        CREATE UNIQUE INDEX idx_messages_seq ON messages(conversation_id, seq);
        CREATE INDEX idx_messages_created ON messages(conversation_id, created_at DESC);
        CREATE UNIQUE INDEX idx_messages_client ON messages(conversation_id, client_msg_id)
          WHERE client_msg_id IS NOT NULL;

        CREATE TABLE message_parts (
          id          TEXT PRIMARY KEY,
          message_id  TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          idx         INTEGER NOT NULL,
          type        TEXT NOT NULL CHECK (type IN ('text','sticker','image','audio','file','system')),
          text        TEXT,
          media_id    TEXT REFERENCES media(id) ON DELETE SET NULL,
          status      TEXT NOT NULL DEFAULT 'sent' CHECK (status IN ('pending','sent','failed')),
          error       TEXT,
          duration    REAL,
          transcript  TEXT,
          meta_json   TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX idx_parts_message ON message_parts(message_id, idx);
        CREATE INDEX idx_parts_media ON message_parts(media_id);

        CREATE TABLE media (
          id            TEXT PRIMARY KEY,
          kind          TEXT NOT NULL CHECK (kind IN ('image','audio','sticker','file')),
          rel_path      TEXT NOT NULL,
          mime          TEXT NOT NULL,
          bytes         INTEGER NOT NULL,
          sha256        TEXT NOT NULL,
          width         INTEGER,
          height        INTEGER,
          duration      REAL,
          origin        TEXT NOT NULL CHECK (origin IN ('upload','generated','builtin','remote')),
          created_at    TEXT NOT NULL,
          transcript    TEXT,
          meta_json     TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX idx_media_created ON media(created_at DESC);
        CREATE INDEX idx_media_sha ON media(sha256);

        CREATE TABLE stickers (
          id            TEXT PRIMARY KEY,
          media_id      TEXT NOT NULL REFERENCES media(id) ON DELETE CASCADE,
          name          TEXT NOT NULL,
          tags_json     TEXT NOT NULL DEFAULT '[]',
          emotion       TEXT NOT NULL DEFAULT 'neutral',
          use_count     INTEGER NOT NULL DEFAULT 0,
          last_used_at  TEXT,
          enabled       INTEGER NOT NULL DEFAULT 1,
          created_at    TEXT NOT NULL
        );
        CREATE INDEX idx_stickers_emotion ON stickers(emotion, enabled);

        CREATE TABLE memories (
          id           TEXT PRIMARY KEY,
          kind         TEXT NOT NULL CHECK (kind IN ('profile','preference','relationship','project','event','summary')),
          content      TEXT NOT NULL,
          normalized   TEXT NOT NULL,
          importance   REAL NOT NULL DEFAULT 0.5,
          confidence   REAL NOT NULL DEFAULT 0.6,
          created_at   TEXT NOT NULL,
          updated_at   TEXT NOT NULL,
          expires_at   TEXT,
          hits         INTEGER NOT NULL DEFAULT 0,
          embedding    BLOB,
          embedding_dim INTEGER,
          embedding_model TEXT,
          active       INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX idx_memories_kind ON memories(kind, active);
        CREATE UNIQUE INDEX idx_memories_norm ON memories(normalized) WHERE active = 1;

        CREATE TABLE memory_sources (
          memory_id  TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (memory_id, message_id)
        );

        CREATE VIRTUAL TABLE memories_fts USING fts5(
          content,
          content='memories',
          content_rowid='rowid',
          tokenize="unicode61 remove_diacritics 2"
        );

        CREATE TABLE summaries (
          id            TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL DEFAULT 'main',
          version       INTEGER NOT NULL,
          from_seq      INTEGER NOT NULL,
          to_seq        INTEGER NOT NULL,
          content       TEXT NOT NULL,
          created_at    TEXT NOT NULL,
          model         TEXT,
          active        INTEGER NOT NULL DEFAULT 1
        );
        CREATE INDEX idx_summaries_range ON summaries(conversation_id, from_seq, to_seq);

        CREATE TABLE jobs (
          id          TEXT PRIMARY KEY,
          type        TEXT NOT NULL,
          payload_json TEXT NOT NULL DEFAULT '{}',
          status      TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','running','done','failed','cancelled')),
          attempts    INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          last_error  TEXT,
          created_at  TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          run_after   TEXT
        );
        CREATE INDEX idx_jobs_status ON jobs(status, run_after);

        CREATE TABLE settings (
          key        TEXT PRIMARY KEY,
          value_json TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );

        CREATE TABLE events (
          id         TEXT PRIMARY KEY,
          seq        INTEGER NOT NULL,
          type       TEXT NOT NULL,
          payload_json TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_events_seq ON events(seq);
        CREATE INDEX idx_events_created ON events(created_at);

        CREATE TABLE counters (
          name  TEXT PRIMARY KEY,
          value INTEGER NOT NULL
        );
        INSERT INTO counters(name, value) VALUES ('message_seq', 0), ('event_seq', 0);
      `);

      db.exec(`
        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
        CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        END;
        CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
          INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
      `);
    }
  },
  {
    version: 2,
    name: 'error_log',
    up: (db) => {
      db.exec(`
        CREATE TABLE error_log (
          id         TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          scope      TEXT NOT NULL,
          message    TEXT NOT NULL,
          detail     TEXT
        );
        CREATE INDEX idx_error_created ON error_log(created_at DESC);
      `);
    }
  },
  {
    version: 3,
    name: 'fts_trigram_tokenizer',
    up: (db) => {
      db.exec(`
        DROP TRIGGER IF EXISTS memories_ai;
        DROP TRIGGER IF EXISTS memories_ad;
        DROP TRIGGER IF EXISTS memories_au;
        DROP TABLE IF EXISTS memories_fts;
        CREATE VIRTUAL TABLE memories_fts USING fts5(
          content,
          content='memories',
          content_rowid='rowid',
          tokenize="trigram"
        );
        INSERT INTO memories_fts(memories_fts) VALUES('rebuild');
        CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
          INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
        CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
        END;
        CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
          INSERT INTO memories_fts(memories_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
          INSERT INTO memories_fts(rowid, content) VALUES (new.rowid, new.content);
        END;
      `);
    }
  },
  {
    version: 4,
    name: 'features_1_9_foundations',
    up: (db) => {
      db.exec(`
        ALTER TABLE media ADD COLUMN deleted_at TEXT;
        ALTER TABLE media ADD COLUMN favorite INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE media ADD COLUMN tags_json TEXT NOT NULL DEFAULT '[]';
        CREATE INDEX idx_media_deleted ON media(deleted_at, created_at DESC);
        CREATE INDEX idx_media_favorite ON media(favorite, deleted_at, created_at DESC);

        CREATE TABLE push_subscriptions (
          endpoint        TEXT PRIMARY KEY,
          p256dh          TEXT NOT NULL,
          auth            TEXT NOT NULL,
          expiration_time INTEGER,
          visible         INTEGER NOT NULL DEFAULT 0,
          last_seen_at    TEXT,
          fail_count      INTEGER NOT NULL DEFAULT 0,
          created_at      TEXT NOT NULL,
          updated_at      TEXT NOT NULL
        );
        CREATE INDEX idx_push_updated ON push_subscriptions(updated_at DESC);

        CREATE TABLE world_entries (
          id                TEXT PRIMARY KEY,
          kind              TEXT NOT NULL CHECK (kind IN ('entity','relation','fact','scene','timeline')),
          subject           TEXT NOT NULL,
          predicate         TEXT NOT NULL,
          object            TEXT NOT NULL,
          value_json        TEXT NOT NULL DEFAULT '{}',
          confidence        REAL NOT NULL DEFAULT 0.6,
          authority         TEXT NOT NULL DEFAULT 'model' CHECK (authority IN ('model','user','admin')),
          source_message_id TEXT,
          active            INTEGER NOT NULL DEFAULT 1,
          conflict_of       TEXT REFERENCES world_entries(id) ON DELETE SET NULL,
          created_at        TEXT NOT NULL,
          updated_at        TEXT NOT NULL
        );
        CREATE INDEX idx_world_active ON world_entries(active, kind, updated_at DESC);
        CREATE INDEX idx_world_identity ON world_entries(subject, predicate, active);
        CREATE INDEX idx_world_source ON world_entries(source_message_id);

        CREATE TABLE world_sources (
          entry_id   TEXT NOT NULL REFERENCES world_entries(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (entry_id, message_id)
        );

        CREATE TABLE audit_log (
          id          TEXT PRIMARY KEY,
          category    TEXT NOT NULL,
          action      TEXT NOT NULL,
          target      TEXT,
          detail_json TEXT NOT NULL DEFAULT '{}',
          created_at  TEXT NOT NULL
        );
        CREATE INDEX idx_audit_created ON audit_log(created_at DESC);

        CREATE TABLE storage_samples (
          id          INTEGER PRIMARY KEY AUTOINCREMENT,
          created_at  TEXT NOT NULL,
          media_bytes INTEGER NOT NULL,
          data_bytes  INTEGER NOT NULL,
          free_bytes  INTEGER
        );
        CREATE INDEX idx_storage_samples_created ON storage_samples(created_at DESC);
      `);
    }
  },
  {
    version: 5,
    name: 'world_identity_keys',
    up: (db) => {
      db.exec(`
        ALTER TABLE world_entries ADD COLUMN subject_key TEXT NOT NULL DEFAULT '';
        ALTER TABLE world_entries ADD COLUMN predicate_key TEXT NOT NULL DEFAULT '';
      `);
      const rows = db.prepare(`
        SELECT id, subject, predicate, authority, confidence, active, conflict_of, updated_at
        FROM world_entries
      `).all() as Array<{
        id: string;
        subject: string;
        predicate: string;
        authority: 'model' | 'user' | 'admin';
        confidence: number;
        active: number;
        conflict_of: string | null;
        updated_at: string;
      }>;
      const updateKeys = db.prepare('UPDATE world_entries SET subject_key = ?, predicate_key = ? WHERE id = ?');
      for (const row of rows) updateKeys.run(legacyWorldIdentityKey(row.subject), legacyWorldIdentityKey(row.predicate), row.id);

      const authorityRank = { model: 1, user: 2, admin: 3 } as const;
      const groups = new Map<string, typeof rows>();
      for (const row of rows.filter((item) => item.active === 1 && item.conflict_of === null)) {
        const key = `${legacyWorldIdentityKey(row.subject)}\u0000${legacyWorldIdentityKey(row.predicate)}`;
        const group = groups.get(key) ?? [];
        group.push(row);
        groups.set(key, group);
      }
      for (const group of groups.values()) {
        if (group.length < 2) continue;
        group.sort((a, b) =>
          authorityRank[b.authority] - authorityRank[a.authority] ||
          b.confidence - a.confidence ||
          b.updated_at.localeCompare(a.updated_at) ||
          a.id.localeCompare(b.id)
        );
        const winner = group[0]!;
        for (const duplicate of group.slice(1)) {
          db.prepare('UPDATE world_entries SET active = 0, conflict_of = ? WHERE id = ?').run(winner.id, duplicate.id);
        }
      }
      db.exec(`
        CREATE INDEX idx_world_identity_keys ON world_entries(subject_key, predicate_key, active);
        CREATE UNIQUE INDEX idx_world_one_active_identity
          ON world_entries(subject_key, predicate_key)
          WHERE active = 1 AND conflict_of IS NULL;
      `);
    }
  },
  {
    version: 6,
    name: 'life_engine',
    up: (db) => {
      /*
       * The assistant had no existence between messages. Nothing advanced, so
       * "什么都没发生" was the only honest answer to 你在干嘛 -- and the model,
       * having no state to read, invented a different answer every time.
       *
       * life_state holds the single current activity; life_log is the history
       * she recounts from. `shared` marks a log row she has already brought up
       * unprompted, so she does not open with the same thing twice.
       */
      db.exec(`
        CREATE TABLE life_state (
          id          INTEGER PRIMARY KEY CHECK (id = 1),
          activity    TEXT NOT NULL,
          kind        TEXT NOT NULL,
          mood        TEXT NOT NULL,
          started_at  TEXT NOT NULL,
          ends_at     TEXT NOT NULL,
          updated_at  TEXT NOT NULL,
          meta_json   TEXT NOT NULL DEFAULT '{}'
        );

        CREATE TABLE life_log (
          id          TEXT PRIMARY KEY,
          activity    TEXT NOT NULL,
          kind        TEXT NOT NULL,
          mood        TEXT NOT NULL,
          started_at  TEXT NOT NULL,
          ended_at    TEXT NOT NULL,
          shared      INTEGER NOT NULL DEFAULT 0,
          created_at  TEXT NOT NULL
        );
        CREATE INDEX idx_life_log_started ON life_log(started_at DESC);
        CREATE INDEX idx_life_log_shared ON life_log(shared, started_at DESC);
      `);
    }
  },
  {
    version: 7,
    name: 'remove_world_engine',
    up: (db) => {
      db.exec(`
        DELETE FROM jobs WHERE type IN ('world.extract', 'world.rebuild');
        DELETE FROM events WHERE type = 'world.updated';
        DROP TABLE IF EXISTS world_sources;
        DROP TABLE IF EXISTS world_entries;
      `);
    }
  },
  {
    version: 8,
    name: 'durable_reply_batches',
    up: (db) => {
      db.exec(`
        CREATE TABLE reply_batches (
          id                   TEXT PRIMARY KEY,
          conversation_id      TEXT NOT NULL DEFAULT 'main',
          status               TEXT NOT NULL CHECK (status IN ('collecting','queued','running','completed','failed','cancelled')),
          trigger_message_id   TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          assistant_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
          opened_at            TEXT NOT NULL,
          due_at               TEXT NOT NULL,
          started_at           TEXT,
          completed_at         TEXT,
          last_error           TEXT,
          attempts             INTEGER NOT NULL DEFAULT 0,
          lease_owner          TEXT,
          lease_expires_at     TEXT,
          meta_json            TEXT NOT NULL DEFAULT '{}'
        );
        CREATE INDEX idx_reply_batches_status_due ON reply_batches(status, due_at);

        CREATE TABLE reply_batch_messages (
          batch_id   TEXT NOT NULL REFERENCES reply_batches(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          position   INTEGER NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (batch_id, message_id),
          UNIQUE (message_id),
          UNIQUE (batch_id, position)
        );
        CREATE INDEX idx_reply_batch_messages_order ON reply_batch_messages(batch_id, position);
        CREATE UNIQUE INDEX idx_messages_one_active_reply_per_batch
          ON messages(json_extract(meta_json, '$.batchId'))
          WHERE role = 'assistant'
            AND status IN ('sending','sent')
            AND json_extract(meta_json, '$.batchId') IS NOT NULL;
      `);
    }
  },
  {
    version: 9,
    name: 'media_text_extraction',
    up: (db) => {
      db.exec(`
        CREATE TABLE media_text (
          media_id       TEXT PRIMARY KEY REFERENCES media(id) ON DELETE CASCADE,
          status         TEXT NOT NULL CHECK (status IN ('pending','ready','failed','unsupported')),
          text           TEXT,
          metadata_json  TEXT NOT NULL DEFAULT '{}',
          error          TEXT,
          updated_at     TEXT NOT NULL
        );
      `);
    }
  },
  {
    version: 10,
    name: 'message_history_search',
    up: (db) => {
      db.exec(`
        CREATE VIRTUAL TABLE messages_fts USING fts5(
          message_id UNINDEXED,
          conversation_id UNINDEXED,
          content,
          tokenize='trigram'
        );

        INSERT INTO messages_fts(message_id, conversation_id, content)
        SELECT m.id, m.conversation_id,
          COALESCE((SELECT group_concat(
            CASE WHEN p.type IN ('text','audio') THEN COALESCE(p.text, p.transcript, '')
                 ELSE COALESCE(media.rel_path, '') || ' ' || COALESCE(media_text.text, '') END, ' ')
            FROM message_parts p
            LEFT JOIN media ON media.id = p.media_id
            LEFT JOIN media_text ON media_text.media_id = p.media_id
            WHERE p.message_id = m.id), '')
        FROM messages m;

        CREATE TRIGGER message_parts_fts_ai AFTER INSERT ON message_parts BEGIN
          DELETE FROM messages_fts WHERE message_id = new.message_id;
          INSERT INTO messages_fts(message_id, conversation_id, content)
          SELECT m.id, m.conversation_id,
            COALESCE((SELECT group_concat(
              CASE WHEN p.type IN ('text','audio') THEN COALESCE(p.text, p.transcript, '')
                   ELSE COALESCE(media.rel_path, '') || ' ' || COALESCE(media_text.text, '') END, ' ')
              FROM message_parts p
              LEFT JOIN media ON media.id = p.media_id
              LEFT JOIN media_text ON media_text.media_id = p.media_id
              WHERE p.message_id = m.id), '')
          FROM messages m WHERE m.id = new.message_id;
        END;
        CREATE TRIGGER message_parts_fts_au AFTER UPDATE OF text, transcript, media_id, type ON message_parts BEGIN
          DELETE FROM messages_fts WHERE message_id = new.message_id;
          INSERT INTO messages_fts(message_id, conversation_id, content)
          SELECT m.id, m.conversation_id,
            COALESCE((SELECT group_concat(
              CASE WHEN p.type IN ('text','audio') THEN COALESCE(p.text, p.transcript, '')
                   ELSE COALESCE(media.rel_path, '') || ' ' || COALESCE(media_text.text, '') END, ' ')
              FROM message_parts p
              LEFT JOIN media ON media.id = p.media_id
              LEFT JOIN media_text ON media_text.media_id = p.media_id
              WHERE p.message_id = m.id), '')
          FROM messages m WHERE m.id = new.message_id;
        END;
        CREATE TRIGGER message_parts_fts_ad AFTER DELETE ON message_parts BEGIN
          DELETE FROM messages_fts WHERE message_id = old.message_id;
          INSERT INTO messages_fts(message_id, conversation_id, content)
          SELECT m.id, m.conversation_id,
            COALESCE((SELECT group_concat(
              CASE WHEN p.type IN ('text','audio') THEN COALESCE(p.text, p.transcript, '')
                   ELSE COALESCE(media.rel_path, '') || ' ' || COALESCE(media_text.text, '') END, ' ')
              FROM message_parts p
              LEFT JOIN media ON media.id = p.media_id
              LEFT JOIN media_text ON media_text.media_id = p.media_id
              WHERE p.message_id = m.id), '')
          FROM messages m WHERE m.id = old.message_id;
        END;
        CREATE TRIGGER messages_fts_ad AFTER DELETE ON messages BEGIN
          DELETE FROM messages_fts WHERE message_id = old.id;
        END;

        CREATE TRIGGER media_text_fts_ai AFTER INSERT ON media_text BEGIN
          DELETE FROM messages_fts WHERE message_id IN (SELECT message_id FROM message_parts WHERE media_id = new.media_id);
          INSERT INTO messages_fts(message_id, conversation_id, content)
          SELECT m.id, m.conversation_id,
            COALESCE((SELECT group_concat(
              CASE WHEN p.type IN ('text','audio') THEN COALESCE(p.text, p.transcript, '')
                   ELSE COALESCE(media.rel_path, '') || ' ' || COALESCE(media_text.text, '') END, ' ')
              FROM message_parts p
              LEFT JOIN media ON media.id = p.media_id
              LEFT JOIN media_text ON media_text.media_id = p.media_id
              WHERE p.message_id = m.id), '')
          FROM messages m WHERE m.id IN (SELECT message_id FROM message_parts WHERE media_id = new.media_id);
        END;
        CREATE TRIGGER media_text_fts_au AFTER UPDATE OF text, status ON media_text BEGIN
          DELETE FROM messages_fts WHERE message_id IN (SELECT message_id FROM message_parts WHERE media_id = new.media_id);
          INSERT INTO messages_fts(message_id, conversation_id, content)
          SELECT m.id, m.conversation_id,
            COALESCE((SELECT group_concat(
              CASE WHEN p.type IN ('text','audio') THEN COALESCE(p.text, p.transcript, '')
                   ELSE COALESCE(media.rel_path, '') || ' ' || COALESCE(media_text.text, '') END, ' ')
              FROM message_parts p
              LEFT JOIN media ON media.id = p.media_id
              LEFT JOIN media_text ON media_text.media_id = p.media_id
              WHERE p.message_id = m.id), '')
          FROM messages m WHERE m.id IN (SELECT message_id FROM message_parts WHERE media_id = new.media_id);
        END;
        CREATE TRIGGER media_text_fts_ad AFTER DELETE ON media_text BEGIN
          DELETE FROM messages_fts WHERE message_id IN (SELECT message_id FROM message_parts WHERE media_id = old.media_id);
          INSERT INTO messages_fts(message_id, conversation_id, content)
          SELECT m.id, m.conversation_id,
            COALESCE((SELECT group_concat(
              CASE WHEN p.type IN ('text','audio') THEN COALESCE(p.text, p.transcript, '')
                   ELSE COALESCE(media.rel_path, '') || ' ' || COALESCE(media_text.text, '') END, ' ')
              FROM message_parts p
              LEFT JOIN media ON media.id = p.media_id
              LEFT JOIN media_text ON media_text.media_id = p.media_id
              WHERE p.message_id = m.id), '')
          FROM messages m WHERE m.id IN (SELECT message_id FROM message_parts WHERE media_id = old.media_id);
        END;
      `);
    }
  },
  {
    version: 11,
    name: 'life_engine_2_plans_events',
    up: (db) => {
      db.exec(`
        CREATE TABLE life_plans (
          id            TEXT PRIMARY KEY,
          title         TEXT NOT NULL,
          kind          TEXT NOT NULL,
          planned_start TEXT,
          planned_end   TEXT,
          status        TEXT NOT NULL CHECK (status IN ('planned','active','paused','completed','cancelled','skipped')),
          source        TEXT NOT NULL CHECK (source IN ('routine','generated','admin','conversation')),
          priority      INTEGER NOT NULL DEFAULT 0,
          meta_json     TEXT NOT NULL DEFAULT '{}',
          created_at    TEXT NOT NULL,
          updated_at    TEXT NOT NULL
        );
        CREATE INDEX idx_life_plans_status_time ON life_plans(status, planned_start, priority DESC);

        CREATE TABLE life_events (
          id           TEXT PRIMARY KEY,
          plan_id      TEXT REFERENCES life_plans(id) ON DELETE SET NULL,
          log_id       TEXT UNIQUE REFERENCES life_log(id) ON DELETE CASCADE,
          event_type   TEXT NOT NULL,
          activity     TEXT NOT NULL,
          kind         TEXT NOT NULL,
          description  TEXT NOT NULL,
          mood_before  TEXT,
          mood_after   TEXT,
          happened_at  TEXT NOT NULL,
          shareable    INTEGER NOT NULL DEFAULT 0,
          shared_at    TEXT,
          meta_json    TEXT NOT NULL DEFAULT '{}',
          created_at   TEXT NOT NULL
        );
        CREATE INDEX idx_life_events_happened ON life_events(happened_at DESC);
        CREATE INDEX idx_life_events_shareable ON life_events(shareable, shared_at, happened_at DESC);
      `);
    }
  },
  {
    version: 12,
    name: 'memory_lifecycle_supersession',
    up: (db) => {
      db.exec(`
        ALTER TABLE memories ADD COLUMN supersedes_id TEXT REFERENCES memories(id) ON DELETE SET NULL;
        ALTER TABLE memories ADD COLUMN superseded_by_id TEXT REFERENCES memories(id) ON DELETE SET NULL;
        ALTER TABLE memories ADD COLUMN archived_at TEXT;
        CREATE INDEX idx_memories_supersedes ON memories(supersedes_id);
        CREATE INDEX idx_memories_superseded_by ON memories(superseded_by_id);
        CREATE INDEX idx_memories_archived ON memories(kind, archived_at, active);
        UPDATE memories SET active = 0, updated_at = datetime('now') WHERE kind = 'summary' AND active = 1;
      `);
    }
  },
  {
    version: 13,
    name: 'proactive_reach_out_attempts',
    up: (db) => {
      db.exec(`
        CREATE TABLE proactive_attempts (
          id                         TEXT PRIMARY KEY,
          candidate_id               TEXT,
          candidate_kind             TEXT,
          candidate_activity         TEXT,
          status                     TEXT NOT NULL CHECK (status IN ('blocked','sent','failed')),
          blocked_reason             TEXT,
          requested_mode             TEXT CHECK (requested_mode IN ('text','text_sticker','voice','image')),
          final_mode                 TEXT CHECK (final_mode IN ('text','text_sticker','voice','image')),
          fallback_reason            TEXT,
          message_id                 TEXT REFERENCES messages(id) ON DELETE SET NULL,
          send_success               INTEGER NOT NULL DEFAULT 0,
          user_response_message_id   TEXT REFERENCES messages(id) ON DELETE SET NULL,
          user_responded_at          TEXT,
          detail_json                TEXT NOT NULL DEFAULT '{}',
          created_at                 TEXT NOT NULL,
          updated_at                 TEXT NOT NULL
        );
        CREATE INDEX idx_proactive_attempts_created ON proactive_attempts(created_at DESC);
        CREATE INDEX idx_proactive_attempts_response ON proactive_attempts(user_response_message_id, created_at DESC);
        CREATE INDEX idx_proactive_attempts_candidate ON proactive_attempts(candidate_id, created_at DESC);
      `);
    }
  }
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
