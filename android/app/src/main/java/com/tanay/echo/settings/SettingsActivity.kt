package com.tanay.echo.settings

import android.Manifest
import android.content.ComponentName
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.provider.Settings
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import com.google.android.material.button.MaterialButton
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.textfield.TextInputEditText
import com.tanay.echo.R
import com.tanay.echo.floating.EchoAccessibilityService
import com.tanay.echo.floating.FloatingButtonService

/**
 * One-screen setup: point Echo at your Whisper (and optional Claude) + sync endpoints, then the
 * one-tap actions to enable the keyboard, grant the mic, and turn on the floating mic button
 * (which needs draw-over-apps + accessibility). Values are stored in EncryptedSharedPreferences via
 * EchoSettings; the keyboard and the floating button read them live, so there's no apply step.
 */
class SettingsActivity : AppCompatActivity() {
    private lateinit var settings: EchoSettings
    private lateinit var grantMicButton: MaterialButton

    private val requestMic =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { refreshMicButton() }
    private val requestNotif =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { refreshFloating() }

    private lateinit var whisperBaseUrl: TextInputEditText
    private lateinit var whisperApiKey: TextInputEditText
    private lateinit var whisperModel: TextInputEditText
    private lateinit var syncBaseUrl: TextInputEditText
    private lateinit var syncToken: TextInputEditText
    private lateinit var contextTone: MaterialSwitch
    private lateinit var claudeBaseUrl: TextInputEditText
    private lateinit var claudeApiKey: TextInputEditText
    private lateinit var claudeModel: TextInputEditText

    private lateinit var floatingEnabled: MaterialSwitch
    private lateinit var floatingOverlay: MaterialButton
    private lateinit var floatingA11y: MaterialButton
    private lateinit var floatingNotif: MaterialButton

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = EchoSettings(this)
        setContentView(R.layout.activity_settings)

        whisperBaseUrl = findViewById(R.id.whisper_base_url)
        whisperApiKey = findViewById(R.id.whisper_api_key)
        whisperModel = findViewById(R.id.whisper_model)
        syncBaseUrl = findViewById(R.id.sync_base_url)
        syncToken = findViewById(R.id.sync_token)
        contextTone = findViewById(R.id.context_tone_enabled)
        claudeBaseUrl = findViewById(R.id.claude_base_url)
        claudeApiKey = findViewById(R.id.claude_api_key)
        claudeModel = findViewById(R.id.claude_model)
        grantMicButton = findViewById(R.id.grant_mic)

        floatingEnabled = findViewById(R.id.floating_enabled)
        floatingOverlay = findViewById(R.id.floating_overlay)
        floatingA11y = findViewById(R.id.floating_a11y)
        floatingNotif = findViewById(R.id.floating_notif)

        load()

        // Re-establish the bubble if it was enabled but isn't running (after a reboot or memory kill).
        if (settings.floatingEnabled && Settings.canDrawOverlays(this) && a11yEnabled() && hasMic()) {
            FloatingButtonService.start(this)
        }

        findViewById<MaterialButton>(R.id.save).setOnClickListener { save() }
        findViewById<MaterialButton>(R.id.enable_keyboard).setOnClickListener {
            startActivity(Intent(Settings.ACTION_INPUT_METHOD_SETTINGS))
        }
        grantMicButton.setOnClickListener {
            if (hasMic()) {
                Toast.makeText(this, R.string.mic_already_granted, Toast.LENGTH_SHORT).show()
            } else {
                requestMic.launch(Manifest.permission.RECORD_AUDIO)
            }
        }

        floatingOverlay.setOnClickListener {
            startActivity(Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:$packageName")))
        }
        floatingA11y.setOnClickListener {
            startActivity(Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS))
            Toast.makeText(this, R.string.floating_a11y_toast, Toast.LENGTH_LONG).show()
        }
        floatingNotif.setOnClickListener {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                requestNotif.launch(Manifest.permission.POST_NOTIFICATIONS)
            } else {
                Toast.makeText(this, R.string.floating_perm_notif_done, Toast.LENGTH_SHORT).show()
            }
        }
        floatingEnabled.setOnCheckedChangeListener { _, checked ->
            if (checked) {
                if (!Settings.canDrawOverlays(this) || !a11yEnabled() || !hasMic()) {
                    Toast.makeText(this, R.string.floating_need_perms, Toast.LENGTH_LONG).show()
                    floatingEnabled.isChecked = false
                    return@setOnCheckedChangeListener
                }
                settings.floatingEnabled = true
                FloatingButtonService.start(this)
            } else {
                settings.floatingEnabled = false
                FloatingButtonService.stop(this)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        refreshMicButton()
        refreshFloating()
    }

    private fun load() {
        whisperBaseUrl.setText(settings.whisperBaseUrl)
        whisperApiKey.setText(settings.whisperApiKey)
        whisperModel.setText(settings.whisperModel)
        syncBaseUrl.setText(settings.syncBaseUrl)
        syncToken.setText(settings.syncToken)
        contextTone.isChecked = settings.contextToneEnabled
        claudeBaseUrl.setText(settings.claudeBaseUrl)
        claudeApiKey.setText(settings.claudeApiKey)
        claudeModel.setText(settings.claudeModel)
        floatingEnabled.isChecked = settings.floatingEnabled
    }

    private fun save() {
        settings.whisperBaseUrl = text(whisperBaseUrl)
        settings.whisperApiKey = text(whisperApiKey)
        settings.whisperModel = text(whisperModel)
        settings.syncBaseUrl = text(syncBaseUrl)
        settings.syncToken = text(syncToken)
        settings.contextToneEnabled = contextTone.isChecked
        settings.claudeBaseUrl = text(claudeBaseUrl)
        settings.claudeApiKey = text(claudeApiKey)
        settings.claudeModel = text(claudeModel)
        Toast.makeText(this, R.string.settings_saved, Toast.LENGTH_SHORT).show()
    }

    private fun refreshMicButton() {
        grantMicButton.setText(if (hasMic()) R.string.mic_granted else R.string.grant_mic)
        grantMicButton.isEnabled = !hasMic()
    }

    private fun refreshFloating() {
        val overlay = Settings.canDrawOverlays(this)
        floatingOverlay.setText(if (overlay) R.string.floating_perm_overlay_done else R.string.floating_perm_overlay)
        floatingOverlay.isEnabled = !overlay
        val a11y = a11yEnabled()
        floatingA11y.setText(if (a11y) R.string.floating_perm_a11y_done else R.string.floating_perm_a11y)
        floatingA11y.isEnabled = !a11y
        val notif = notifGranted()
        floatingNotif.setText(if (notif) R.string.floating_perm_notif_done else R.string.floating_perm_notif)
        floatingNotif.isEnabled = !notif
    }

    private fun a11yEnabled(): Boolean {
        val flat = Settings.Secure.getString(contentResolver, Settings.Secure.ENABLED_ACCESSIBILITY_SERVICES) ?: return false
        val cn = ComponentName(this, EchoAccessibilityService::class.java).flattenToString()
        return flat.split(':').any { it.equals(cn, ignoreCase = true) }
    }

    private fun notifGranted(): Boolean =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
        } else {
            true
        }

    private fun hasMic(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun text(field: TextInputEditText): String = field.text?.toString().orEmpty()
}
