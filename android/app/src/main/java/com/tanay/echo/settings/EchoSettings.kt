package com.tanay.echo.settings

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * App configuration, stored in EncryptedSharedPreferences (keys/tokens are encrypted at rest via
 * the Android keystore). Endpoints default to empty — the user fills them in SettingsActivity on
 * first run, exactly like the desktop's gitignored secrets.local.json (so no personal tailnet
 * hostname is ever baked into the source). The IME reads this; the settings screen writes it.
 */
class EchoSettings(context: Context) {
    private val prefs = run {
        val key = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "echo_secure_prefs",
            key,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
        )
    }

    var whisperBaseUrl: String
        get() = prefs.getString("whisperBaseUrl", "") ?: ""
        set(v) = prefs.edit().putString("whisperBaseUrl", v.trim()).apply()

    var whisperApiKey: String
        get() = prefs.getString("whisperApiKey", "") ?: ""
        set(v) = prefs.edit().putString("whisperApiKey", v.trim()).apply()

    var whisperModel: String
        get() = prefs.getString("whisperModel", "whisper-1") ?: "whisper-1"
        set(v) = prefs.edit().putString("whisperModel", v.trim().ifEmpty { "whisper-1" }).apply()

    var claudeBaseUrl: String
        get() = prefs.getString("claudeBaseUrl", "") ?: ""
        set(v) = prefs.edit().putString("claudeBaseUrl", v.trim()).apply()

    var claudeApiKey: String
        get() = prefs.getString("claudeApiKey", "") ?: ""
        set(v) = prefs.edit().putString("claudeApiKey", v.trim()).apply()

    var claudeModel: String
        get() = prefs.getString("claudeModel", "claude-sonnet-4-6") ?: "claude-sonnet-4-6"
        set(v) = prefs.edit().putString("claudeModel", v.trim().ifEmpty { "claude-sonnet-4-6" }).apply()

    /** Optional Claude cleanup — off by default to keep dictation latency low. */
    var cleanupEnabled: Boolean
        get() = prefs.getBoolean("cleanupEnabled", false)
        set(v) = prefs.edit().putBoolean("cleanupEnabled", v).apply()

    var syncBaseUrl: String
        get() = prefs.getString("syncBaseUrl", "") ?: ""
        set(v) = prefs.edit().putString("syncBaseUrl", v.trim()).apply()

    var syncToken: String
        get() = prefs.getString("syncToken", "") ?: ""
        set(v) = prefs.edit().putString("syncToken", v.trim()).apply()

    /** Whisper is the minimum needed to dictate. */
    val isTranscriptionConfigured: Boolean
        get() = whisperBaseUrl.isNotEmpty() && whisperApiKey.isNotEmpty()

    /** Sync is optional; both halves must be present. */
    val isSyncConfigured: Boolean
        get() = syncBaseUrl.isNotEmpty() && syncToken.isNotEmpty()
}
