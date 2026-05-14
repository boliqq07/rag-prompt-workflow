const fs = require("fs");
const path = require("path");

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJson(filePath, payload) {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}

function readJson(filePath, fallback = null) {
  if (!fs.existsSync(filePath)) return fallback;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function appendJsonl(filePath, payload) {
  ensureDir(path.dirname(filePath));
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function listJsonFiles(dirPath) {
  if (!fs.existsSync(dirPath)) return [];
  return fs
    .readdirSync(dirPath)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => path.join(dirPath, name));
}

function createRuntimeStorage({ rootDir } = {}) {
  const baseDir = path.resolve(rootDir || path.join(process.cwd(), "data", "runtime"));
  const sessionsDir = path.join(baseDir, "sessions");
  const uploadsDir = path.join(baseDir, "uploads");
  const promptVersionsDir = path.join(baseDir, "prompt_versions");
  const auditLogPath = path.join(baseDir, "audit.log.jsonl");

  function saveSession(session) {
    writeJson(path.join(sessionsDir, `${session.id}.json`), session);
  }

  function loadSession(id) {
    return readJson(path.join(sessionsDir, `${id}.json`));
  }

  function listSessions() {
    return listJsonFiles(sessionsDir)
      .map((filePath) => readJson(filePath))
      .filter(Boolean)
      .map((session) => ({
        id: session.id,
        prompt: session.prompt,
        workflow: session.workflow,
        sourceMode: session.sourceMode,
        model: session.model,
        scenario: session.scenario,
        questionSource: session.questionSource,
        promptSource: session.promptSource,
        finalPrompt: session.finalPrompt,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
      }))
      .sort((left, right) => String(right.updatedAt || "").localeCompare(String(left.updatedAt || "")));
  }

  function appendPromptVersion(version) {
    appendJsonl(path.join(promptVersionsDir, `${version.sessionId}.jsonl`), version);
  }

  function listPromptVersions(sessionId) {
    const filePath = path.join(promptVersionsDir, `${sessionId}.jsonl`);
    if (!fs.existsSync(filePath)) return [];
    return fs
      .readFileSync(filePath, "utf8")
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  function appendAudit(event) {
    appendJsonl(auditLogPath, {
      ...event,
      createdAt: event.createdAt || new Date().toISOString(),
    });
  }

  function saveUploadedDocument(document) {
    writeJson(path.join(uploadsDir, `${document.id}.json`), document);
  }

  function listUploadedDocuments() {
    return listJsonFiles(uploadsDir).map((filePath) => readJson(filePath)).filter(Boolean);
  }

  return {
    baseDir,
    sessionsDir,
    uploadsDir,
    promptVersionsDir,
    auditLogPath,
    saveSession,
    loadSession,
    listSessions,
    appendPromptVersion,
    listPromptVersions,
    appendAudit,
    saveUploadedDocument,
    listUploadedDocuments,
  };
}

module.exports = {
  createRuntimeStorage,
};
