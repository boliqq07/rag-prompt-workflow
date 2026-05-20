import base64
import hashlib
import json
import math
import mimetypes
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from backend.orchestrator import create_orchestrator
from backend.storage import create_runtime_storage, now_iso


ROOT = Path(__file__).resolve().parent
ENV_FILE = ROOT / ".env"
BUNDLED_PYTHON = Path("/Users/cyc/.cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3")


def load_env_file():
    if not ENV_FILE.exists():
        return
    for raw_line in ENV_FILE.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip("\"'"))


load_env_file()

HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8080"))
PYTHON_BIN = os.environ.get("PYTHON_BIN") or (str(BUNDLED_PYTHON) if BUNDLED_PYTHON.exists() else sys.executable)
RUNTIME_STORE_DIR = (ROOT / os.environ.get("RUNTIME_STORE_DIR", "data/runtime")).resolve()
MILVUS_DB_PATH = (ROOT / os.environ.get("MILVUS_DB_PATH", "data/milvus_knowledge.db")).resolve()
MILVUS_COLLECTION = os.environ.get("MILVUS_COLLECTION", "szlab_knowledge")
MILVUS_COLLECTION_UPLOADS = os.environ.get("MILVUS_COLLECTION_UPLOADS", "kb_uploaded_documents")
LOCAL_UPLOAD_COLLECTION = "local_uploaded_documents"

MILVUS_KNOWLEDGE_SOURCES = [
    {
        "id": "hydrogen_excel",
        "label": "氢脆 Excel 抽取要求",
        "collection": os.environ.get("MILVUS_COLLECTION_HYDROGEN_EXCEL", "kb_hydrogen_excel"),
        "sourceType": "excel",
        "sampleQuery": "yield strength YS σ0.2 Rp0.2",
    },
    {
        "id": "samr_standards",
        "label": "全国标准信息公共服务平台",
        "collection": os.environ.get("MILVUS_COLLECTION_SAMR", "kb_samr_standards"),
        "sourceType": "web",
        "sampleQuery": "国家标准 全文公开 公告",
    },
    {
        "id": "material_dictionary",
        "label": "材料大辞典第二版",
        "collection": os.environ.get("MILVUS_COLLECTION_MATERIAL_DICTIONARY", "kb_material_dictionary"),
        "sourceType": "markdown_term",
        "sampleQuery": "泡沫玻璃 多孔玻璃",
    },
]
UPLOADED_KNOWLEDGE_SOURCE = {
    "id": "uploaded_documents",
    "label": "上传文档",
    "collection": MILVUS_COLLECTION_UPLOADS,
    "sourceType": "uploaded_file",
    "backend": "milvus_with_local_fallback",
    "sampleQuery": "从上传文档中检索术语、标准或证据句",
}
KNOWLEDGE_SOURCES = [*MILVUS_KNOWLEDGE_SOURCES, UPLOADED_KNOWLEDGE_SOURCE]

runtime_storage = create_runtime_storage(root_dir=RUNTIME_STORE_DIR)

runtime_config = {
    "llmBaseUrl": os.environ.get("LLM_BASE_URL", "https://api.openai.com/v1").rstrip("/"),
    "llmModel": os.environ.get("LLM_MODEL", "gpt-4.1"),
    "llmApiKey": os.environ.get("LLM_API_KEY", ""),
    "llmPath": os.environ.get("LLM_CHAT_COMPLETIONS_PATH", "/chat/completions"),
}
saved_llm_config = runtime_storage.get_setting("llm_config", None)
if isinstance(saved_llm_config, dict):
    runtime_config["llmBaseUrl"] = str(saved_llm_config.get("baseUrl") or runtime_config["llmBaseUrl"]).rstrip("/")
    runtime_config["llmModel"] = str(saved_llm_config.get("model") or runtime_config["llmModel"]).strip() or runtime_config["llmModel"]
    path_value = str(saved_llm_config.get("path") or runtime_config["llmPath"]).strip()
    runtime_config["llmPath"] = path_value if path_value.startswith("/") else f"/{path_value}"
    runtime_config["llmApiKey"] = str(saved_llm_config.get("apiKey") or runtime_config["llmApiKey"])


