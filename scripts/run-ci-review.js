#!/usr/bin/env node
"use strict";

const { spawn } = require("child_process");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const PORT = String(process.env.CI_REVIEW_PORT || 18080);
const BASE_URL = `http://127.0.0.1:${PORT}`;

function runNode(args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: "inherit",
      ...options,
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${process.execPath} ${args.join(" ")} exited with ${code}`));
    });
  });
}

async function waitForHealth(timeoutMs = 15000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(`${BASE_URL}/api/health`);
      if (response.ok) return;
      lastError = new Error(`health returned ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  throw new Error(`Server did not become healthy at ${BASE_URL}: ${lastError?.message || "timeout"}`);
}

async function assertKnowledgeStatus() {
  const response = await fetch(`${BASE_URL}/api/knowledge/status`);
  if (!response.ok) {
    throw new Error(`knowledge status returned ${response.status}`);
  }
  const payload = await response.json();
  if (!Array.isArray(payload.sources) || payload.sources.length < 3) {
    throw new Error("knowledge status did not return the configured knowledge sources");
  }
  for (const source of payload.sources) {
    if (!source.id || !source.collection || !source.health || !source.healthLabel) {
      throw new Error(`knowledge source status is incomplete: ${JSON.stringify(source)}`);
    }
  }
}

async function postJson(pathname, payload) {
  const response = await fetch(`${BASE_URL}${pathname}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${pathname} returned ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

async function getJson(pathname) {
  const response = await fetch(`${BASE_URL}${pathname}`);
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${pathname} returned ${response.status}: ${text}`);
  }
  return JSON.parse(text);
}

async function assertUploadPersistenceFlow() {
  const upload = await postJson("/api/knowledge/uploads", {
    filename: "ci-upload-evidence.md",
    content:
      "yield strength、YS、σ0.2、Rp0.2 表示屈服强度字段，可作为同义/别名合并到 yield strength name。\n\npre-strain rate 为预应变速率，不能与 strength loss ratio 合并。",
  });
  if (!upload.uploaded?.[0]?.id || !upload.uploaded?.[0]?.chunkCount) {
    throw new Error(`upload did not return a stored document: ${JSON.stringify(upload)}`);
  }

  const search = await postJson("/api/knowledge/search", {
    query: "yield strength Rp0.2 pre-strain rate",
    collections: ["uploaded_documents"],
    limit: 3,
  });
  if (!search.results?.some((result) => String(result.text || "").includes("yield strength"))) {
    throw new Error("uploaded document was not retrievable from the uploaded_documents source");
  }

  let session = await postJson("/api/orchestrator/sessions", {
    prompt: "请做字段同义词合并，严格合并 yield strength、YS、σ0.2、Rp0.2；pre-strain rate 不能与 strength loss ratio 合并；输出 JSON 数组，保留证据原文、关系类型、不合并原因和人工复核标记。",
    workflow: "synonym_merge",
    sourceMode: "rag",
    questionMode: "local",
    knowledge: search.results.map((result) => result.text).join("\n\n"),
  });
  const answered = new Set();
  for (let index = 0; index < 8; index += 1) {
    const question = session.currentQuestion;
    if (!question || answered.has(question.id)) break;
    answered.add(question.id);
    let answer = "";
    if (question.id === "candidate_terms") {
      answer = (question.options || [])
        .filter((option) => /yield strength|YS|σ0\.2|Rp0\.2|pre-strain|strength loss/i.test(String(option.value)))
        .map((option) => option.value);
    } else if (question.id === "synonym_groups") {
      answer = (question.options || []).filter((option) => option.autoSelect && !option.disabled).map((option) => option.value);
    } else if (question.type === "multi") {
      answer = (question.options || []).slice(0, 2).map((option) => option.value);
    } else if (question.type === "text") {
      answer = "保留 canonical_name、aliases、evidence_type 和 do_not_merge。";
    } else {
      answer = (question.options || [])[0]?.value || "";
    }
    session = await postJson(`/api/orchestrator/sessions/${session.id}/answers`, {
      questionId: question.id,
      answer,
      customAnswer: "",
    });
  }
  const finalized = await postJson(`/api/orchestrator/sessions/${session.id}/finalize`, { promptMode: "local" });
  if (!String(finalized.finalPrompt || "").includes("yield strength name")) {
    throw new Error("free-text evidence did not reach the final prompt");
  }

  const versions = await getJson(`/api/orchestrator/sessions/${session.id}/prompt-versions`);
  if (!versions.versions?.length) {
    throw new Error("prompt version was not persisted");
  }
  const sessions = await getJson("/api/orchestrator/sessions");
  if (!sessions.sessions?.some((item) => item.id === session.id)) {
    throw new Error("session was not persisted in the session list");
  }
  const audit = await getJson("/api/knowledge/audit-logs?limit=20");
  if (!audit.events?.some((event) => event.type === "upload_document")) {
    throw new Error("upload audit event was not persisted");
  }
}

async function main() {
  const server = spawn(process.execPath, ["server.js"], {
    cwd: ROOT,
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT,
      LLM_API_KEY: process.env.LLM_API_KEY || "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  server.stdout.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));
  server.stderr.on("data", (chunk) => process.stderr.write(`[server] ${chunk}`));

  let serverExit = null;
  server.on("exit", (code, signal) => {
    serverExit = { code, signal };
  });

  try {
    await waitForHealth();
    if (serverExit) {
      throw new Error(`Server exited early: ${JSON.stringify(serverExit)}`);
    }
    await assertKnowledgeStatus();
    await assertUploadPersistenceFlow();
    await runNode([
      "scripts/evaluate-workflows.js",
      "--base-url",
      BASE_URL,
      "--fixtures",
      "all",
      "--out-dir",
      path.join("reports", "ci"),
      "--min-score",
      "100",
    ]);
  } finally {
    if (!serverExit) {
      server.kill("SIGTERM");
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
