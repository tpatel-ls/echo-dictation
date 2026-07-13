// Top-level build file. Plugin versions are declared once here and applied per-module.
// Versions are a known-compatible set (AGP 8.5 / Kotlin 1.9.24 / KSP / Room 2.6.1); bump
// them in Android Studio if it offers, they are not pinned for any deep reason.
plugins {
    id("com.android.application") version "9.2.1" apply false
    id("org.jetbrains.kotlin.android") version "1.9.24" apply false
    id("org.jetbrains.kotlin.plugin.serialization") version "1.9.24" apply false
    id("com.google.devtools.ksp") version "1.9.24-1.0.20" apply false
}