def normalize_llm_content(content):
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join([normalize_llm_content(item) for item in content if item is not None])
    if isinstance(content, dict):
        if isinstance(content.get("text"), str):
            return content["text"]
        if isinstance(content.get("content"), str):
            return content["content"]
        if isinstance(content.get("value"), str):
            return content["value"]
        return json.dumps(content, ensure_ascii=False)
    return "" if content is None else str(content)


def call_llm_provider(model=None, messages=None, temperature=0.2, json_mode=False):
    if not runtime_config["llmApiKey"]:
        raise RuntimeError("LLM_API_KEY is not configured on the server.")
    payload = {"model": model or runtime_config["llmModel"], "messages": messages or [], "temperature": temperature}
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        f"{runtime_config['llmBaseUrl']}{runtime_config['llmPath']}",
        data=body,
        method="POST",
        headers={"Authorization": f"Bearer {runtime_config['llmApiKey']}", "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            data = json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", errors="replace")[:2000]
        raise RuntimeError(f"LLM provider request failed: {detail}") from error
    return {
        "content": normalize_llm_content(((data.get("choices") or [{}])[0].get("message") or {}).get("content")),
        "model": data.get("model") or payload["model"],
        "usage": data.get("usage"),
    }


orchestrator = create_orchestrator(default_model=runtime_config["llmModel"], storage=runtime_storage, call_llm=call_llm_provider)


def api_key_preview(value):
    key = str(value or "")
    if not key:
        return ""
    if len(key) <= 8:
        return "********"
    return f"{key[:4]}...{key[-4:]}"


def exec_python_json(args, timeout=60):
    completed = subprocess.run([PYTHON_BIN, *map(str, args)], cwd=ROOT, text=True, capture_output=True, timeout=timeout)
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout or "Python command failed.")[:3000])
    lines = [line.strip() for line in completed.stdout.splitlines() if line.strip()]
    return json.loads(lines[-1]) if lines else {}


def exec_python_text(args, timeout=60):
    completed = subprocess.run([PYTHON_BIN, *map(str, args)], cwd=ROOT, text=True, capture_output=True, timeout=timeout)
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout or "Python text extraction failed.")[:3000])
    return completed.stdout.strip()


def safe_upload_filename(filename):
    base = Path(str(filename or "uploaded-document.txt")).name
    base = re.sub(r"[^\w.\-\u4e00-\u9fff]+", "_", base)
    return (base or "uploaded-document.txt")[:180]


def upload_buffer_from_payload(file_payload):
    data_base64 = file_payload.get("dataBase64")
    if isinstance(data_base64, str) and data_base64:
        return base64.b64decode(data_base64)
    return str(file_payload.get("content") or "").encode("utf-8")


def tokenize_for_vector(text):
    normalized = str(text or "").lower()
    latin_tokens = re.findall(r"[a-z0-9_.%+\-]{2,}", normalized)
    chinese_text = re.sub(r"[^\u4e00-\u9fff]", "", normalized)
    chinese_tokens = []
    for index, char in enumerate(chinese_text):
        chinese_tokens.append(char)
        if index < len(chinese_text) - 1:
            chinese_tokens.append(chinese_text[index : index + 2])
    return [*latin_tokens, *chinese_tokens]


def make_hash_embedding(text, dimensions=128):
    vector = [0.0] * dimensions
    for token in tokenize_for_vector(text):
        digest = hashlib.sha1(token.encode("utf-8")).digest()
        hashed = int.from_bytes(digest[:4], "big")
        vector[hashed % dimensions] += 1 if hashed % 2 == 0 else -1
    norm = math.sqrt(sum(value * value for value in vector)) or 1
    return [round(value / norm, 6) for value in vector]


def cosine_similarity(left, right):
    if not isinstance(left, list) or not isinstance(right, list) or len(left) != len(right):
        return 0
    return sum(float(value) * float(right[index] or 0) for index, value in enumerate(left))


def lexical_overlap_score(query, text):
    query_tokens = set(tokenize_for_vector(query))
    if not query_tokens:
        return 0
    text_tokens = set(tokenize_for_vector(text))
    return len([token for token in query_tokens if token in text_tokens]) / len(query_tokens)


