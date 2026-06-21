package com.tanay.echo.settings

import android.content.Context
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import com.tanay.echo.BuildConfig

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

    init {
        seedDefaults()
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

    /** Whether the system-wide floating mic button is enabled (starts FloatingButtonService). */
    var floatingEnabled: Boolean
        get() = prefs.getBoolean("floatingEnabled", false)
        set(v) = prefs.edit().putBoolean("floatingEnabled", v).apply()

    /** Last dragged position of the floating bubble, in pixels; -1 ⇒ use the default (top-right). */
    var floatingX: Int
        get() = prefs.getInt("floatingX", -1)
        set(v) = prefs.edit().putInt("floatingX", v).apply()

    var floatingY: Int
        get() = prefs.getInt("floatingY", -1)
        set(v) = prefs.edit().putInt("floatingY", v).apply()

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

    /** On first run (or whenever a value is still unset), seed from the build-time defaults baked
     * in via BuildConfig — a personal pre-configured build. Per-key + idempotent: a value the user
     * has set is never overwritten, and a default added in a later build seeds on the next launch. */
    private fun seedDefaults() {
        val e = prefs.edit()
        var changed = false
        fun seed(key: String, value: String) {
            // Fill a baked default when the user hasn't set a real value yet — covers a fresh install
            // AND an upgrade where an earlier build wrote an empty string (e.g. syncToken before it had
            // a value). A non-empty user-set value is never overwritten.
            if (value.isNotEmpty() && prefs.getString(key, "").isNullOrEmpty()) {
                e.putString(key, value)
                changed = true
            }
        }
        seed("whisperBaseUrl", BuildConfig.DEFAULT_WHISPER_BASE_URL)
        seed("whisperApiKey", BuildConfig.DEFAULT_WHISPER_API_KEY)
        seed("whisperModel", BuildConfig.DEFAULT_WHISPER_MODEL)
        seed("claudeBaseUrl", BuildConfig.DEFAULT_CLAUDE_BASE_URL)
        seed("claudeApiKey", BuildConfig.DEFAULT_CLAUDE_API_KEY)
        seed("claudeModel", BuildConfig.DEFAULT_CLAUDE_MODEL)
        seed("syncBaseUrl", BuildConfig.DEFAULT_SYNC_BASE_URL)
        seed("syncToken", BuildConfig.DEFAULT_SYNC_TOKEN)
        if (changed) e.commit()
    }
}

