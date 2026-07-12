package com.tanay.echo.settings

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class EndpointValidationTest {
    @Test
    fun `required and optional empty endpoints are distinguished`() {
        assertEquals(EndpointError.REQUIRED, validateEndpointUrl("", required = true).error)
        assertNull(validateEndpointUrl("  ", required = false).error)
    }

    @Test
    fun `https and tailnet http endpoints normalize`() {
        assertEquals(
            "https://proxy.example/v1",
            validateEndpointUrl(" HTTPS://Proxy.Example/v1/ ", required = true).normalized,
        )
        assertNull(validateEndpointUrl("http://mac.local:8787", required = true).error)
    }

    @Test
    fun `invalid schemes credentials queries and fragments are rejected`() {
        assertEquals(EndpointError.INVALID_SCHEME, validateEndpointUrl("ftp://proxy.example", true).error)
        assertEquals(EndpointError.CREDENTIALS, validateEndpointUrl("https://u:p@proxy.example", true).error)
        assertEquals(EndpointError.QUERY_OR_FRAGMENT, validateEndpointUrl("https://proxy.example?q=1", true).error)
        assertEquals(EndpointError.QUERY_OR_FRAGMENT, validateEndpointUrl("https://proxy.example#x", true).error)
        assertTrue(validateEndpointUrl("not a url", true).error != null)
    }
}
