const http = require("http");
const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");
const { createOrchestrator } = require("./backend/orchestrator");

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, ".env");
const BUNDLED_PYTHON = "/Users/cyc/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3";

function loadEnvFile() {
  if (!fs.existsSync(ENV_FILE)) {
    return;
  }

  const lines = fs.readFileSync(ENV_FILE, "utf8").split(/\r?\n/);
  lines.forEach((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      return;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      return;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

loadEnvFile();

const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || "127.0.0.1";
const LLM_BASE_URL = (process.env.LLM_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, "");
const LLM_MODEL = process.env.LLM_MODEL || "gpt-4.1";
const LLM_API_KEY = process.env.LLM_API_KEY || "";
const LLM_PATH = process.env.LLM_CHAT_COMPLETIONS_PATH || "/chat/completions";
const PYTHON_BIN = process.env.PYTHON_BIN || (fs.existsSync(BUNDLED_PYTHON) ? BUNDLED_PYTHON : "python3");
const MILVUS_DB_PATH = path.resolve(ROOT, process.env.MILVUS_DB_PATH || path.join("data", "milvus_knowledge.db"));
const MILVUS_COLLECTION = process.env.MILVUS_COLLECTION || "szlab_knowledge";
const KNOWLEDGE_SOURCES = [
  {
    id: "hydrogen_excel",
    label: "氢脆 Excel 抽取要求",
    collection: process.env.MILVUS_COLLECTION_HYDROGEN_EXCEL || "kb_hydrogen_excel",
    sourceType: "excel",
    sampleQuery: "yield strength YS σ0.2 Rp0.2",
  },
  {
    id: "samr_standards",
    label: "全国标准信息公共服务平台",
    collection: process.env.MILVUS_COLLECTION_SAMR || "kb_samr_standards",
    sourceType: "web",
    sampleQuery: "国家标准 全文公开 公告",
  },
  {
    id: "material_dictionary",
    label: "材料大辞典第二版",
    collection: process.env.MILVUS_COLLECTION_MATERIAL_DICTIONARY || "kb_material_dictionary",
    sourceType: "markdown_term",
    sampleQuery: "泡沫玻璃 多孔玻璃",
  },
];

const MIME_TYPES = {
  ".html": "text/html;charset=utf-8",
  ".css": "text/css;charset=utf-8",
  ".js": "text/javascript;charset=utf-8",
  ".json": "application/json;charset=utf-8",
  ".txt": "text/plain;charset=utf-8",
};

function normalizeLLMContent(content) {
  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => normalizeLLMContent(item))
      .filter(Boolean)
      .join("\n");
  }

  if (content && typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (typeof content.content === "string") return content.content;
    if (typeof content.value === "string") return content.value;
    if (Array.isArray(content.content)) return normalizeLLMContent(content.content);
    return JSON.stringify(content);
  }

  return content == null ? "" : String(content);
}

async function callLLMProvider({ model, messages, temperature = 0.2, jsonMode = false }) {
  if (!LLM_API_KEY) {
    const error = new Error("LLM_API_KEY is not configured on the server.");
    error.statusCode = 500;
    throw error;
  }

  const payload = {
    model: model || LLM_MODEL,
    messages,
    temperature,
  };

  if (jsonMode) {
    payload.response_format = { type: "json_object" };
  }

  const upstream = await fetch(`${LLM_BASE_URL}${LLM_PATH}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${LLM_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await upstream.text();
  if (!upstream.ok) {
    const error = new Error("LLM provider request failed.");
    error.statusCode = upstream.status;
    error.detail = text.slice(0, 2000);
    throw error;
  }

  const data = JSON.parse(text);
  return {
    content: normalizeLLMContent(data.choices?.[0]?.message?.content),
    model: data.model || payload.model,
    usage: data.usage || null,
  };
}

const orchestrator = createOrchestrator({
  defaultModel: LLM_MODEL,
  callLLM: callLLMProvider,
});
let knowledgeSearchQueue = Promise.resolve();

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, { "Content-Type": "application/json;charset=utf-8" });
  response.end(JSON.stringify(payload));
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        reject(new Error("Request body too large"));
        request.destroy();
      }
    });
    request.on("end", () => resolve(body));
    request.on("error", reject);
  });
}

function getKnowledgeSourceByCollection(collection) {
  return KNOWLEDGE_SOURCES.find((source) => source.collection === collection) || {
    id: collection,
    label: collection,
    collection,
  };
}

function resolveKnowledgeCollections(inputCollections) {
  const requested = Array.isArray(inputCollections) ? inputCollections : [];
  const aliases = new Map(KNOWLEDGE_SOURCES.flatMap((source) => [[source.id, source.collection], [source.collection, source.collection]]));
  const collections = requested
    .map((item) => aliases.get(String(item || "").trim()) || String(item || "").trim())
    .filter(Boolean);
  return [...new Set(collections.length ? collections : KNOWLEDGE_SOURCES.map((source) => source.collection))];
}

function runKnowledgeSearch({ query, collection, limit = 8 }) {
  return new Promise((resolve, reject) => {
    const scriptPath = path.join(ROOT, "scripts", "search_knowledge.py");
    const args = [
      scriptPath,
      query,
      "--limit",
      String(limit),
      "--db-path",
      MILVUS_DB_PATH,
      "--collection",
      collection,
    ];

    execFile(PYTHON_BIN, args, { cwd: ROOT, timeout: 30000, maxBuffer: 1024 * 1024 * 4 }, (error, stdout, stderr) => {
      if (error) {
        const wrapped = new Error("Milvus knowledge search failed.");
        wrapped.statusCode = 500;
        wrapped.detail = `${stderr || ""}${stdout || ""}`.slice(0, 2000);
        reject(wrapped);
        return;
      }

      const source = getKnowledgeSourceByCollection(collection);
      const results = stdout
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => ({
          ...JSON.parse(line),
          knowledge_source_id: source.id,
          knowledge_source_label: source.label,
          collection,
        }));
      resolve(results);
    });
  });
}

function getDbModifiedAt() {
  try {
    return fs.statSync(MILVUS_DB_PATH).mtime.toISOString();
  } catch (_error) {
    return "";
  }
}

function sourceHealthFromStats(source, stats, inspectError = "") {
  const dbExists = fs.existsSync(MILVUS_DB_PATH);
  if (!dbExists) {
    return {
      ...source,
      exists: false,
      rowCount: 0,
      sampleTitles: [],
      sourceTypes: [],
      metadataPreview: [],
      lastUpdated: "",
      health: "missing_db",
      healthLabel: "未入库",
      healthMessage: "Milvus 本地数据库文件尚未创建。",
    };
  }

  if (inspectError) {
    return {
      ...source,
      exists: Boolean(stats?.exists),
      rowCount: stats?.rowCount ?? null,
      sampleTitles: stats?.sampleTitles || [],
      sourceTypes: stats?.sourceTypes || [],
      metadataPreview: stats?.metadataPreview || [],
      lastUpdated: getDbModifiedAt(),
      health: "unknown",
      healthLabel: "待检查",
      healthMessage: inspectError,
    };
  }

  if (!stats?.exists) {
    return {
      ...source,
      exists: false,
      rowCount: 0,
      sampleTitles: [],
      sourceTypes: [],
      metadataPreview: [],
      lastUpdated: getDbModifiedAt(),
      health: "missing_collection",
      healthLabel: "未入库",
      healthMessage: `collection ${source.collection} 尚不存在。`,
    };
  }

  const rowCount = Number(stats.rowCount || 0);
  if (!rowCount) {
    return {
      ...source,
      exists: true,
      rowCount: 0,
      sampleTitles: stats.sampleTitles || [],
      sourceTypes: stats.sourceTypes || [],
      metadataPreview: stats.metadataPreview || [],
      lastUpdated: getDbModifiedAt(),
      health: "empty",
      healthLabel: "空库",
      healthMessage: "collection 已创建，但未检测到知识片段。",
    };
  }

  return {
    ...source,
    exists: true,
    rowCount,
    sampleTitles: stats.sampleTitles || [],
    sourceTypes: stats.sourceTypes || [],
    metadataPreview: stats.metadataPreview || [],
    lastUpdated: getDbModifiedAt(),
    health: "ready",
    healthLabel: "可用",
    healthMessage: `已检测到 ${rowCount} 条知识片段。`,
  };
}

function runKnowledgeInspect() {
  return new Promise((resolve) => {
    const scriptPath = path.join(ROOT, "scripts", "inspect_knowledge.py");
    const args = [scriptPath, "--db-path", MILVUS_DB_PATH, "--sample-limit", "5"];
    KNOWLEDGE_SOURCES.forEach((source) => {
      args.push("--collection", source.collection);
    });

    execFile(PYTHON_BIN, args, { cwd: ROOT, timeout: 30000, maxBuffer: 1024 * 1024 * 2 }, (error, stdout, stderr) => {
      if (error) {
        resolve({
          dbPath: MILVUS_DB_PATH,
          dbExists: fs.existsSync(MILVUS_DB_PATH),
          collections: [],
          error: `${stderr || ""}${stdout || ""}${error.message || ""}`.slice(0, 1200),
        });
        return;
      }

      try {
        resolve(JSON.parse(stdout || "{}"));
      } catch (parseError) {
        resolve({
          dbPath: MILVUS_DB_PATH,
          dbExists: fs.existsSync(MILVUS_DB_PATH),
          collections: [],
          error: `Invalid inspect output: ${parseError.message}`,
        });
      }
    });
  });
}

async function getKnowledgeStatusPayload() {
  const inspect = fs.existsSync(MILVUS_DB_PATH)
    ? await enqueueKnowledgeSearch(() => runKnowledgeInspect())
    : { dbPath: MILVUS_DB_PATH, dbExists: false, collections: [], error: "" };
  const statsByCollection = new Map((inspect.collections || []).map((item) => [item.collection, item]));
  const sources = KNOWLEDGE_SOURCES.map((source) => sourceHealthFromStats(source, statsByCollection.get(source.collection), inspect.error));
  return {
    configured: fs.existsSync(MILVUS_DB_PATH),
    dbPath: MILVUS_DB_PATH,
    dbExists: fs.existsSync(MILVUS_DB_PATH),
    dbModifiedAt: getDbModifiedAt(),
    collection: MILVUS_COLLECTION,
    inspectError: inspect.error || "",
    sources,
  };
}

async function searchKnowledgeCollections({ query, collections, limit }) {
  const perCollectionLimit = Math.max(1, Math.min(Number(limit) || 8, 20));
  const errors = [];
  const results = [];

  for (const collection of collections) {
    try {
      results.push(...(await runKnowledgeSearch({ query, collection, limit: perCollectionLimit })));
    } catch (error) {
      errors.push(error?.detail || error?.message || `search failed: ${collection}`);
    }
  }

  results.sort((a, b) => Number(b.distance || 0) - Number(a.distance || 0));
  return {
    results: results.slice(0, perCollectionLimit),
    errors,
  };
}

function enqueueKnowledgeSearch(task) {
  const run = knowledgeSearchQueue.then(task, task);
  knowledgeSearchQueue = run.catch(() => {});
  return run;
}

function serveStatic(request, response) {
  const requestUrl = new URL(request.url, `http://${request.headers.host}`);
  const pathname = decodeURIComponent(requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname);
  const filePath = path.normalize(path.join(ROOT, pathname));

  if (!filePath.startsWith(ROOT)) {
    response.writeHead(403);
    response.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      response.writeHead(404);
      response.end("Not found");
      return;
    }

    response.writeHead(200, {
      "Content-Type": MIME_TYPES[path.extname(filePath)] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    response.end(content);
  });
}

async function handleLLM(request, response) {
  try {
    const body = JSON.parse(await readRequestBody(request));
    const messages = Array.isArray(body.messages) ? body.messages : [];
    if (!messages.length) {
      sendJson(response, 400, { error: "messages is required." });
      return;
    }

    const result = await callLLMProvider({
      model: body.model || LLM_MODEL,
      messages,
      temperature: typeof body.temperature === "number" ? body.temperature : 0.2,
      jsonMode: Boolean(body.jsonMode),
    });

    sendJson(response, 200, result);
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      error: error.message || "Unexpected LLM proxy error.",
      detail: error.detail,
    });
  }
}

