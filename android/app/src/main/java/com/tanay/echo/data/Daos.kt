package com.tanay.echo.data

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.Query
import androidx.room.Update

// Blocking DAOs — callers run them off the main thread (the SyncClient and the IME pipeline
// already work inside Dispatchers.IO). changedSince orders oldest-first like the desktop, so
// the push watermark advances monotonically.

@Dao
interface TranscriptDao {
    @Insert
    fun insert(t: TranscriptEntity): Long

    @Update
    fun update(t: TranscriptEntity)

    @Query("SELECT * FROM transcripts WHERE deleted = 0 ORDER BY createdAt DESC, id DESC LIMIT :limit OFFSET :offset")
    fun recent(limit: Int, offset: Int): List<TranscriptEntity>

    @Query("SELECT * FROM transcripts WHERE uuid = :uuid")
    fun byUuid(uuid: String): TranscriptEntity?

    @Query("SELECT uuid, updatedAt, deleted FROM transcripts WHERE uuid = :uuid")
    fun metaByUuid(uuid: String): SyncMetaRow?

    @Query("SELECT * FROM transcripts WHERE updatedAt > :watermark ORDER BY updatedAt ASC, id ASC")
    fun changedSince(watermark: Long): List<TranscriptEntity>

    @Query("UPDATE transcripts SET deleted = 1, updatedAt = :updatedAt WHERE id = :id")
    fun softDelete(id: Long, updatedAt: Long)
}

@Dao
interface DictionaryDao {
    @Insert
    fun insert(e: DictionaryEntity): Long

    @Update
    fun update(e: DictionaryEntity)

    @Query("SELECT * FROM dictionary WHERE deleted = 0 ORDER BY createdAt DESC, id DESC")
    fun active(): List<DictionaryEntity>

    @Query("SELECT * FROM dictionary WHERE word = :word COLLATE NOCASE AND deleted = 0 LIMIT 1")
    fun activeByWord(word: String): DictionaryEntity?

    @Query("SELECT * FROM dictionary WHERE uuid = :uuid")
    fun byUuid(uuid: String): DictionaryEntity?

    @Query("SELECT uuid, updatedAt, deleted FROM dictionary WHERE uuid = :uuid")
    fun metaByUuid(uuid: String): SyncMetaRow?

    @Query("SELECT * FROM dictionary WHERE updatedAt > :watermark ORDER BY updatedAt ASC, id ASC")
    fun changedSince(watermark: Long): List<DictionaryEntity>

    @Query("UPDATE dictionary SET timesApplied = timesApplied + 1, updatedAt = :updatedAt WHERE id = :id AND deleted = 0")
    fun bumpApplied(id: Long, updatedAt: Long)
}

@Dao
interface SnippetDao {
    @Insert
    fun insert(e: SnippetEntity): Long

    @Update
    fun update(e: SnippetEntity)

    @Query("SELECT * FROM snippets WHERE deleted = 0 ORDER BY createdAt DESC, id DESC")
    fun active(): List<SnippetEntity>

    @Query("SELECT * FROM snippets WHERE id = :id")
    fun byId(id: Long): SnippetEntity?

    @Query("SELECT * FROM snippets WHERE uuid = :uuid")
    fun byUuid(uuid: String): SnippetEntity?

    @Query("SELECT uuid, updatedAt, deleted FROM snippets WHERE uuid = :uuid")
    fun metaByUuid(uuid: String): SyncMetaRow?

    @Query("SELECT * FROM snippets WHERE updatedAt > :watermark ORDER BY updatedAt ASC, id ASC")
    fun changedSince(watermark: Long): List<SnippetEntity>

    @Query("UPDATE snippets SET deleted = 1, updatedAt = :updatedAt WHERE id = :id")
    fun softDelete(id: Long, updatedAt: Long)
}
