import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("org.jetbrains.kotlin.plugin.serialization")
    id("com.google.devtools.ksp")
}

// Optional build-time defaults for endpoints/keys — read from a gitignored file so a personal
// build can ship pre-configured, while the values never touch git. Mirrors the desktop's
// secrets.local.json seed. Absent file ⇒ empty defaults ⇒ the app prompts for setup as normal.
val echoDefaults = Properties().apply {
    val f = rootProject.file("defaults.local.properties")
    if (f.exists()) f.inputStream().use { load(it) }
}
fun echoDefault(key: String): String =
    (echoDefaults.getProperty(key) ?: "").replace("\\", "\\\\").replace("\"", "\\\"")

android {
    namespace = "com.tanay.echo"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.tanay.echo"
        minSdk = 26 // Android 8.0 — enables adaptive icons + EncryptedSharedPreferences
        targetSdk = 34
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField("String", "DEFAULT_WHISPER_BASE_URL", "\"${echoDefault("whisperBaseUrl")}\"")
        buildConfigField("String", "DEFAULT_WHISPER_API_KEY", "\"${echoDefault("whisperApiKey")}\"")
        buildConfigField("String", "DEFAULT_WHISPER_MODEL", "\"${echoDefault("whisperModel")}\"")
        buildConfigField("String", "DEFAULT_CLAUDE_BASE_URL", "\"${echoDefault("claudeBaseUrl")}\"")
        buildConfigField("String", "DEFAULT_CLAUDE_API_KEY", "\"${echoDefault("claudeApiKey")}\"")
        buildConfigField("String", "DEFAULT_CLAUDE_MODEL", "\"${echoDefault("claudeModel")}\"")
        buildConfigField("String", "DEFAULT_SYNC_BASE_URL", "\"${echoDefault("syncBaseUrl")}\"")
        buildConfigField("String", "DEFAULT_SYNC_TOKEN", "\"${echoDefault("syncToken")}\"")
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
    buildFeatures {
        buildConfig = true
        viewBinding = true
    }
}

dependencies {
    implementation("androidx.core:core-ktx:1.13.1")
    implementation("androidx.appcompat:appcompat:1.7.0")
    implementation("com.google.android.material:material:1.12.0")
    implementation("org.jetbrains.kotlinx:kotlinx-coroutines-android:1.8.1")
    implementation("org.jetbrains.kotlinx:kotlinx-serialization-json:1.6.3")
    implementation("com.squareup.okhttp3:okhttp:4.12.0")
    implementation("androidx.security:security-crypto:1.1.0-alpha06")

    val room = "2.6.1"
    implementation("androidx.room:room-runtime:$room")
    implementation("androidx.room:room-ktx:$room")
    ksp("androidx.room:room-compiler:$room")

    // Pure-logic ports are tested here on a plain JVM (no emulator) — see src/test.
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.jetbrains.kotlinx:kotlinx-coroutines-test:1.8.1")
    testImplementation("com.squareup.okhttp3:mockwebserver:4.12.0")
}
