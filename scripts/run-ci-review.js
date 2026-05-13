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
