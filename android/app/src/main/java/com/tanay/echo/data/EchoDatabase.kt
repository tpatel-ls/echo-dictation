package com.tanay.echo.data

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase

@Database(
    entities = [TranscriptEntity::class, DictionaryEntity::class],
    version = 1,
    exportSchema = false
)
abstract class EchoDatabase : RoomDatabase() {
    abstract fun transcripts(): TranscriptDao
    abstract fun dictionary(): DictionaryDao

    companion object {
        @Volatile
        private var instance: EchoDatabase? = null

        fun get(context: Context): EchoDatabase =
            instance ?: synchronized(this) {
                instance ?: Room.databaseBuilder(context.applicationContext, EchoDatabase::class.java, "echo.db")
                    .build()
                    .also { instance = it }
            }
    }
}
