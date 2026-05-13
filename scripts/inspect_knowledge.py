#!/usr/bin/env python3
"""Inspect local Milvus Lite knowledge collections for UI health checks."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from ingest_knowledge import DEFAULT_DB_PATH, load_env_file


ROOT = Path(__file__).resolve().parents[1]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Inspect local Milvus knowledge collections.")
    parser.add_argument("--db-path", default=os.environ.get("MILVUS_DB_PATH", DEFAULT_DB_PATH))
    parser.add_argument("--collection", action="append", default=[], help="Collection name. Can be passed multiple times.")
    parser.add_argument("--sample-limit", type=int, default=5)
    return parser.parse_args(argv)


def safe_row_count(client, collection: str) -> int | None:
    try:
        stats = client.get_collection_stats(collection_name=collection)
        if isinstance(stats, dict):
            for key in ("row_count", "num_entities"):
                if key in stats:
                    return int(stats[key])
    except Exception:
        pass

    try:
        rows = client.query(collection_name=collection, filter="id >= 0", output_fields=["id"], limit=1)
        return len(rows)
    except Exception:
        return None


def safe_sample_rows(client, collection: str, limit: int) -> list[dict]:
    for filter_expr in ("id >= 0", ""):
        try:
            return client.query(
                collection_name=collection,
                filter=filter_expr,
                output_fields=["title", "source_type", "source_uri", "metadata_json"],
                limit=limit,
            )
        except Exception:
            continue
    return []


def inspect_collection(client, existing_collections: set[str], collection: str, sample_limit: int) -> dict:
    if collection not in existing_collections:
        return {
            "collection": collection,
            "exists": False,
            "rowCount": 0,
            "sampleTitles": [],
            "sourceTypes": [],
            "metadataPreview": [],
        }

    samples = safe_sample_rows(client, collection, sample_limit)
    source_types = sorted({str(row.get("source_type") or "") for row in samples if row.get("source_type")})
    metadata_preview = []
    for row in samples:
        try:
            metadata = json.loads(row.get("metadata_json") or "{}")
        except json.JSONDecodeError:
            metadata = {}
        metadata_preview.append(
            {
                "title": row.get("title") or "",
                "sourceType": row.get("source_type") or "",
                "sourceUri": row.get("source_uri") or "",
                "term": metadata.get("term") or metadata.get("field_name") or "",
                "section": metadata.get("section") or "",
            }
        )

    return {
        "collection": collection,
        "exists": True,
        "rowCount": safe_row_count(client, collection),
        "sampleTitles": [row.get("title") or "" for row in samples if row.get("title")],
        "sourceTypes": source_types,
        "metadataPreview": metadata_preview,
    }


def main(argv: list[str]) -> int:
    load_env_file(ROOT / ".env")
    args = parse_args(argv)
    db_path = Path(args.db_path).expanduser()
    collections = args.collection
    payload = {
        "dbPath": str(db_path),
        "dbExists": db_path.exists(),
        "collections": [],
        "error": "",
    }

    if not db_path.exists():
        print(json.dumps(payload, ensure_ascii=False))
        return 0

    try:
        from pymilvus import MilvusClient
    except ImportError as exc:
        payload["error"] = "pymilvus is not installed. Run: pip install -r requirements-rag.txt"
        print(json.dumps(payload, ensure_ascii=False))
        return 0

    try:
        client = MilvusClient(str(db_path))
        existing_collections = set(client.list_collections())
        payload["collections"] = [
            inspect_collection(client, existing_collections, collection, args.sample_limit) for collection in collections
        ]
    except Exception as exc:  # pragma: no cover - defensive status endpoint guard
        payload["error"] = str(exc)

    print(json.dumps(payload, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
