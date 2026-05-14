#!/usr/bin/env python3
"""Index one uploaded text document into a Milvus Lite collection."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from ingest_knowledge import (
    Document,
    base_metadata,
    build_records,
    connect_milvus,
    embed_texts,
    insert_records,
    load_env_file,
    source_id,
)


ROOT = Path(__file__).resolve().parents[1]


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Index an uploaded text file into Milvus.")
    parser.add_argument("--text-file", required=True)
    parser.add_argument("--document-id", required=True)
    parser.add_argument("--filename", required=True)
    parser.add_argument("--content-hash", required=True)
    parser.add_argument("--db-path", default=os.environ.get("MILVUS_DB_PATH", str(ROOT / "data" / "milvus_knowledge.db")))
    parser.add_argument("--collection", default=os.environ.get("MILVUS_COLLECTION_UPLOADS", "kb_uploaded_documents"))
    parser.add_argument("--embedding-mode", choices=["hash", "openai"], default=os.environ.get("EMBEDDING_MODE", "hash"))
    parser.add_argument("--embedding-dim", type=int, default=int(os.environ.get("EMBEDDING_DIM", "384")))
    parser.add_argument("--chunk-chars", type=int, default=1000)
    parser.add_argument("--chunk-overlap", type=int, default=120)
    parser.add_argument("--batch-size", type=int, default=128)
    return parser.parse_args(argv)


def main(argv: list[str]) -> int:
    load_env_file(ROOT / ".env")
    args = parse_args(argv)
    text_path = Path(args.text_file).expanduser()
    text = text_path.read_text(encoding="utf-8", errors="replace")
    document = Document(
        text="\n".join(
            [
                f"来源: {args.filename}",
                f"上传文档ID: {args.document_id}",
                f"内容哈希: {args.content_hash}",
                text,
            ]
        ),
        title=args.filename,
        source_type="uploaded_file",
        source_uri=f"upload://{args.document_id}/{args.filename}",
        metadata=base_metadata(
            source_type="uploaded_file",
            source_id_value=source_id("upload", args.document_id),
            canonical_name=args.filename,
            source_title=args.filename,
            source_path=str(text_path),
            evidence_type="uploaded_document",
            extra={
                "document_id": args.document_id,
                "filename": args.filename,
                "content_hash": args.content_hash,
            },
        ),
    )
    records = build_records([document], max_chars=args.chunk_chars, overlap=args.chunk_overlap)
    vectors = embed_texts([record["text"] for record in records], mode=args.embedding_mode, dimension=args.embedding_dim, batch_size=args.batch_size)
    for record, vector in zip(records, vectors):
        record["vector"] = vector

    client = connect_milvus(args.db_path)
    inserted = insert_records(
        client=client,
        collection_name=args.collection,
        records=records,
        dimension=args.embedding_dim,
        reset=False,
        batch_size=args.batch_size,
    )
    print(
        json.dumps(
            {
                "inserted": inserted,
                "recordIds": [record["id"] for record in records],
                "collection": args.collection,
                "dbPath": args.db_path,
                "embeddingMode": args.embedding_mode,
                "embeddingDim": args.embedding_dim,
            },
            ensure_ascii=False,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