def chunk_uploaded_text(text, chunk_size=900, overlap=140):
    cleaned = str(text or "").replace("\r\n", "\n").strip()
    if not cleaned:
        return []
    paragraphs = [item.strip() for item in re.split(r"\n{2,}", cleaned) if item.strip()]
    chunks = []
    buffer = ""

    def flush():
        nonlocal buffer
        value = buffer.strip()
        if value:
            chunks.append(value)
            buffer = value[-overlap:] if overlap > 0 else ""

    for paragraph in paragraphs:
        if not buffer:
            buffer = paragraph
            if len(buffer) >= chunk_size:
                flush()
            continue
        if len(f"{buffer}\n\n{paragraph}") > chunk_size:
            flush()
        buffer = f"{buffer}\n\n{paragraph}" if buffer else paragraph
        while len(buffer) > chunk_size * 1.4:
            chunks.append(buffer[:chunk_size])
            buffer = buffer[chunk_size - overlap :]
    flush()
    return chunks


def extract_uploaded_text(filename, buffer, content=""):
    if content:
        text = str(content).strip()
        if text:
            return {"text": text, "sourcePath": ""}
    temp_path = runtime_storage.source_files_dir / f"{uuid.uuid4()}-{safe_upload_filename(filename)}"
    temp_path.write_bytes(buffer)
    text = exec_python_text([ROOT / "scripts" / "extract_upload_text.py", temp_path], timeout=90)
    if not text.strip():
        raise ValueError("uploaded file did not contain extractable text.")
    return {"text": text, "sourcePath": str(temp_path)}


def build_uploaded_document(filename, extracted_text, mime_type="text/plain", source_path=""):
    text = str(extracted_text or "").strip()
    if not text:
        raise ValueError("uploaded file content is empty.")
    document_id = str(uuid.uuid4())
    timestamp = now_iso()
    chunks = [
        {"id": f"{document_id}#{index + 1}", "index": index, "text": chunk, "embedding": make_hash_embedding(chunk)}
        for index, chunk in enumerate(chunk_uploaded_text(text))
    ]
    if not chunks:
        raise ValueError("uploaded file produced no searchable chunks.")
    return {
        "id": document_id,
        "filename": str(filename or "uploaded-document.txt")[:180],
        "mimeType": mime_type,
        "size": len(text.encode("utf-8")),
        "contentHash": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "sourcePath": source_path,
        "extractedText": text,
        "chunkCount": len(chunks),
        "chunks": chunks,
        "milvusCollection": MILVUS_COLLECTION_UPLOADS,
        "milvusRecordIds": [],
        "milvusStatus": None,
        "createdAt": timestamp,
        "updatedAt": timestamp,
    }


def index_uploaded_document_to_milvus(document):
    text_path = runtime_storage.source_files_dir / f"{document['id']}.txt"
    text_path.write_text(document["extractedText"], encoding="utf-8")
    return exec_python_json(
        [
            ROOT / "scripts" / "index_uploaded_document.py",
            "--text-file",
            text_path,
            "--document-id",
            document["id"],
            "--filename",
            document["filename"],
            "--content-hash",
            document["contentHash"],
            "--db-path",
            MILVUS_DB_PATH,
            "--collection",
            MILVUS_COLLECTION_UPLOADS,
            "--embedding-mode",
            os.environ.get("EMBEDDING_MODE", "hash"),
            "--embedding-dim",
            os.environ.get("EMBEDDING_DIM", "384"),
        ],
        timeout=120,
    )


def delete_uploaded_document_from_milvus(document):
    ids = document.get("milvusRecordIds") or []
    if not ids:
        return {"deleted": 0, "collection": MILVUS_COLLECTION_UPLOADS}
    return exec_python_json(
        [
            ROOT / "scripts" / "delete_uploaded_document.py",
            "--ids-json",
            json.dumps(ids, ensure_ascii=False),
            "--db-path",
            MILVUS_DB_PATH,
            "--collection",
            document.get("milvusCollection") or MILVUS_COLLECTION_UPLOADS,
        ]
    )


