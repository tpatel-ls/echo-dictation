package com.tanay.echo.settings

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
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

/**
 * One-screen setup: point Echo at your Whisper (and optional Claude) + sync endpoints, then the
 * two one-tap actions every IME needs — enable the keyboard in system settings and grant the
 * microphone. Values are stored in EncryptedSharedPreferences via EchoSettings. The keyboard
 * reads them live, so there's no apply step beyond Save.
 */
class SettingsActivity : AppCompatActivity() {
    private lateinit var settings: EchoSettings
    private lateinit var grantMicButton: MaterialButton

    private val requestMic =
        registerForActivityResult(ActivityResultContracts.RequestPermission()) { refreshMicButton() }

    private lateinit var whisperBaseUrl: TextInputEditText
    private lateinit var whisperApiKey: TextInputEditText
    private lateinit var whisperModel: TextInputEditText
    private lateinit var syncBaseUrl: TextInputEditText
    private lateinit var syncToken: TextInputEditText
    private lateinit var cleanupEnabled: MaterialSwitch
    private lateinit var claudeBaseUrl: TextInputEditText
    private lateinit var claudeApiKey: TextInputEditText
    private lateinit var claudeModel: TextInputEditText

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        settings = EchoSettings(this)
        setContentView(R.layout.activity_settings)

        whisperBaseUrl = findViewById(R.id.whisper_base_url)
        whisperApiKey = findViewById(R.id.whisper_api_key)
        whisperModel = findViewById(R.id.whisper_model)
        syncBaseUrl = findViewById(R.id.sync_base_url)
        syncToken = findViewById(R.id.sync_token)
        cleanupEnabled = findViewById(R.id.cleanup_enabled)
        claudeBaseUrl = findViewById(R.id.claude_base_url)
        claudeApiKey = findViewById(R.id.claude_api_key)
        claudeModel = findViewById(R.id.claude_model)
        grantMicButton = findViewById(R.id.grant_mic)

        load()

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
    }

    override fun onResume() {
        super.onResume()
        refreshMicButton() // reflect a grant made from the app-info screen
    }

    private fun load() {
        whisperBaseUrl.setText(settings.whisperBaseUrl)
        whisperApiKey.setText(settings.whisperApiKey)
        whisperModel.setText(settings.whisperModel)
        syncBaseUrl.setText(settings.syncBaseUrl)
        syncToken.setText(settings.syncToken)
        cleanupEnabled.isChecked = settings.cleanupEnabled
        claudeBaseUrl.setText(settings.claudeBaseUrl)
        claudeApiKey.setText(settings.claudeApiKey)
        claudeModel.setText(settings.claudeModel)
    }

    private fun save() {
        settings.whisperBaseUrl = text(whisperBaseUrl)
        settings.whisperApiKey = text(whisperApiKey)
        settings.whisperModel = text(whisperModel)
        settings.syncBaseUrl = text(syncBaseUrl)
        settings.syncToken = text(syncToken)
        settings.cleanupEnabled = cleanupEnabled.isChecked
        settings.claudeBaseUrl = text(claudeBaseUrl)
        settings.claudeApiKey = text(claudeApiKey)
        settings.claudeModel = text(claudeModel)
        Toast.makeText(this, R.string.settings_saved, Toast.LENGTH_SHORT).show()
    }

    private fun refreshMicButton() {
        grantMicButton.setText(if (hasMic()) R.string.mic_granted else R.string.grant_mic)
        grantMicButton.isEnabled = !hasMic()
    }

    private fun hasMic(): Boolean =
        ContextCompat.checkSelfPermission(this, Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    private fun text(field: TextInputEditText): String = field.text?.toString().orEmpty()
}
