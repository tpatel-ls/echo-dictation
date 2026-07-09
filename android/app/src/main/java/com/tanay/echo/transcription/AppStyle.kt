package com.tanay.echo.transcription

/**
 * Maps the app you dictated into to a writing style + how much effort to spend on it. This is what
 * makes Echo's cleanup context-aware (Wispr-style): chat apps stay instant (no AI pass), email/docs
 * get polished, and the register is tuned per app. Pure + JVM-testable; designed to port to desktop.
 */

enum class Register { CASUAL, PROFESSIONAL, TECHNICAL, NEUTRAL, INFER }

/**
 * [register] = the writing register to ask the cleanup model for; [runCleanup] = whether to spend the
 * AI pass at all. `runCleanup = false` means instant: raw transcription + dictionary only, no wait.
 */
data class StyleProfile(val register: Register, val runCleanup: Boolean)

// Every register gets the AI pass (Willow-style always-on cleanup); casual apps just get a lighter
// touch. Unknown packages fall through to INFER so the model adapts from the package name.
private val CASUAL_APPS = setOf(
    "com.whatsapp", "com.whatsapp.w4b",          // WhatsApp / Business
    "org.telegram.messenger", "org.telegram.plus",
    "com.facebook.orca", "com.facebook.mlite",   // Messenger
    "com.instagram.android",
    "com.snapchat.android",
    "com.discord",
    "org.thoughtcrime.securesms",                // Signal
    "com.viber.voip",
    "com.google.android.apps.messaging",         // Google Messages
    "com.samsung.android.messaging",
    "com.twitter.android", "com.x.android",
    "com.reddit.frontpage",
    "com.Slack",
    "com.microsoft.teams",
)
private val PROFESSIONAL_APPS = setOf(
    "com.google.android.gm",                     // Gmail
    "com.microsoft.office.outlook",
    "com.samsung.android.email.provider",
    "com.yahoo.mobile.client.android.mail",
    "ch.protonmail.android",
    "com.linkedin.android",
)
private val NEUTRAL_APPS = setOf(
    "com.google.android.keep",
    "com.google.android.apps.docs.editors.docs", // Google Docs
    "com.microsoft.office.word",
    "com.notion.id",
    "md.obsidian",
    "com.evernote",
)
private val TECHNICAL_APPS = setOf(
    "com.termux",
    "com.github.android",
)
// Browsers can't reveal the site (Gmail-web vs Reddit-web look identical), so polish neutrally.
private val BROWSERS = setOf(
    "com.android.chrome",
    "org.mozilla.firefox",
    "com.brave.browser",
    "com.microsoft.emmx",                        // Edge
    "com.opera.browser", "com.opera.mini.native",
    "com.duckduckgo.mobile.android",
    "com.sec.android.app.sbrowser",              // Samsung Internet
)

fun styleForPackage(pkg: String): StyleProfile = when {
    pkg.isBlank()             -> StyleProfile(Register.NEUTRAL, runCleanup = true)
    pkg in CASUAL_APPS        -> StyleProfile(Register.CASUAL, runCleanup = true)
    pkg in PROFESSIONAL_APPS  -> StyleProfile(Register.PROFESSIONAL, runCleanup = true)
    pkg in NEUTRAL_APPS       -> StyleProfile(Register.NEUTRAL, runCleanup = true)
    pkg in TECHNICAL_APPS     -> StyleProfile(Register.TECHNICAL, runCleanup = true)
    pkg in BROWSERS           -> StyleProfile(Register.NEUTRAL, runCleanup = true)
    else                      -> StyleProfile(Register.INFER, runCleanup = true)
}

/**
 * The extra system-prompt sentence appended for [register], or null for NEUTRAL (the base cleanup
 * prompt already does neutral tidy-up). [appHint] (the package) is woven in only for INFER, and only
 * when non-blank.
 */
fun styleDirective(register: Register, appHint: String? = null): String? = when (register) {
    Register.NEUTRAL -> null
    Register.CASUAL -> "Keep it casual and conversational, like a quick chat message: a light touch, " +
        "contractions are fine, and don't over-format or make it stiff."
    Register.PROFESSIONAL -> "Format as polished, professional writing suitable for an email or formal " +
        "message: complete sentences, proper capitalization and punctuation, and no slang."
    Register.TECHNICAL -> "This is going into code or a technical tool: be concise and precise, keep all " +
        "technical terms and identifiers exact, and don't add prose or pleasantries."
    Register.INFER -> {
        val where = appHint?.takeIf { it.isNotBlank() }?.let { " (\"$it\")" } ?: ""
        "Infer the tone and formatting a careful writer would use for the app$where you're writing into, " +
            "and format accordingly."
    }
}
