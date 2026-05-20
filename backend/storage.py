import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def now_iso():
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def to_json(value):
    return json.dumps(None if value is None else value, ensure_ascii=False)


def from_json(value, fallback=None):
    if value is None or value == "":
        return fallback
    return json.loads(value)


class RuntimeStorage:
    """SQLite runtime storage shared by the Python and legacy Node backends."""

    def __init__(self, root_dir=None):
        self.base_dir = Path(root_dir or Path.cwd() / "data" / "runtime").resolve()
        self.source_files_dir = self.base_dir / "upload_sources"
        self.base_dir.mkdir(parents=True, exist_ok=True)
        self.source_files_dir.mkdir(parents=True, exist_ok=True)
        self.db_path = self.base_dir / "runtime.sqlite"
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._init_schema()

    def _init_schema(self):
        self.conn.executescript(
            """
            PRAGMA journal_mode = WAL;
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS sessions (
              id TEXT PRIMARY KEY,
              prompt TEXT NOT NULL,
              workflow TEXT NOT NULL,
              source_mode TEXT NOT NULL,
              model TEXT,
              scenario_json TEXT,
              final_prompt TEXT,
              payload_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS answers (
              session_id TEXT NOT NULL,
              question_id TEXT NOT NULL,
              answer_json TEXT NOT NULL,
              custom_answer TEXT,
              updated_at TEXT NOT NULL,
              PRIMARY KEY (session_id, question_id),
              FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS prompt_versions (
              version_id TEXT PRIMARY KEY,
              session_id TEXT NOT NULL,
              workflow TEXT NOT NULL,
              source_mode TEXT NOT NULL,
              prompt_mode TEXT NOT NULL,
              prompt_source_json TEXT,
              prompt TEXT NOT NULL,
              knowledge TEXT,
              knowledge_profile_json TEXT,
              answers_json TEXT NOT NULL,
              custom_answers_json TEXT NOT NULL,
              auto_answers_json TEXT NOT NULL,
              refinements_json TEXT NOT NULL,
              final_prompt TEXT NOT NULL,
              created_at TEXT NOT NULL,
              FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS uploaded_documents (
              id TEXT PRIMARY KEY,
              filename TEXT NOT NULL,
              mime_type TEXT,
              size INTEGER NOT NULL,
              content_hash TEXT NOT NULL,
              source_path TEXT,
              extracted_text TEXT NOT NULL,
              chunk_count INTEGER NOT NULL,
              milvus_collection TEXT,
              milvus_record_ids_json TEXT,
              milvus_status_json TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              deleted_at TEXT
            );

            CREATE TABLE IF NOT EXISTS document_chunks (
              document_id TEXT NOT NULL,
              chunk_id TEXT NOT NULL,
              chunk_index INTEGER NOT NULL,
              text TEXT NOT NULL,
              embedding_json TEXT NOT NULL,
              PRIMARY KEY (document_id, chunk_id),
              FOREIGN KEY (document_id) REFERENCES uploaded_documents(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS audit_logs (
              id INTEGER PRIMARY KEY AUTOINCREMENT,
              type TEXT NOT NULL,
              session_id TEXT,
              document_id TEXT,
              detail_json TEXT,
              created_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS settings (
              key TEXT PRIMARY KEY,
              value_json TEXT NOT NULL,
              updated_at TEXT NOT NULL
            );
            """
        )
        self.conn.commit()

    def save_session(self, session):
        updated_at = session.get("updatedAt") or now_iso()
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO sessions (
                  id, prompt, workflow, source_mode, model, scenario_json, final_prompt,
                  payload_json, created_at, updated_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(id) DO UPDATE SET
                  prompt = excluded.prompt,
                  workflow = excluded.workflow,
                  source_mode = excluded.source_mode,
                  model = excluded.model,
                  scenario_json = excluded.scenario_json,
                  final_prompt = excluded.final_prompt,
                  payload_json = excluded.payload_json,
                  updated_at = excluded.updated_at
                """,
                (
                    session["id"],
                    session.get("prompt", ""),
                    session.get("workflow", ""),
                    session.get("sourceMode", ""),
                    session.get("model", ""),
                    to_json(session.get("scenario")),
                    session.get("finalPrompt", ""),
                    to_json(session),
                    session.get("createdAt") or updated_at,
                    updated_at,
                ),
            )
            self.conn.execute("DELETE FROM answers WHERE session_id = ?", (session["id"],))
            for question_id, answer in (session.get("answers") or {}).items():
                self.conn.execute(
                    """
                    INSERT INTO answers (session_id, question_id, answer_json, custom_answer, updated_at)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        session["id"],
                        question_id,
                        to_json(answer),
                        (session.get("customAnswers") or {}).get(question_id, ""),
                        updated_at,
                    ),
                )

    def load_session(self, session_id):
        row = self.conn.execute("SELECT payload_json FROM sessions WHERE id = ?", (session_id,)).fetchone()
        return from_json(row["payload_json"]) if row else None

    def list_sessions(self, limit=100):
        safe_limit = max(1, min(int(limit or 100), 500))
        rows = self.conn.execute(
            """
            SELECT id, prompt, workflow, source_mode, model, scenario_json, final_prompt, created_at, updated_at
            FROM sessions
            ORDER BY updated_at DESC
            LIMIT ?
            """,
            (safe_limit,),
        ).fetchall()
        return [
            {
                "id": row["id"],
                "prompt": row["prompt"],
                "workflow": row["workflow"],
                "sourceMode": row["source_mode"],
                "model": row["model"],
                "scenario": from_json(row["scenario_json"]),
                "finalPrompt": row["final_prompt"],
                "createdAt": row["created_at"],
                "updatedAt": row["updated_at"],
            }
            for row in rows
        ]

    def append_prompt_version(self, version):
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO prompt_versions (
                  version_id, session_id, workflow, source_mode, prompt_mode, prompt_source_json,
                  prompt, knowledge, knowledge_profile_json, answers_json, custom_answers_json,
                  auto_answers_json, refinements_json, final_prompt, created_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    version["versionId"],
                    version["sessionId"],
                    version.get("workflow", ""),
                    version.get("sourceMode", ""),
                    version.get("promptMode", ""),
                    to_json(version.get("promptSource")),
                    version.get("prompt", ""),
                    version.get("knowledge", ""),
                    to_json(version.get("knowledgeProfile")),
                    to_json(version.get("answers") or {}),
                    to_json(version.get("customAnswers") or {}),
                    to_json(version.get("autoAnswers") or {}),
                    to_json(version.get("refinements") or []),
                    version.get("finalPrompt", ""),
                    version.get("createdAt") or now_iso(),
                ),
            )

    def list_prompt_versions(self, session_id):
        rows = self.conn.execute(
            "SELECT * FROM prompt_versions WHERE session_id = ? ORDER BY created_at DESC",
            (session_id,),
        ).fetchall()
        return [
            {
                "versionId": row["version_id"],
                "sessionId": row["session_id"],
                "workflow": row["workflow"],
                "sourceMode": row["source_mode"],
                "promptMode": row["prompt_mode"],
                "promptSource": from_json(row["prompt_source_json"]),
                "prompt": row["prompt"],
                "knowledge": row["knowledge"],
                "knowledgeProfile": from_json(row["knowledge_profile_json"]),
                "answers": from_json(row["answers_json"], {}),
                "customAnswers": from_json(row["custom_answers_json"], {}),
                "autoAnswers": from_json(row["auto_answers_json"], {}),
                "refinements": from_json(row["refinements_json"], []),
                "finalPrompt": row["final_prompt"],
                "createdAt": row["created_at"],
            }
            for row in rows
        ]

    def append_audit(self, event):
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO audit_logs (type, session_id, document_id, detail_json, created_at)
                VALUES (?, ?, ?, ?, ?)
                """,
                (
                    event.get("type") or "event",
                    event.get("sessionId"),
                    event.get("documentId"),
                    to_json(event.get("detail") or {}),
                    event.get("createdAt") or now_iso(),
                ),
            )

    def _document_from_row(self, row, include_text=False):
        if not row:
            return None
        chunk_rows = self.conn.execute(
            "SELECT * FROM document_chunks WHERE document_id = ? ORDER BY chunk_index ASC",
            (row["id"],),
        ).fetchall()
        chunks = [
            {
                "id": chunk["chunk_id"],
                "index": chunk["chunk_index"],
                "text": chunk["text"],
                "embedding": from_json(chunk["embedding_json"], []),
            }
            for chunk in chunk_rows
        ]
        return {
            "id": row["id"],
            "filename": row["filename"],
            "mimeType": row["mime_type"],
            "size": row["size"],
            "contentHash": row["content_hash"],
            "sourcePath": row["source_path"],
            "extractedText": row["extracted_text"] if include_text else "",
            "chunkCount": row["chunk_count"],
            "chunks": chunks,
            "milvusCollection": row["milvus_collection"],
            "milvusRecordIds": from_json(row["milvus_record_ids_json"], []),
            "milvusStatus": from_json(row["milvus_status_json"]),
            "createdAt": row["created_at"],
            "updatedAt": row["updated_at"],
        }

    def save_uploaded_document(self, document):
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO uploaded_documents (
                  id, filename, mime_type, size, content_hash, source_path, extracted_text,
                  chunk_count, milvus_collection, milvus_record_ids_json, milvus_status_json,
                  created_at, updated_at, deleted_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
                ON CONFLICT(id) DO UPDATE SET
                  filename = excluded.filename,
                  mime_type = excluded.mime_type,
                  size = excluded.size,
                  content_hash = excluded.content_hash,
                  source_path = excluded.source_path,
                  extracted_text = excluded.extracted_text,
                  chunk_count = excluded.chunk_count,
                  milvus_collection = excluded.milvus_collection,
                  milvus_record_ids_json = excluded.milvus_record_ids_json,
                  milvus_status_json = excluded.milvus_status_json,
                  updated_at = excluded.updated_at,
                  deleted_at = NULL
                """,
                (
                    document["id"],
                    document.get("filename", ""),
                    document.get("mimeType", ""),
                    document.get("size", 0),
                    document.get("contentHash", ""),
                    document.get("sourcePath", ""),
                    document.get("extractedText", ""),
                    document.get("chunkCount", 0),
                    document.get("milvusCollection", ""),
                    to_json(document.get("milvusRecordIds") or []),
                    to_json(document.get("milvusStatus")),
                    document.get("createdAt") or now_iso(),
                    document.get("updatedAt") or now_iso(),
                ),
            )
            self.conn.execute("DELETE FROM document_chunks WHERE document_id = ?", (document["id"],))
            for chunk in document.get("chunks") or []:
                self.conn.execute(
                    """
                    INSERT INTO document_chunks (document_id, chunk_id, chunk_index, text, embedding_json)
                    VALUES (?, ?, ?, ?, ?)
                    """,
                    (
                        document["id"],
                        chunk["id"],
                        chunk.get("index", 0),
                        chunk.get("text", ""),
                        to_json(chunk.get("embedding") or []),
                    ),
                )

    def update_uploaded_document_index(self, document_id, milvus_collection="", milvus_record_ids=None, milvus_status=None):
        document = self.get_uploaded_document(document_id, include_text=True)
        if not document:
            return None
        document.update(
            {
                "milvusCollection": milvus_collection,
                "milvusRecordIds": milvus_record_ids or [],
                "milvusStatus": milvus_status,
                "updatedAt": now_iso(),
            }
        )
        self.save_uploaded_document(document)
        return self.get_uploaded_document(document_id, include_text=True)

    def list_uploaded_documents(self, include_text=False):
        rows = self.conn.execute(
            "SELECT * FROM uploaded_documents WHERE deleted_at IS NULL ORDER BY created_at ASC"
        ).fetchall()
        return [self._document_from_row(row, include_text=include_text) for row in rows]

    def get_uploaded_document(self, document_id, include_text=False):
        row = self.conn.execute(
            "SELECT * FROM uploaded_documents WHERE id = ? AND deleted_at IS NULL",
            (document_id,),
        ).fetchone()
        return self._document_from_row(row, include_text=include_text)

    def delete_uploaded_document(self, document_id):
        timestamp = now_iso()
        with self.conn:
            self.conn.execute(
                "UPDATE uploaded_documents SET deleted_at = ?, updated_at = ? WHERE id = ?",
                (timestamp, timestamp, document_id),
            )

    def list_audit_logs(self, limit=100):
        safe_limit = max(1, min(int(limit or 100), 1000))
        rows = self.conn.execute(
            "SELECT * FROM audit_logs ORDER BY created_at DESC, id DESC LIMIT ?",
            (safe_limit,),
        ).fetchall()
        return [
            {
                "id": row["id"],
                "type": row["type"],
                "sessionId": row["session_id"],
                "documentId": row["document_id"],
                "detail": from_json(row["detail_json"], {}),
                "createdAt": row["created_at"],
            }
            for row in rows
        ]

    def get_setting(self, key, fallback=None):
        row = self.conn.execute("SELECT value_json FROM settings WHERE key = ?", (key,)).fetchone()
        return from_json(row["value_json"], fallback) if row else fallback

    def set_setting(self, key, value):
        with self.conn:
            self.conn.execute(
                """
                INSERT INTO settings (key, value_json, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                  value_json = excluded.value_json,
                  updated_at = excluded.updated_at
                """,
                (key, to_json(value), now_iso()),
            )


def create_runtime_storage(root_dir=None):
    return RuntimeStorage(root_dir=root_dir)

