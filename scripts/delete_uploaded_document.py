#!/usr/bin/env python3
"""Delete uploaded document records from a Milvus Lite collection by primary ids."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from ingest_knowledge import connect_milvus, load_env_file


ROOT = Path(__file__).resolve().parents[1]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Delete uploaded document records from Milvus.")
    parser.add_argument("--ids-json", required=True)
    parser.add_argument("--db-path", default=os.environ.get("MILVUS_DB_PATH", str(ROOT / "data" / "milvus_knowledge.db")))
    parser.add_argument("--collection", default=os.environ.get("MILVUS_COLLECTION_UPLOADS", "kb_uploaded_documents"))
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    load_env_file(ROOT / ".env")
    args = parse_args(argv)
    ids = [int(item) for item in json.loads(args.ids_json or "[]")]
    if not ids:
        print(json.dumps({"deleted": 0, "collection": args.collection}, ensure_ascii=False))
        return 0
    client = connect_milvus(args.db_path)
    if not client.has_collection(collection_name=args.collection):
        print(json.dumps({"deleted": 0, "collection": args.collection, "missingCollection": True}, ensure_ascii=False))
        return 0
    result = client.delete(collection_name=args.collection, ids=ids)
    deleted = result.get("delete_count", len(ids)) if isinstance(result, dict) else len(ids)
    print(json.dumps({"deleted": deleted, "collection": args.collection}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