def run_uploaded_knowledge_search(query, limit=8):
    query_embedding = make_hash_embedding(query)
    query_tokens = set(tokenize_for_vector(query))
    results = []
    for document in runtime_storage.list_uploaded_documents():
        for chunk in document.get("chunks") or []:
            vector_score = cosine_similarity(query_embedding, chunk.get("embedding"))
            lexical_score = lexical_overlap_score(query, chunk.get("text"))
            score = max(0, vector_score) * 0.72 + lexical_score * 0.28
            text_tokens = set(tokenize_for_vector(chunk.get("text")))
            matched_terms = [token for token in query_tokens if token in text_tokens][:12]
            results.append(
                {
                    "id": chunk["id"],
                    "title": f"{document['filename']} · 片段 {chunk['index'] + 1}",
                    "text": chunk["text"],
                    "source_type": "uploaded_file",
                    "source_uri": f"upload://{document['id']}/{document['filename']}",
                    "metadata_json": json.dumps({"document_id": document["id"], "filename": document["filename"], "chunk_index": chunk["index"], "content_hash": document["contentHash"]}, ensure_ascii=False),
                    "distance": round(score, 6),
                    "vector_distance": round(vector_score, 6),
                    "rerank_score": round(score, 6),
                    "match_reasons": [f"词面命中：{'、'.join(matched_terms)}"] if matched_terms else ["哈希向量相似"],
                    "knowledge_source_id": UPLOADED_KNOWLEDGE_SOURCE["id"],
                    "knowledge_source_label": UPLOADED_KNOWLEDGE_SOURCE["label"],
                    "collection": LOCAL_UPLOAD_COLLECTION,
                }
            )
    return sorted(results, key=lambda item: float(item.get("distance") or 0), reverse=True)[:limit]


def get_db_modified_at():
    return datetime_from_timestamp(MILVUS_DB_PATH.stat().st_mtime) if MILVUS_DB_PATH.exists() else ""


def datetime_from_timestamp(timestamp):
    from datetime import datetime, timezone

    return datetime.fromtimestamp(timestamp, timezone.utc).isoformat().replace("+00:00", "Z")


def run_knowledge_inspect():
    if not MILVUS_DB_PATH.exists():
        return {"dbPath": str(MILVUS_DB_PATH), "dbExists": False, "collections": [], "error": ""}
    args = [ROOT / "scripts" / "inspect_knowledge.py", "--db-path", MILVUS_DB_PATH, "--sample-limit", "5"]
    for source in KNOWLEDGE_SOURCES:
        args.extend(["--collection", source["collection"]])
    try:
        completed = subprocess.run([PYTHON_BIN, *map(str, args)], cwd=ROOT, text=True, capture_output=True, timeout=30)
        if completed.returncode != 0:
            return {"dbPath": str(MILVUS_DB_PATH), "dbExists": MILVUS_DB_PATH.exists(), "collections": [], "error": (completed.stderr + completed.stdout)[:1200]}
        return json.loads(completed.stdout or "{}")
    except Exception as error:
        return {"dbPath": str(MILVUS_DB_PATH), "dbExists": MILVUS_DB_PATH.exists(), "collections": [], "error": str(error)}


def source_health_from_stats(source, stats, inspect_error=""):
    if not MILVUS_DB_PATH.exists():
        return {**source, "exists": False, "rowCount": 0, "sampleTitles": [], "sourceTypes": [], "metadataPreview": [], "lastUpdated": "", "health": "missing_db", "healthLabel": "未入库", "healthMessage": "Milvus 本地数据库文件尚未创建。"}
    if inspect_error:
        return {**source, "exists": bool((stats or {}).get("exists")), "rowCount": (stats or {}).get("rowCount"), "sampleTitles": (stats or {}).get("sampleTitles", []), "sourceTypes": (stats or {}).get("sourceTypes", []), "metadataPreview": (stats or {}).get("metadataPreview", []), "lastUpdated": get_db_modified_at(), "health": "unknown", "healthLabel": "待检查", "healthMessage": inspect_error}
    if not (stats or {}).get("exists"):
        return {**source, "exists": False, "rowCount": 0, "sampleTitles": [], "sourceTypes": [], "metadataPreview": [], "lastUpdated": get_db_modified_at(), "health": "missing_collection", "healthLabel": "未入库", "healthMessage": f"collection {source['collection']} 尚不存在。"}
    row_count = int((stats or {}).get("rowCount") or 0)
    return {**source, "exists": True, "rowCount": row_count, "sampleTitles": (stats or {}).get("sampleTitles", []), "sourceTypes": (stats or {}).get("sourceTypes", []), "metadataPreview": (stats or {}).get("metadataPreview", []), "lastUpdated": get_db_modified_at(), "health": "ready" if row_count else "empty", "healthLabel": "可用" if row_count else "空库", "healthMessage": f"已检测到 {row_count} 条知识片段。" if row_count else "collection 已创建，但未检测到知识片段。"}


