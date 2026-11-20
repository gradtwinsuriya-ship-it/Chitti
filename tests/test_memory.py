from app.memory import MemoryStore, chunk_text


def test_vector_search_ranks_relevant_entry_after_reopening_store(tmp_path) -> None:
    database = tmp_path / "memory.sqlite3"
    store = MemoryStore(database)
    store.add("memory", "profile", ["I prefer Tamil responses", "My bicycle is blue"], [[1, 0], [0, 1]])

    reopened_store = MemoryStore(database)
    results = reopened_store.search([0.9, 0.1], limit=1)

    assert results[0]["content"] == "I prefer Tamil responses"
    assert results[0]["kind"] == "memory"


def test_delete_latest_memory_preserves_personal_documents(tmp_path) -> None:
    store = MemoryStore(tmp_path / "memory.sqlite3")
    memory_ids = store.add("memory", "profile", ["Remember this", "and this too"], [[1, 0], [0.9, 0.1]])
    document_id = store.add("document", "notes.md", ["Keep this document"], [[0, 1]])[0]

    assert store.delete_latest_memory()
    assert [entry["id"] for entry in store.list_entries()] == [document_id]
    assert all(not store.delete(memory_id) for memory_id in memory_ids)


def test_chunk_text_splits_long_text_with_overlap() -> None:
    chunks = chunk_text("a" * 90, max_chars=40, overlap=10)

    assert [len(chunk) for chunk in chunks] == [40, 40, 30]
    assert chunks[0][-10:] == chunks[1][:10]