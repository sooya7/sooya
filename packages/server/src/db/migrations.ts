import type BetterSqlite3 from 'better-sqlite3';

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

      // Keep FTS in sync with memories.
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
      // unicode61 treats a whole Chinese sentence as a single token, which made
      // FTS recall useless for CJK. The trigram tokenizer indexes overlapping
      // 3-character sequences and works for both Latin and CJK text.
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
  }
];

export const LATEST_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;
