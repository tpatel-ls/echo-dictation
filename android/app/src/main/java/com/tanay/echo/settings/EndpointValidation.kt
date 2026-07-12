package com.tanay.echo.settings

import java.net.URI

enum class EndpointError { REQUIRED, INVALID_URL, INVALID_SCHEME, CREDENTIALS, QUERY_OR_FRAGMENT }

data class EndpointValidation(val normalized: String, val error: EndpointError?)

fun validateEndpointUrl(value: String, required: Boolean = false): EndpointValidation {
    val trimmed = value.trim()
    if (trimmed.isEmpty()) {
        return EndpointValidation("", if (required) EndpointError.REQUIRED else null)
    }
    val uri = try {
        URI(trimmed)
    } catch (_: Exception) {
        return EndpointValidation("", EndpointError.INVALID_URL)
    }
    val scheme = uri.scheme?.lowercase()
    if ((scheme != "http" && scheme != "https") || uri.host.isNullOrBlank()) {
        return EndpointValidation("", EndpointError.INVALID_SCHEME)
    }
    if (uri.rawUserInfo != null) return EndpointValidation("", EndpointError.CREDENTIALS)
    if (uri.rawQuery != null || uri.rawFragment != null) {
        return EndpointValidation("", EndpointError.QUERY_OR_FRAGMENT)
    }
    val path = uri.path.orEmpty().trimEnd('/')
    val normalized = URI(scheme, null, uri.host.lowercase(), uri.port, path, null, null)
        .toString()
        .trimEnd('/')
    return EndpointValidation(normalized, null)
}
