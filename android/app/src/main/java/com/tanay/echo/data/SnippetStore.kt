package com.tanay.echo.data

import com.tanay.echo.snippet.Snippet
import com.tanay.echo.sync.SyncCollection
import java.util.UUID

/**
 * Local store for voice snippets (own database — see [SnippetDatabase]). Stamps a uuid + a monotonic
 * updatedAt on every write so the sync push watermark's strict `>` is safe, and soft-deletes so
 * deletions propagate. All methods block — call them off the main thread.
 */
class SnippetStore(
    db: SnippetDatabase,
    private val clock: MonotonicClock = MonotonicClock()
) {
    private val snippets = db.snippets()

    /** Active snippets as domain objects for the expansion layer. */
    fun active(): List<Snippet> = snippets.active().map { Snippet(it.cue, it.expansion) }

    /** Active snippets as rows (with ids) for the management UI. */
    fun rows(): List<SnippetEntity> = snippets.active()

    fun add(cue: String, expansion: String): Long {
        val c = cue.trim()
        require(c.isNotEmpty()) { "A snippet cue is required" }
        return snippets.insert(
            SnippetEntity(
                uuid = UUID.randomUUID().toString(),
                updatedAt = clock.now(),
                deleted = false,
                cue = c,
                expansion = expansion,
                createdAt = System.currentTimeMillis()
            )
        )
    }

    fun update(id: Long, cue: String, expansion: String) {
        val existing = snippets.byId(id) ?: return
        snippets.update(existing.copy(cue = cue.trim(), expansion = expansion, updatedAt = clock.now()))
    }

    fun delete(id: Long) = snippets.softDelete(id, clock.now())

    fun syncCollections(): List<SyncCollection> = listOf(SnippetSyncCollection(snippets))
}
