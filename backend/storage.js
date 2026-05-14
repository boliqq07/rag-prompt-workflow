const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function toJson(value) {
  return JSON.stringify(value == null ? null : value);
}

function fromJson(value, fallback = null) {
  if (value == null || value === "") return fallback;
  return JSON.parse(value);
}

function createRuntimeStorage({ rootDir } = {}) {
  const baseDir = path.resolve(rootDir || path.join(process.cwd(), "data", "runtime"));
  const sourceFilesDir = path.join(baseDir, "upload_sources");
  ensureDir(baseDir);
  ensureDir(sourceFilesDir);

  const dbPath = path.join(baseDir, "runtime.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec(`
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
  `);

  const saveSessionStmt = db.prepare(`
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
  `);
  const deleteAnswersStmt = db.prepare("DELETE FROM answers WHERE session_id = ?");
  const insertAnswerStmt = db.prepare(`
    INSERT INTO answers (session_id, question_id, answer_json, custom_answer, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const loadSessionStmt = db.prepare("SELECT payload_json FROM sessions WHERE id = ? AND id IS NOT NULL");
  const listSessionsStmt = db.prepare(`
    SELECT id, prompt, workflow, source_mode, model, scenario_json, final_prompt, created_at, updated_at
    FROM sessions
    ORDER BY updated_at DESC
    LIMIT ?
  `);
  const appendVersionStmt = db.prepare(`
    INSERT INTO prompt_versions (
      version_id, session_id, workflow, source_mode, prompt_mode, prompt_source_json,
      prompt, knowledge, knowledge_profile_json, answers_json, custom_answers_json,
      auto_answers_json, refinements_json, final_prompt, created_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const listVersionsStmt = db.prepare(`
    SELECT *
    FROM prompt_versions
    WHERE session_id = ?
    ORDER BY created_at DESC
  `);
  const appendAuditStmt = db.prepare(`
    INSERT INTO audit_logs (type, session_id, document_id, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  const saveDocumentStmt = db.prepare(`
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
  `);
  const deleteChunksStmt = db.prepare("DELETE FROM document_chunks WHERE document_id = ?");
  const insertChunkStmt = db.prepare(`
    INSERT INTO document_chunks (document_id, chunk_id, chunk_index, text, embedding_json)
    VALUES (?, ?, ?, ?, ?)
  `);
  const listDocumentsStmt = db.prepare(`
    SELECT *
    FROM uploaded_documents
    WHERE deleted_at IS NULL
    ORDER BY created_at ASC
  `);
  const getDocumentStmt = db.prepare("SELECT * FROM uploaded_documents WHERE id = ? AND deleted_at IS NULL");
  const listChunksStmt = db.prepare(`
    SELECT *
    FROM document_chunks
    WHERE document_id = ?
    ORDER BY chunk_index ASC
  `);
  const markDocumentDeletedStmt = db.prepare("UPDATE uploaded_documents SET deleted_at = ?, updated_at = ? WHERE id = ?");
  const listAuditStmt = db.prepare(`
    SELECT *
    FROM audit_logs
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `);

  function saveSession(session) {
    const updatedAt = session.updatedAt || new Date().toISOString();
    db.exec("BEGIN");
    try {
      saveSessionStmt.run(
        session.id,
        session.prompt || "",
        session.workflow || "",
        session.sourceMode || "",
        session.model || "",
        toJson(session.scenario || null),
        session.finalPrompt || "",
        toJson(session),
        session.createdAt || updatedAt,
        updatedAt
      );
      deleteAnswersStmt.run(session.id);
      Object.entries(session.answers || {}).forEach(([questionId, answer]) => {
        insertAnswerStmt.run(session.id, questionId, toJson(answer), session.customAnswers?.[questionId] || "", updatedAt);
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function loadSession(id) {
    const row = loadSessionStmt.get(id);
    return row ? fromJson(row.payload_json) : null;
  }

  function listSessions(limit = 100) {
    return listSessionsStmt.all(Math.max(1, Math.min(Number(limit) || 100, 500))).map((row) => ({
      id: row.id,
      prompt: row.prompt,
      workflow: row.workflow,
      sourceMode: row.source_mode,
      model: row.model,
      scenario: fromJson(row.scenario_json),
      finalPrompt: row.final_prompt,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  function appendPromptVersion(version) {
    appendVersionStmt.run(
      version.versionId,
      version.sessionId,
      version.workflow,
      version.sourceMode,
      version.promptMode,
      toJson(version.promptSource || null),
      version.prompt || "",
      version.knowledge || "",
      toJson(version.knowledgeProfile || null),
      toJson(version.answers || {}),
      toJson(version.customAnswers || {}),
      toJson(version.autoAnswers || {}),
      toJson(version.refinements || []),
      version.finalPrompt || "",
      version.createdAt || new Date().toISOString()
    );
  }

  function listPromptVersions(sessionId) {
    return listVersionsStmt.all(sessionId).map((row) => ({
      versionId: row.version_id,
      sessionId: row.session_id,
      workflow: row.workflow,
      sourceMode: row.source_mode,
      promptMode: row.prompt_mode,
      promptSource: fromJson(row.prompt_source_json),
      prompt: row.prompt,
      knowledge: row.knowledge,
      knowledgeProfile: fromJson(row.knowledge_profile_json),
      answers: fromJson(row.answers_json, {}),
      customAnswers: fromJson(row.custom_answers_json, {}),
      autoAnswers: fromJson(row.auto_answers_json, {}),
      refinements: fromJson(row.refinements_json, []),
      finalPrompt: row.final_prompt,
      createdAt: row.created_at,
    }));
  }

  function appendAudit(event) {
    appendAuditStmt.run(
      event.type || "event",
      event.sessionId || null,
      event.documentId || null,
      toJson(event.detail || {}),
      event.createdAt || new Date().toISOString()
    );
  }

  function documentFromRow(row, includeText = false) {
    if (!row) return null;
    const chunks = listChunksStmt.all(row.id).map((chunk) => ({
      id: chunk.chunk_id,
      index: chunk.chunk_index,
      text: chunk.text,
      embedding: fromJson(chunk.embedding_json, []),
    }));
    return {
      id: row.id,
      filename: row.filename,
      mimeType: row.mime_type,
      size: row.size,
      contentHash: row.content_hash,
      sourcePath: row.source_path,
      extractedText: includeText ? row.extracted_text : "",
      chunkCount: row.chunk_count,
      chunks,
      milvusCollection: row.milvus_collection,
      milvusRecordIds: fromJson(row.milvus_record_ids_json, []),
      milvusStatus: fromJson(row.milvus_status_json, null),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  function saveUploadedDocument(document) {
    db.exec("BEGIN");
    try {
      saveDocumentStmt.run(
        document.id,
        document.filename,
        document.mimeType || "",
        document.size,
        document.contentHash,
        document.sourcePath || "",
        document.extractedText || "",
        document.chunkCount,
        document.milvusCollection || "",
        toJson(document.milvusRecordIds || []),
        toJson(document.milvusStatus || null),
        document.createdAt,
        document.updatedAt
      );
      deleteChunksStmt.run(document.id);
      (document.chunks || []).forEach((chunk) => {
        insertChunkStmt.run(document.id, chunk.id, chunk.index, chunk.text, toJson(chunk.embedding || []));
      });
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function updateUploadedDocumentIndex(documentId, { milvusCollection = "", milvusRecordIds = [], milvusStatus = null } = {}) {
    const document = getUploadedDocument(documentId, true);
    if (!document) return null;
    saveUploadedDocument({
      ...document,
      milvusCollection,
      milvusRecordIds,
      milvusStatus,
      updatedAt: new Date().toISOString(),
    });
    return getUploadedDocument(documentId, true);
  }

  function listUploadedDocuments(options = {}) {
    return listDocumentsStmt.all().map((row) => documentFromRow(row, Boolean(options.includeText)));
  }

  function getUploadedDocument(id, includeText = false) {
    return documentFromRow(getDocumentStmt.get(id), includeText);
  }

  function deleteUploadedDocument(id) {
    const now = new Date().toISOString();
    markDocumentDeletedStmt.run(now, now, id);
  }

  function listAuditLogs(limit = 100) {
    return listAuditStmt.all(Math.max(1, Math.min(Number(limit) || 100, 1000))).map((row) => ({
      id: row.id,
      type: row.type,
      sessionId: row.session_id,
      documentId: row.document_id,
      detail: fromJson(row.detail_json, {}),
      createdAt: row.created_at,
    }));
  }

  return {
    baseDir,
    dbPath,
    sourceFilesDir,
    saveSession,
    loadSession,
    listSessions,
    appendPromptVersion,
    listPromptVersions,
    appendAudit,
    listAuditLogs,
    saveUploadedDocument,
    updateUploadedDocumentIndex,
    listUploadedDocuments,
    getUploadedDocument,
    deleteUploadedDocument,
  };
}

module.exports = {
  createRuntimeStorage,
};
