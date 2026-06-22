package com.tanay.echo.data

import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey

// Room entities mirroring the desktop tables (src/main/store/*.ts) plus the sync columns
// (uuid/updatedAt/deleted). The autoincrement `id` is the LOCAL key; `uuid` is the cross-device
// identity (unique index). audio is never synced and never stored on the phone, so there is no
// audio column. The dictionary has NO unique index on `word` — uniqueness is enforced in app
// code (EchoStore.addWord merges), because a DB constraint would wedge sync when two devices
// add the same word with different uuids.

@Entity(tableName = "transcripts", indices = [Index(value = ["uuid"], unique = true)])
data class TranscriptEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val uuid: String,
    val updatedAt: Long,
    val deleted: Boolean,
    val createdAt: Long,
    val rawText: String,
    val cleanedText: String?,
    val durationMs: Long,
    val wordCount: Int,
    val latencyMs: Long,
    val appContext: String,
    val model: String,
    val status: String
)

@Entity(tableName = "dictionary", indices = [Index(value = ["uuid"], unique = true)])
data class DictionaryEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val uuid: String,
    val updatedAt: Long,
    val deleted: Boolean,
    val word: String,
    val misheard: String, // JSON array string, matching the desktop dictionary column
    val source: String,
    val createdAt: Long,
    val timesApplied: Int
)

@Entity(tableName = "snippets", indices = [Index(value = ["uuid"], unique = true)])
data class SnippetEntity(
    @PrimaryKey(autoGenerate = true) val id: Long = 0,
    val uuid: String,
    val updatedAt: Long,
    val deleted: Boolean,
    val cue: String,
    val expansion: String,
    val createdAt: Long
)

/** Projection for the last-write-wins meta-check in applyRemote. */
data class SyncMetaRow(val uuid: String, val updatedAt: Long, val deleted: Boolean)
