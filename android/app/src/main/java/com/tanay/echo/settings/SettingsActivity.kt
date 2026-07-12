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
import com.google.android.material.button.MaterialButtonToggleGroup
import com.google.android.material.materialswitch.MaterialSwitch
import com.google.android.material.textfield.TextInputEditText
import com.google.android.material.textfield.TextInputLayout
import com.tanay.echo.R
import com.tanay.echo.floating.EchoAccessibilityService
import com.tanay.echo.floating.FloatingButtonService
import com.tanay.echo.transcription.AccuracyMode

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
    private lateinit var whisperBaseUrlLayout: TextInputLayout
    private lateinit var whisperApiKey: TextInputEditText
    private lateinit var whisperModel: TextInputEditText
    private lateinit var language: TextInputEditText
    private lateinit var accuracyMode: MaterialButtonToggleGroup
    private lateinit var accuracyModel: TextInputEditText
    private lateinit var whisperMode: MaterialSwitch
    private lateinit var syncBaseUrl: TextInputEditText
    private lateinit var syncBaseUrlLayout: TextInputLayout
    private lateinit var syncToken: TextInputEditText
    private lateinit var contextTone: MaterialSwitch
    private lateinit var claudeBaseUrl: TextInputEditText
    private lateinit var claudeBaseUrlLayout: TextInputLayout
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
        whisperBaseUrlLayout = findViewById(R.id.whisper_base_url_layout)
        whisperApiKey = findViewById(R.id.whisper_api_key)
        whisperModel = findViewById(R.id.whisper_model)
        language = findViewById(R.id.language)
        accuracyMode = findViewById(R.id.accuracy_mode)
        accuracyModel = findViewById(R.id.accuracy_model)
        whisperMode = findViewById(R.id.whisper_mode)
        syncBaseUrl = findViewById(R.id.sync_base_url)
        syncBaseUrlLayout = findViewById(R.id.sync_base_url_layout)
        syncToken = findViewById(R.id.sync_token)
        contextTone = findViewById(R.id.context_tone_enabled)
        claudeBaseUrl = findViewById(R.id.claude_base_url)
        claudeBaseUrlLayout = findViewById(R.id.claude_base_url_layout)
        claudeApiKey = findViewById(R.id.claude_api_key)
        claudeModel = findViewById(R.id.claude_model)
        grantMicButton = findViewById(R.id.grant_mic)

        floatingEnabled = findViewById(R.id.floating_enabled)
        floatingOverlay = findViewById(R.id.floating_overlay)
        floatingA11y = findViewById(R.id.floating_a11y)
        floatingNotif = findViewById(R.id.floating_notif)

        load()
        bindEndpointValidation(whisperBaseUrl, whisperBaseUrlLayout, required = true)
        bindEndpointValidation(syncBaseUrl, syncBaseUrlLayout, required = false)
        bindEndpointValidation(claudeBaseUrl, claudeBaseUrlLayout, required = false)

        // Re-establish the bubble if it was enabled but isn't running (after a reboot or memory kill).
        if (settings.floatingEnabled && Settings.canDrawOverlays(this) && a11yEnabled() && hasMic()) {
            FloatingButtonService.start(this)
        }

        findViewById<MaterialButton>(R.id.save).setOnClickListener { save() }
        findViewById<MaterialButton>(R.id.manage_snippets).setOnClickListener {
            startActivity(Intent(this, SnippetsActivity::class.java))
        }
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
        language.setText(settings.language)
        accuracyMode.check(
            when (settings.accuracyMode) {
                AccuracyMode.FAST -> R.id.accuracy_fast
                AccuracyMode.BALANCED -> R.id.accuracy_balanced
                AccuracyMode.MAXIMUM -> R.id.accuracy_maximum
            },
        )
        accuracyModel.setText(settings.accuracyModel)
        whisperMode.isChecked = settings.whisperMode
        syncBaseUrl.setText(settings.syncBaseUrl)
        syncToken.setText(settings.syncToken)
        contextTone.isChecked = settings.contextToneEnabled
        claudeBaseUrl.setText(settings.claudeBaseUrl)
        claudeApiKey.setText(settings.claudeApiKey)
        claudeModel.setText(settings.claudeModel)
        floatingEnabled.isChecked = settings.floatingEnabled
    }

    private fun save() {
        val whisperEndpoint = showEndpointError(whisperBaseUrl, whisperBaseUrlLayout, required = true)
        val syncEndpoint = showEndpointError(syncBaseUrl, syncBaseUrlLayout, required = false)
        val claudeEndpoint = showEndpointError(claudeBaseUrl, claudeBaseUrlLayout, required = false)
        if (whisperEndpoint.error != null || syncEndpoint.error != null || claudeEndpoint.error != null) return
        settings.whisperBaseUrl = whisperEndpoint.normalized
        settings.whisperApiKey = text(whisperApiKey)
        settings.whisperModel = text(whisperModel)
        settings.language = text(language)
        settings.accuracyMode = when (accuracyMode.checkedButtonId) {
            R.id.accuracy_fast -> AccuracyMode.FAST
            R.id.accuracy_balanced -> AccuracyMode.BALANCED
            else -> AccuracyMode.MAXIMUM
        }
        settings.accuracyModel = text(accuracyModel)
        settings.whisperMode = whisperMode.isChecked
        settings.syncBaseUrl = syncEndpoint.normalized
        settings.syncToken = text(syncToken)
        settings.contextToneEnabled = contextTone.isChecked
        settings.claudeBaseUrl = claudeEndpoint.normalized
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

    private fun bindEndpointValidation(field: TextInputEditText, layout: TextInputLayout, required: Boolean) {
        field.setOnFocusChangeListener { _, focused ->
            if (!focused) showEndpointError(field, layout, required)
        }
    }

    private fun showEndpointError(
        field: TextInputEditText,
        layout: TextInputLayout,
        required: Boolean,
    ): EndpointValidation {
        val result = validateEndpointUrl(text(field), required)
        layout.error = when (result.error) {
            EndpointError.REQUIRED -> getString(R.string.endpoint_required)
            EndpointError.INVALID_URL -> getString(R.string.endpoint_invalid_url)
            EndpointError.INVALID_SCHEME -> getString(R.string.endpoint_invalid_scheme)
            EndpointError.CREDENTIALS -> getString(R.string.endpoint_credentials)
            EndpointError.QUERY_OR_FRAGMENT -> getString(R.string.endpoint_query_fragment)
            null -> null
        }
        return result
    }
}