def uploaded_knowledge_status(milvus_stats=None, inspect_error=""):
    documents = runtime_storage.list_uploaded_documents()
    local_chunk_count = sum(len(document.get("chunks") or []) for document in documents)
    milvus_row_count = int((milvus_stats or {}).get("rowCount") or 0)
    row_count = max(local_chunk_count, milvus_row_count)
    last_updated = sorted([document.get("updatedAt") or document.get("createdAt") or "" for document in documents if document.get("updatedAt") or document.get("createdAt")])
    return {
        **UPLOADED_KNOWLEDGE_SOURCE,
        "exists": bool(documents),
        "rowCount": row_count,
        "sampleTitles": [document["filename"] for document in documents[-3:]],
        "sourceTypes": ["uploaded_file"] if documents or milvus_row_count else [],
        "metadataPreview": [{"filename": document["filename"], "chunkCount": len(document.get("chunks") or []), "size": document["size"], "milvus": f"{document.get('milvusStatus', {}).get('inserted')} records" if isinstance(document.get("milvusStatus"), dict) and document["milvusStatus"].get("inserted") else (document.get("milvusStatus") or {}).get("error", "") if isinstance(document.get("milvusStatus"), dict) else ""} for document in documents[-2:]],
        "lastUpdated": last_updated[-1] if last_updated else "",
        "health": "ready" if row_count else "unknown" if inspect_error else "empty",
        "healthLabel": "可用" if row_count else "待检查" if inspect_error else "未上传",
        "healthMessage": f"已上传 {len(documents)} 个文件；Milvus {milvus_row_count} 条，本地 {local_chunk_count} 个向量片段。" if row_count else inspect_error or "尚未上传可检索文档。",
    }


def knowledge_status_payload():
    inspect = run_knowledge_inspect()
    stats_by_collection = {item.get("collection"): item for item in inspect.get("collections") or []}
    uploaded_status = uploaded_knowledge_status(stats_by_collection.get(UPLOADED_KNOWLEDGE_SOURCE["collection"]), inspect.get("error", ""))
    sources = [*[source_health_from_stats(source, stats_by_collection.get(source["collection"]), inspect.get("error", "")) for source in MILVUS_KNOWLEDGE_SOURCES], uploaded_status]
    return {
        "configured": MILVUS_DB_PATH.exists() or uploaded_status["health"] == "ready",
        "dbPath": str(MILVUS_DB_PATH),
        "dbExists": MILVUS_DB_PATH.exists(),
        "dbModifiedAt": get_db_modified_at(),
        "collection": MILVUS_COLLECTION,
        "inspectError": inspect.get("error", ""),
        "runtimeStoreDir": str(RUNTIME_STORE_DIR),
        "sources": sources,
    }


def source_by_collection(collection):
    return next((source for source in KNOWLEDGE_SOURCES if source["collection"] == collection), {"id": collection, "label": collection, "collection": collection})


def resolve_knowledge_collections(input_collections):
    requested = input_collections if isinstance(input_collections, list) else []
    aliases = {}
    for source in KNOWLEDGE_SOURCES:
        aliases[source["id"]] = source["collection"]
        aliases[source["collection"]] = source["collection"]
    collections = [aliases.get(str(item).strip(), str(item).strip()) for item in requested if str(item).strip()]
    return list(dict.fromkeys(collections or [source["collection"] for source in KNOWLEDGE_SOURCES]))


def run_knowledge_search(query, collection, limit=8):
    completed = subprocess.run(
        [PYTHON_BIN, str(ROOT / "scripts" / "search_knowledge.py"), query, "--limit", str(limit), "--db-path", str(MILVUS_DB_PATH), "--collection", collection],
        cwd=ROOT,
        text=True,
        capture_output=True,
        timeout=30,
    )
    if completed.returncode != 0:
        raise RuntimeError((completed.stderr or completed.stdout or "Milvus knowledge search failed.")[:2000])
    source = source_by_collection(collection)
    results = []
    for line in completed.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        item = json.loads(line)
        item.update({"knowledge_source_id": source["id"], "knowledge_source_label": source["label"], "collection": collection})
        results.append(item)
    return results