async function handleKnowledge(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);

  try {
    if (request.method === "GET" && url.pathname === "/api/knowledge/status") {
      sendJson(response, 200, await getKnowledgeStatusPayload());
      return;
    }

    if (request.method === "POST" && url.pathname === "/api/knowledge/search") {
      const body = JSON.parse(await readRequestBody(request));
      const query = String(body.query || "").trim();
      if (!query) {
        sendJson(response, 400, { error: "query is required." });
        return;
      }
      if (!fs.existsSync(MILVUS_DB_PATH)) {
        sendJson(response, 404, { error: "Milvus knowledge database not found.", dbPath: MILVUS_DB_PATH });
        return;
      }
      const limit = Math.max(1, Math.min(Number(body.limit) || 8, 20));
      const collections = resolveKnowledgeCollections(body.collections);
        const { results, errors } = await enqueueKnowledgeSearch(() => searchKnowledgeCollections({ query, collections, limit }));
      sendJson(response, 200, {
        query,
        count: results.length,
        dbPath: MILVUS_DB_PATH,
        collections,
        errors,
        results,
      });
      return;
    }

    sendJson(response, 404, { error: "knowledge route not found." });
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      error: error.message || "Unexpected knowledge search error.",
      detail: error.detail,
    });
  }
}

async function handleOrchestrator(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const parts = url.pathname.split("/").filter(Boolean);

  try {
    if (request.method === "POST" && url.pathname === "/api/orchestrator/sessions") {
      const body = JSON.parse(await readRequestBody(request));
      sendJson(response, 200, await orchestrator.createSession(body));
      return;
    }

    if (request.method === "GET" && parts.length === 4 && parts[0] === "api" && parts[1] === "orchestrator" && parts[2] === "sessions") {
      sendJson(response, 200, orchestrator.getSession(parts[3]));
      return;
    }

    if (request.method === "POST" && parts.length === 5 && parts[0] === "api" && parts[1] === "orchestrator" && parts[2] === "sessions" && parts[4] === "answers") {
      const body = JSON.parse(await readRequestBody(request));
      sendJson(response, 200, orchestrator.submitAnswer(parts[3], body));
      return;
    }

    if (request.method === "POST" && parts.length === 5 && parts[0] === "api" && parts[1] === "orchestrator" && parts[2] === "sessions" && parts[4] === "navigate") {
      const body = JSON.parse(await readRequestBody(request));
      sendJson(response, 200, orchestrator.navigateSession(parts[3], body));
      return;
    }

    if (request.method === "POST" && parts.length === 5 && parts[0] === "api" && parts[1] === "orchestrator" && parts[2] === "sessions" && parts[4] === "finalize") {
      const body = JSON.parse(await readRequestBody(request));
      sendJson(response, 200, await orchestrator.finalizeSession(parts[3], body));
      return;
    }

    sendJson(response, 404, { error: "orchestrator route not found." });
  } catch (error) {
    sendJson(response, error.statusCode || 500, {
      error: error.message || "Unexpected orchestrator error.",
      detail: error.detail,
    });
  }
}

