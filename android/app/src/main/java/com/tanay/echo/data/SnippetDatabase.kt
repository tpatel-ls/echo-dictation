package com.tanay.echo.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

/**
 * Snippets live in their own database so the feature ships without an echo.db schema migration —
 * a migration would risk the existing (synced) dictionary, and can't be verified without a device.
 * This is a fresh v1 DB: Room creates the schema from [SnippetEntity], no hand-written DDL.
 */
@Database(entities = [SnippetEntity::class], version = 1, exportSchema = false)
abstract class SnippetDatabase : RoomDatabase() {
    abstract fun snippets(): SnippetDao

    companion object {
        @Volatile
        private var instance: SnippetDatabase? = null

        fun get(context: Context): SnippetDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(context.applicationContext, SnippetDatabase::class.java, "echo-snippets.db")
                    .build()
                    .also { instance = it }
            }
    }
}
