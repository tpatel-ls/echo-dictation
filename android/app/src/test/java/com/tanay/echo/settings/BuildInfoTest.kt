package com.tanay.echo.settings

import org.junit.Assert.assertEquals
import org.junit.Test

class BuildInfoTest {
    @Test
    fun `maps Android build metadata to a compact label`() {
        assertEquals(
            "Echo 1.2.3 (45) · Android 14 arm64-v8a · release",
            formatAndroidBuildInfo("1.2.3", 45, "14", "arm64-v8a", debug = false),
        )
        assertEquals(
            "Echo 1.2.3 (45) · Android 14 unknown · debug",
            formatAndroidBuildInfo("1.2.3", 45, "14", "", debug = true),
        )
    }
}