const server = http.createServer((request, response) => {
  if (request.method === "GET" && request.url.startsWith("/api/health")) {
    sendJson(response, 200, {
      llmConfigured: Boolean(LLM_API_KEY),
      model: LLM_MODEL,
      baseUrl: LLM_BASE_URL,
      knowledgeConfigured: fs.existsSync(MILVUS_DB_PATH),
      knowledgeCollection: MILVUS_COLLECTION,
      knowledgeSources: KNOWLEDGE_SOURCES,
    });
    return;
  }

  if (request.method === "POST" && request.url.startsWith("/api/llm")) {
    handleLLM(request, response);
    return;
  }

  if (request.url.startsWith("/api/orchestrator")) {
    handleOrchestrator(request, response);
    return;
  }

  if (request.url.startsWith("/api/knowledge")) {
    handleKnowledge(request, response);
    return;
  }

  if (request.method === "GET") {
    serveStatic(request, response);
    return;
  }

  response.writeHead(405);
  response.end("Method not allowed");
});

server.listen(PORT, HOST, () => {
  console.log(`RAG prompt workstation: http://${HOST}:${PORT}`);
  console.log(`LLM proxy: ${LLM_API_KEY ? "enabled" : "disabled, set LLM_API_KEY to enable"}`);
});

server.on("error", (error) => {
  if (error.code === "EADDRINUSE") {
    console.error(`Port ${PORT} is already in use. Set PORT=8081 or stop the existing process.`);
    process.exit(1);
  }

  if (error.code === "EACCES" || error.code === "EPERM") {
    console.error(`Cannot bind to ${HOST}:${PORT}. Try another PORT or check local permissions.`);
    process.exit(1);
  }

  throw error;
});
