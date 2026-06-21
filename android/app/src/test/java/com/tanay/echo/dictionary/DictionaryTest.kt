package com.tanay.echo.dictionary

import org.junit.Assert.assertEquals
import org.junit.Test

// Mirrors the applyDictionary + buildBiasPrompt sections of tests/dictionary.test.ts.
// (extractCorrections is a desktop-only learn feature and is not ported to Android.)
// Authored on desktop; runs on your machine via `./gradlew test`.
class DictionaryTest {
    private fun entry(
        word: String,
        misheard: List<String> = emptyList(),
        id: Long = 1,
        timesApplied: Int = 0,
        createdAt: Long = 1000
    ) = DictionaryEntry(id, word, misheard, "manual", createdAt, timesApplied)

    // ── applyDictionary ──────────────────────────────────────────────────────

    @Test
    fun replacesMisheardWithCanonical() {
        val e = entry("Bryan", listOf("Brian"))
        val r = applyDictionary("I saw Brian today", listOf(e))
        assertEquals("I saw Bryan today", r.text)
        assertEquals(listOf(e.id), r.appliedIds)
    }

    @Test
    fun matchesAliasCaseInsensitivelyOutputsCanonicalCasing() {
        val e = entry("Bryan", listOf("Brian"))
        assertEquals("Bryan said hi", applyDictionary("brian said hi", listOf(e)).text)
    }

    @Test
    fun respectsWordBoundaries() {
        val e = entry("Bryan", listOf("Brian"))
        val r = applyDictionary("Brianna called Brian", listOf(e))
        assertEquals("Brianna called Bryan", r.text)
        assertEquals(listOf(e.id), r.appliedIds)
    }

    @Test
    fun replacesNextToPunctuationAndPossessives() {
        val e = entry("Bryan", listOf("Brian"))
        assertEquals("Bryan, take Bryan's keys.", applyDictionary("Brian, take Brian's keys.", listOf(e)).text)
    }

    @Test
    fun handlesMultiWordAliasesWithFlexibleWhitespace() {
        val e = entry("Wispr Flow", listOf("wisp or flow"))
        assertEquals("I like Wispr Flow a lot", applyDictionary("I like wisp  or flow a lot", listOf(e)).text)
    }

    @Test
    fun prefersLongerAliases() {
        val mini = entry("Mac Mini", listOf("mac mini"), id = 1)
        val mac = entry("Mac", listOf("mac"), id = 2)
        assertEquals("my Mac Mini is fast", applyDictionary("my mac mini is fast", listOf(mini, mac)).text)
    }

    @Test
    fun fixesWrongCasingOfCanonicalWord() {
        val e = entry("GitHub")
        val r = applyDictionary("i pushed to github", listOf(e))
        assertEquals("i pushed to GitHub", r.text)
        assertEquals(listOf(e.id), r.appliedIds)
    }

    @Test
    fun doesNotCountAlreadyCorrectAsApplied() {
        val e = entry("GitHub", listOf("github"))
        val r = applyDictionary("GitHub rocks", listOf(e))
        assertEquals("GitHub rocks", r.text)
        assertEquals(emptyList<Long>(), r.appliedIds)
    }

    @Test
    fun isIdempotent() {
        val e = entry("Bryan", listOf("Brian"))
        val once = applyDictionary("ping Brian now", listOf(e))
        val twice = applyDictionary(once.text, listOf(e))
        assertEquals(once.text, twice.text)
        assertEquals(emptyList<Long>(), twice.appliedIds)
    }

    @Test
    fun appliesMultipleEntriesInOnePass() {
        val a = entry("Bryan", listOf("Brian"), id = 1)
        val b = entry("Tanay", listOf("Tanya"), id = 2)
        val r = applyDictionary("Brian met Tanya", listOf(a, b))
        assertEquals("Bryan met Tanay", r.text)
        assertEquals(listOf(a.id, b.id).sorted(), r.appliedIds.sorted())
    }

    @Test
    fun escapesRegexMetacharactersInAliases() {
        val e = entry("Node.js", listOf("node.js"))
        val r = applyDictionary("i love nodeXjs and node.js", listOf(e))
        assertEquals("i love nodeXjs and Node.js", r.text)
    }

    @Test
    fun returnsTextUnchangedForEmptyDictionary() {
        val r = applyDictionary("nothing to do", emptyList())
        assertEquals("nothing to do", r.text)
        assertEquals(emptyList<Long>(), r.appliedIds)
    }

    // ── buildBiasPrompt ──────────────────────────────────────────────────────

    @Test
    fun joinsCanonicalWordsOnly() {
        val out = buildBiasPrompt(listOf(entry("Bryan", listOf("Brian"), id = 1), entry("Tanay", listOf("Tanya"), id = 2)))
        assertEquals("Bryan, Tanay", out)
    }

    @Test
    fun ordersByTimesAppliedThenMostRecent() {
        val a = entry("Alpha", id = 1, timesApplied = 1, createdAt = 100)
        val b = entry("Beta", id = 2, timesApplied = 5, createdAt = 50)
        val c = entry("Gamma", id = 3, timesApplied = 1, createdAt = 200)
        assertEquals("Beta, Gamma, Alpha", buildBiasPrompt(listOf(a, b, c)))
    }

    @Test
    fun truncatesToCharBudgetWithoutCuttingWords() {
        val words = listOf(entry("Alexander", id = 1), entry("Bartholomew", id = 2), entry("Christopher", id = 3))
        val out = buildBiasPrompt(words, 25)
        assertEquals("Alexander, Bartholomew", out)
        assertEquals(true, out.length <= 25)
    }

    @Test
    fun returnsEmptyStringForEmptyDictionary() {
        assertEquals("", buildBiasPrompt(emptyList()))
    }
}
