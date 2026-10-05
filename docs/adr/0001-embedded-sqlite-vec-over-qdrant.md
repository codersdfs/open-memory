# Embedded sqlite-vec over Qdrant/Pinecone

We store vectors in an embedded SQLite file (sqlite-vec / LanceDB-compatible interface) with a `VectorStore` abstraction that can swap to Qdrant later. This gives zero infra (no Docker), single-file persistence, and instant local startup for a single-agent with namespace partitioning. We avoid cloud Pinecone (cost/lock-in) and Docker-bound Qdrant for v1 — swapping is a one-adapter change behind the interface.
