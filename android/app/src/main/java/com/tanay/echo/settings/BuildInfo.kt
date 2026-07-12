package com.tanay.echo.settings

fun formatAndroidBuildInfo(
    versionName: String,
    versionCode: Int,
    androidVersion: String,
    abi: String,
    debug: Boolean,
): String {
    val architecture = abi.ifBlank { "unknown" }
    val channel = if (debug) "debug" else "release"
    return "Echo $versionName ($versionCode) · Android $androidVersion $architecture · $channel"
}