def search_knowledge_collections(query, collections, limit):
    errors = []
    results = []
    for collection in collections:
        try:
            if collection == LOCAL_UPLOAD_COLLECTION:
                results.extend(run_uploaded_knowledge_search(query, limit))
            elif collection == MILVUS_COLLECTION_UPLOADS:
                milvus_results = run_knowledge_search(query, collection, limit)
                results.extend(milvus_results or run_uploaded_knowledge_search(query, limit))
            else:
                results.extend(run_knowledge_search(query, collection, limit))
        except Exception as error:
            if collection == MILVUS_COLLECTION_UPLOADS:
                results.extend(run_uploaded_knowledge_search(query, limit))
                errors.append(f"Milvus uploaded search fallback: {error}")
            else:
                errors.append(str(error))
    results.sort(key=lambda item: float(item.get("distance") or 0), reverse=True)
    return {"results": results[:limit], "errors": errors}


def config_payload():
    return {
        "llm": {
            "baseUrl": runtime_config["llmBaseUrl"],
            "model": runtime_config["llmModel"],
            "path": runtime_config["llmPath"],
            "apiKeyConfigured": bool(runtime_config["llmApiKey"]),
            "apiKeyPreview": api_key_preview(runtime_config["llmApiKey"]),
            "saved": bool(runtime_storage.get_setting("llm_config", None)),
        }
    }


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "RAGPythonBackend/1.0"

    def log_message(self, fmt, *args):
        print("%s - - [%s] %s" % (self.address_string(), self.log_date_time_string(), fmt % args))

    def send_json(self, status_code, payload):
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json;charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self, max_bytes=1024 * 1024):
        length = int(self.headers.get("Content-Length") or "0")
        if length > max_bytes:
            raise ValueError("Request body too large")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8") or "{}") if raw else {}

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        try:
            if path == "/api/health":
                self.send_json(
                    200,
                    {
                        "llmConfigured": bool(runtime_config["llmApiKey"]),
                        "model": runtime_config["llmModel"],
                        "baseUrl": runtime_config["llmBaseUrl"],
                        "chatPath": runtime_config["llmPath"],
                        "apiKeyPreview": api_key_preview(runtime_config["llmApiKey"]),
                        "knowledgeConfigured": MILVUS_DB_PATH.exists() or uploaded_knowledge_status()["health"] == "ready",
                        "knowledgeCollection": MILVUS_COLLECTION,
                        "knowledgeSources": KNOWLEDGE_SOURCES,
                        "runtimeStoreDir": str(RUNTIME_STORE_DIR),
                    },
                )
                return
            if path == "/api/config":
                self.send_json(200, config_payload())
                return
            if path == "/api/knowledge/status":
                self.send_json(200, knowledge_status_payload())
                return
            if path == "/api/knowledge/uploads":
                documents = [
                    {
                        "id": document["id"],
                        "filename": document["filename"],
                        "mimeType": document["mimeType"],
                        "size": document["size"],
                        "contentHash": document["contentHash"],
                        "chunkCount": document["chunkCount"],
                        "milvusCollection": document["milvusCollection"],
                        "milvusStatus": document["milvusStatus"],
                        "createdAt": document["createdAt"],
                        "updatedAt": document["updatedAt"],
                    }
                    for document in runtime_storage.list_uploaded_documents()
                ]
                self.send_json(200, {"documents": documents})
                return
            if path == "/api/knowledge/audit-logs":
                limit = int((urllib.parse.parse_qs(parsed.query).get("limit") or ["100"])[0])
                self.send_json(200, {"events": runtime_storage.list_audit_logs(limit)})
                return
            if path == "/api/orchestrator/sessions":
                self.send_json(200, {"sessions": orchestrator.list_sessions()})
                return
            parts = [item for item in path.split("/") if item]
            if len(parts) == 4 and parts[:3] == ["api", "orchestrator", "sessions"]:
                self.send_json(200, orchestrator.get_session(urllib.parse.unquote(parts[3])))
                return
            if len(parts) == 5 and parts[:3] == ["api", "orchestrator", "sessions"] and parts[4] == "prompt-versions":
                self.send_json(200, {"versions": orchestrator.list_prompt_versions(urllib.parse.unquote(parts[3]))})
                return
            self.serve_static(path)
        except KeyError:
            self.send_json(404, {"error": "session not found."})
        except Exception as error:
            self.send_json(500, {"error": str(error)})

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        parts = [item for item in path.split("/") if item]
        try:
            if path == "/api/llm":
                body = self.read_json()
                messages = body.get("messages") if isinstance(body.get("messages"), list) else []
                if not messages:
                    self.send_json(400, {"error": "messages is required."})
                    return
                self.send_json(200, call_llm_provider(body.get("model"), messages, body.get("temperature", 0.2), bool(body.get("jsonMode"))))
                return
            if path == "/api/config/llm":
                body = self.read_json()
                base_url = str(body.get("baseUrl") or runtime_config["llmBaseUrl"]).strip().rstrip("/")
                model = str(body.get("model") or runtime_config["llmModel"]).strip()
                llm_path = str(body.get("path") or runtime_config["llmPath"]).strip()
                llm_path = llm_path if llm_path.startswith("/") else f"/{llm_path}"
                if not re.match(r"^https?://", base_url, re.I):
                    self.send_json(400, {"error": "baseUrl must start with http:// or https://."})
                    return
                if not model:
                    self.send_json(400, {"error": "model is required."})
                    return
                runtime_config.update({"llmBaseUrl": base_url, "llmModel": model, "llmPath": llm_path})
                if body.get("clearApiKey"):
                    runtime_config["llmApiKey"] = ""
                elif isinstance(body.get("apiKey"), str) and body["apiKey"].strip():
                    runtime_config["llmApiKey"] = body["apiKey"].strip()
                if body.get("remember"):
                    runtime_storage.set_setting(
                        "llm_config",
                        {
                            "baseUrl": runtime_config["llmBaseUrl"],
                            "model": runtime_config["llmModel"],
                            "path": runtime_config["llmPath"],
                            "apiKey": runtime_config["llmApiKey"],
                        },
                    )
                runtime_storage.append_audit({"type": "update_llm_config", "detail": {"baseUrl": base_url, "model": model, "path": llm_path, "apiKeyConfigured": bool(runtime_config["llmApiKey"]), "remembered": bool(body.get("remember"))}})
                self.send_json(200, config_payload())
                return
            if path == "/api/knowledge/uploads":
                body = self.read_json(max_bytes=32 * 1024 * 1024)
                files = body.get("files") if isinstance(body.get("files"), list) else [body]
                uploaded = []
                for file_payload in files:
                    filename = safe_upload_filename(file_payload.get("filename") or file_payload.get("name"))
                    extracted = extract_uploaded_text(filename, upload_buffer_from_payload(file_payload), file_payload.get("content") or "")
                    document = build_uploaded_document(filename, extracted["text"], file_payload.get("mimeType") or file_payload.get("type") or "text/plain", extracted["sourcePath"])
                    runtime_storage.save_uploaded_document(document)
                    try:
                        milvus_status = index_uploaded_document_to_milvus(document)
                        indexed = runtime_storage.update_uploaded_document_index(document["id"], milvus_status.get("collection") or MILVUS_COLLECTION_UPLOADS, milvus_status.get("recordIds") or [], milvus_status) or document
                    except Exception as error:
                        indexed = runtime_storage.update_uploaded_document_index(document["id"], MILVUS_COLLECTION_UPLOADS, [], {"error": str(error)}) or document
                    runtime_storage.append_audit({"type": "upload_document", "documentId": indexed["id"], "detail": {"filename": indexed["filename"], "chunkCount": indexed["chunkCount"], "contentHash": indexed["contentHash"], "milvusStatus": indexed["milvusStatus"]}})
                    uploaded.append({"id": indexed["id"], "filename": indexed["filename"], "chunkCount": indexed["chunkCount"], "size": indexed["size"], "contentHash": indexed["contentHash"], "milvusCollection": indexed["milvusCollection"], "milvusStatus": indexed["milvusStatus"], "createdAt": indexed["createdAt"]})
                self.send_json(200, {"uploaded": uploaded, "source": uploaded_knowledge_status()})
                return
            if path == "/api/knowledge/search":
                body = self.read_json()
                query = str(body.get("query") or "").strip()
                if not query:
                    self.send_json(400, {"error": "query is required."})
                    return
                collections = resolve_knowledge_collections(body.get("collections"))
                uses_milvus = any(collection not in (LOCAL_UPLOAD_COLLECTION, MILVUS_COLLECTION_UPLOADS) for collection in collections)
                if uses_milvus and not MILVUS_DB_PATH.exists():
                    self.send_json(404, {"error": "Milvus knowledge database not found.", "dbPath": str(MILVUS_DB_PATH)})
                    return
                limit = max(1, min(int(body.get("limit") or 8), 20))
                searched = search_knowledge_collections(query, collections, limit)
                self.send_json(200, {"query": query, "count": len(searched["results"]), "dbPath": str(MILVUS_DB_PATH), "collections": collections, "errors": searched["errors"], "results": searched["results"]})
                return
            if path == "/api/orchestrator/sessions":
                self.send_json(200, orchestrator.create_session(self.read_json()))
                return
            if len(parts) == 5 and parts[:3] == ["api", "orchestrator", "sessions"] and parts[4] == "answers":
                self.send_json(200, orchestrator.submit_answer(urllib.parse.unquote(parts[3]), self.read_json()))
                return
            if len(parts) == 5 and parts[:3] == ["api", "orchestrator", "sessions"] and parts[4] == "navigate":
                self.send_json(200, orchestrator.navigate_session(urllib.parse.unquote(parts[3]), self.read_json()))
                return
            if len(parts) == 5 and parts[:3] == ["api", "orchestrator", "sessions"] and parts[4] == "finalize":
                self.send_json(200, orchestrator.finalize_session(urllib.parse.unquote(parts[3]), self.read_json()))
                return
            self.send_json(404, {"error": "route not found."})
        except ValueError as error:
            self.send_json(400, {"error": str(error)})
        except KeyError:
            self.send_json(404, {"error": "session not found."})
        except RuntimeError as error:
            self.send_json(500, {"error": str(error)})
        except Exception as error:
            self.send_json(500, {"error": str(error)})

    def do_DELETE(self):
        path = urllib.parse.urlparse(self.path).path
        parts = [item for item in path.split("/") if item]
        try:
            if len(parts) == 4 and parts[:3] == ["api", "knowledge", "uploads"]:
                document_id = urllib.parse.unquote(parts[3])
                document = runtime_storage.get_uploaded_document(document_id, include_text=True)
                if not document:
                    self.send_json(404, {"error": "uploaded document not found."})
                    return
                try:
                    milvus_delete = delete_uploaded_document_from_milvus(document)
                except Exception as error:
                    milvus_delete = {"error": str(error)}
                runtime_storage.delete_uploaded_document(document_id)
                runtime_storage.append_audit({"type": "delete_uploaded_document", "documentId": document_id, "detail": {"filename": document["filename"], "milvusDelete": milvus_delete}})
                self.send_json(200, {"deleted": document_id, "milvusDelete": milvus_delete})
                return
            self.send_json(404, {"error": "route not found."})
        except Exception as error:
            self.send_json(500, {"error": str(error)})

    def serve_static(self, request_path):
        path = "/index.html" if request_path == "/" else urllib.parse.unquote(request_path)
        file_path = (ROOT / path.lstrip("/")).resolve()
        if not str(file_path).startswith(str(ROOT)):
            self.send_response(403)
            self.end_headers()
            self.wfile.write(b"Forbidden")
            return
        if not file_path.exists() or not file_path.is_file():
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b"Not found")
            return
        content = file_path.read_bytes()
        mime_type = mimetypes.guess_type(file_path.name)[0] or "application/octet-stream"
        if file_path.suffix == ".js":
            mime_type = "text/javascript"
        self.send_response(200)
        self.send_header("Content-Type", f"{mime_type};charset=utf-8" if mime_type.startswith("text/") else mime_type)
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(content)))
        self.end_headers()
        self.wfile.write(content)


def main():
    server = ThreadingHTTPServer((HOST, PORT), RequestHandler)
    print(f"RAG prompt workstation: http://{HOST}:{PORT}")
    print(f"Python backend: server.py")
    print(f"LLM proxy: {'enabled' if runtime_config['llmApiKey'] else 'disabled, configure it in the UI or set LLM_API_KEY'}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()

