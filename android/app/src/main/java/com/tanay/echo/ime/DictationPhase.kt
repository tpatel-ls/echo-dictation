package com.tanay.echo.ime

/** The dictation lifecycle shown in the keyboard's status pill — mirrors the desktop overlay's
 * DictationPhase (src/shared/types.ts). */
enum class DictationPhase { IDLE, LISTENING, TRANSCRIBING, INSERTED, EMPTY, ERROR }
