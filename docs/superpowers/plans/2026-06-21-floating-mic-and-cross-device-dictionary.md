# Floating Dictation Button, Wispr Overlay & Cross-Device Dictionary — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Echo a system-wide floating mic button on Android (no keyboard switching), turn on cross-device dictionary/history sync so corrections apply everywhere, and restyle the desktop recording overlay to a minimal Wispr-Flow look.

**Architecture:** Reuse the existing Android `DictationController` pipeline unchanged; add a foreground `FloatingButtonService` that hosts a `WindowManager` overlay bubble and routes transcribed text to a new `EchoAccessibilityService` that pastes into the focused field of any app. Sync is already correct in code — it only needs a shared bearer token wired through server + desktop + Android. The desktop overlay is a renderer-only restyle.

**Tech Stack:** Kotlin 1.9.24 / AGP 8.5.2 / Gradle 8.7 / minSdk 26 / targetSdk 34 (Android); Electron + TypeScript + React + Vitest (desktop); Node/tsx sync server with sql.js.

## Global Constraints

- **No Claude attribution in git history** — no `Co-Authored-By`, no "Generated with" footers.
- **Commit author email:** `214253472+tpatel-ls@users.noreply.github.com` (already the configured default).
- **Secrets are gitignored and never committed:** `secrets.local.json`, `android/defaults.local.properties`. Public-facing/committed files must not contain tailnet hostnames or key material.
- **Android toolchain (local):** `JAVA_HOME=C:\Users\Tanay\scoop\apps\temurin17-jdk\current`, `ANDROID_HOME=C:\Users\Tanay\scoop\apps\android-clt\current`; build with `C:\Users\Tanay\scoop\apps\gradle87\gradle-8.7\bin\gradle.bat -p android --no-daemon --console=plain <task>`.
- **TDD for pure logic** (`src/shared`, stores, clients, Kotlin pure helpers): test first, watch it fail, minimal code, watch it pass.
- **Android Kotlin caveat:** `RegexOption.UNICODE_CASE` does not exist — use inline `(?iu)` flags.
- **Verify each task before moving to the next** (per user). Each task ends with a green build/test.

---

## PHASE C — Turn on cross-device sync (dictionary + history)

> The dictionary/sync code is already correct on both sides. The gap is a never-configured shared token. These tasks wire it and verify the round-trip.

### Task C1: Confirm how desktop sources `syncBaseUrl` / `syncToken`

**Files:**
- Read: `src/main/store/settings.ts` (the `SettingsStore` — `getSettings()` and `getSecrets()`), `src/main/store/secrets.ts` if present.
- Read: `src/main/index.ts:67-83` (the sync runner closure).

**Interfaces:**
- Produces (for C3): the exact mechanism to set `syncBaseUrl` (a `Settings` field) and `syncToken` (a `Secrets` field) — whether each is seeded from `secrets.local.json`, defaulted in code, or only settable via the Settings UI/IPC.

- [ ] **Step 1:** Read `SettingsStore` and find where `syncBaseUrl` (settings) and `syncToken` (secrets) come from, and whether `secrets.local.json` seeds the secrets store on first run.
- [ ] **Step 2:** Write a 3-line note at the top of this task's section in the plan (in the commit message of C3) recording the mechanism. No code change in this task.

*No commit — investigation only; findings feed C3.*

### Task C2: Generate the shared token and smoke-test the sync server locally

**Files:**
- Read: `package.json` (the `sync-server` script), `src/server/http.ts`.
- Create (gitignored, not committed): a local `.env`-style token only in the shell session.

- [ ] **Step 1: Generate a strong token**

Run (PowerShell):
```powershell
$tok = -join ((48..57)+(65..90)+(97..122) | Get-Random -Count 48 | ForEach-Object {[char]$_}); $tok
```
Record the value (this is the shared `SYNC_TOKEN`). Do **not** commit it.

- [ ] **Step 2: Start the server locally for a smoke test**

Run:
```powershell
$env:SYNC_TOKEN=$tok; $env:SYNC_PORT='8787'; npm run sync-server
```
Expected: `[echo-sync] listening on http://0.0.0.0:8787`.

- [ ] **Step 3: Health + auth + round-trip checks** (second shell)

```powershell
# health
Invoke-RestMethod http://127.0.0.1:8787/health        # -> ok = True
# 401 on bad token
try { Invoke-RestMethod http://127.0.0.1:8787/sync/dictionary?since=0 -Headers @{Authorization='Bearer wrong'} } catch { $_.Exception.Response.StatusCode }  # -> Unauthorized
# push a dictionary record
$body = @{ records = @(@{ uuid='test-uuid-1'; updated_at=1; deleted=$false; payload=(@{word='Bryan';misheard='["Brian"]';source='manual';created_at=1;times_applied=0}|ConvertTo-Json -Compress) }) } | ConvertTo-Json -Depth 6
Invoke-RestMethod -Method Post http://127.0.0.1:8787/sync/dictionary -Headers @{Authorization="Bearer $tok"} -ContentType 'application/json' -Body $body   # -> applied = 1
# pull it back
Invoke-RestMethod http://127.0.0.1:8787/sync/dictionary?since=0 -Headers @{Authorization="Bearer $tok"}   # -> records contains test-uuid-1
```
Expected: health ok, Unauthorized on bad token, `applied=1`, pull returns the record. (Exact field names per `src/server/http.ts` — adjust casing if the smoke test reveals a mismatch.)

- [ ] **Step 4:** Stop the local server (Ctrl-C). No commit (no repo changes).

### Task C3: Wire desktop + Android to the token; deploy server to the always-on host

**Files:**
- Modify (gitignored): `secrets.local.json` — add `syncToken` (and `syncBaseUrl` if that is how the desktop sources it, per C1).
- Modify (gitignored): `android/defaults.local.properties:10` — set `syncToken=<token>`.
- Modify: `src/server/index.ts:6-7` — generalize the "Mac Mini" comment to "tailnet host (GB10)".

**Interfaces:**
- Consumes (from C1): the desktop config mechanism; (from C2): the token value and verified server contract.

- [ ] **Step 1:** Per C1's finding, set the desktop `syncToken` and `syncBaseUrl=http://whisper.tail7e0fa0.ts.net:8787` (in `secrets.local.json` and/or via the Settings store). Confirm `git check-ignore secrets.local.json` returns the path (still ignored).
- [ ] **Step 2:** Set `syncToken=<token>` in `android/defaults.local.properties`. Confirm `git check-ignore android/defaults.local.properties` returns the path.
- [ ] **Step 3:** Edit `src/server/index.ts` comment (lines 6-7): replace "Mac Mini" wording with "tailnet host (e.g. the GB10)". This is the only committed change in this task.
- [ ] **Step 4: Deploy the server to the GB10.** Determine reachability of `whisper.tail7e0fa0.ts.net` for a deploy (SSH or existing process manager). If reachable from this session, start `SYNC_TOKEN=<token> npm run sync-server` there and re-run the C2 health check against `http://whisper.tail7e0fa0.ts.net:8787/health`. If not reachable from this session, record the exact command for the user to run on the GB10 and verify health once it is up.
- [ ] **Step 5: Commit** (only the server comment generalization):
```bash
git add src/server/index.ts
git commit -m "docs(server): generalize sync host comment to tailnet host"
```

### Task C4: Verify the dictionary round-trips end to end

**Files:** none (verification).

- [ ] **Step 1:** On the desktop, ensure a dictionary entry exists mapping misheard `Brian` → word `Bryan` (add it via the desktop dictionary UI if absent). Confirm it is applied locally (desktop dictation of "Brian" yields "Bryan").
- [ ] **Step 2:** Confirm the desktop pushed it: pull `/sync/dictionary?since=0` from the running server and see the `Bryan`/`["Brian"]` record.
- [ ] **Step 3 (on-device, user-assisted):** With the new APK (built in Phase A, or an interim rebuild), open the Echo keyboard once to trigger a sync pull, then dictate "Brian" and confirm it inserts "Bryan". Also confirm a phone-made correction appears on the desktop after its next sync pass.
- [ ] **Step 4:** No commit (verification). Report results before starting Phase B.

---

## PHASE B — Desktop overlay restyle (Wispr aesthetic)

> Renderer-only. Window mechanics in `src/main/windows.ts` and the state controller in `src/main/dictation.ts` stay unchanged. Files: `src/renderer/overlay/overlay.css`, `Overlay.tsx`, `Waveform.tsx`.

### Task B1: Restyle the pill and remove the red dot + timer

**Files:**
- Modify: `src/renderer/overlay/overlay.css` (`.ov-capsule`, `.ov-rec`, `.ov-time`).
- Modify: `src/renderer/overlay/Overlay.tsx` (the `listening` branch — drop the `<span className="ov-rec"/>` and `<span className="ov-time">`).

- [ ] **Step 1:** In `Overlay.tsx`, in the `phase === 'listening'` block, remove the red dot span and the timer span, leaving only the `<Waveform mode="live" />`. Remove now-unused `elapsed`/`fmtTime`/timer state if nothing else uses them.
- [ ] **Step 2:** In `overlay.css`, change `.ov-capsule` background from `rgba(255,255,255,0.86)` to a violet gradient `linear-gradient(135deg,#7C3AED,#6D28D9)`, set text/icon colors to white, soften the shadow to a violet glow (`0 10px 30px -8px rgba(109,40,217,0.45)`), reduce `height: 50px` → `40px`, and tighten `padding`/`gap`. Delete or stop referencing `.ov-rec` and `.ov-time`.
- [ ] **Step 3:** Adjust `.ov-check` (inserted state) to a white check on translucent white (`color:#fff; background:rgba(255,255,255,0.18)`), and `.ov-text`/`.ov-msg-*` to white/translucent-white for contrast on violet.
- [ ] **Step 4: Build + typecheck**

Run:
```bash
npm run typecheck && npm run build
```
Expected: both succeed.

- [ ] **Step 5: Commit**
```bash
git add src/renderer/overlay/overlay.css src/renderer/overlay/Overlay.tsx
git commit -m "style(overlay): minimal violet pill; drop red dot and timer"
```

### Task B2: Recolor the waveform to white-on-violet

**Files:**
- Modify: `src/renderer/overlay/Waveform.tsx` (the `live` and `calm` gradient stops + shadow).

- [ ] **Step 1:** In `Waveform.tsx`, change the `live` gradient from indigo (`#6366f1`→`#4f46e5`) to white/translucent-white (`rgba(255,255,255,0.95)`→`rgba(255,255,255,0.7)`) and the shadow to a soft white glow; change `calm` to a dimmer translucent white. Keep bar geometry/animation.
- [ ] **Step 2: Build + screenshot verify**

Run:
```bash
npm run build
```
Then capture the overlay using the `ECHO_USER_DATA` E2E recipe (memory: `echo-e2e-verification-recipe`) — drive a dictation so the overlay shows, screenshot it, and confirm: violet pill, white bars, no red dot, no timer.

- [ ] **Step 3: Commit**
```bash
git add src/renderer/overlay/Waveform.tsx
git commit -m "style(overlay): white waveform on violet"
```

---

## PHASE A — Android system-wide floating mic button

> Reuses `DictationController` (callbacks `onText`/`onPhase`) unchanged. New code lives in a new package `com.tanay.echo.floating` plus an accessibility service. Pure logic is TDD'd on the JVM (`android/app/src/test`); framework pieces are built to spec and verified on-device.

### Task A1: Expose live mic amplitude (only if absent)

**Files:**
- Read first: `android/app/src/main/java/com/tanay/echo/audio/MicRecorder.kt`.
- Modify (if no level callback exists): `MicRecorder.kt` — add `var onLevel: (Float) -> Unit` invoked per read with normalized RMS (0..1).

- [ ] **Step 1:** Read `MicRecorder.kt`. If it already surfaces a per-frame level, skip to A2 (note it in the commit for A2). Otherwise continue.
- [ ] **Step 2:** Add `var onLevel: (Float) -> Unit = {}` and, in the read loop, compute RMS over the just-read PCM16 frame, normalize to 0..1, and call `onLevel(level)`. Keep it allocation-light.
- [ ] **Step 3: Build the Android module**

Run:
```powershell
$env:JAVA_HOME='C:\Users\Tanay\scoop\apps\temurin17-jdk\current'; $env:ANDROID_HOME='C:\Users\Tanay\scoop\apps\android-clt\current'; C:\Users\Tanay\scoop\apps\gradle87\gradle-8.7\bin\gradle.bat -p android --no-daemon --console=plain compileDebugKotlin
```
Expected: BUILD SUCCESSFUL.

- [ ] **Step 4: Commit**
```bash
git add android/app/src/main/java/com/tanay/echo/audio/MicRecorder.kt
git commit -m "feat(android): expose live mic amplitude for waveform + silence detection"
```

### Task A2: `SilenceDetector` (pure logic, TDD)

**Files:**
- Create: `android/app/src/main/java/com/tanay/echo/floating/SilenceDetector.kt`
- Test: `android/app/src/test/java/com/tanay/echo/floating/SilenceDetectorTest.kt`

**Interfaces:**
- Produces (for A5): `class SilenceDetector(val thresholdRms: Float = 0.06f, val silenceMs: Long = 3000)` with `fun update(rms: Float, nowMs: Long): Boolean` (returns true once, when silence has persisted past `silenceMs` after at least one speech frame) and `fun reset()`.

- [ ] **Step 1: Write failing tests**
```kotlin
package com.tanay.echo.floating

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SilenceDetectorTest {
    @Test fun `fires after sustained silence following speech`() {
        val d = SilenceDetector(thresholdRms = 0.05f, silenceMs = 1000)
        assertFalse(d.update(0.30f, 0))      // speech
        assertFalse(d.update(0.01f, 200))    // quiet, not long enough
        assertFalse(d.update(0.01f, 900))
        assertTrue(d.update(0.01f, 1300))    // quiet >= 1000ms since speech ended
    }
    @Test fun `does not fire before any speech`() {
        val d = SilenceDetector(thresholdRms = 0.05f, silenceMs = 1000)
        assertFalse(d.update(0.01f, 0))
        assertFalse(d.update(0.01f, 5000))   // silence but never spoke
    }
    @Test fun `speech resets the silence window`() {
        val d = SilenceDetector(thresholdRms = 0.05f, silenceMs = 1000)
        d.update(0.30f, 0)
        d.update(0.01f, 800)
        d.update(0.30f, 900)                 // speech again
        assertFalse(d.update(0.01f, 1500))   // only 600ms of silence since
        assertTrue(d.update(0.01f, 1950))    // now >= 1000ms
    }
    @Test fun `fires only once`() {
        val d = SilenceDetector(thresholdRms = 0.05f, silenceMs = 1000)
        d.update(0.30f, 0)
        assertTrue(d.update(0.01f, 1100))
        assertFalse(d.update(0.01f, 1200))   // already fired
    }
}
```
- [ ] **Step 2: Run — verify FAIL** (`SilenceDetector` unresolved):
```powershell
$env:JAVA_HOME='C:\Users\Tanay\scoop\apps\temurin17-jdk\current'; C:\Users\Tanay\scoop\apps\gradle87\gradle-8.7\bin\gradle.bat -p android --no-daemon --console=plain testDebugUnitTest --tests 'com.tanay.echo.floating.SilenceDetectorTest'
```
Expected: compilation/test FAIL.
- [ ] **Step 3: Implement**
```kotlin
package com.tanay.echo.floating

/** Fires once when the mic has been quiet for [silenceMs] after at least one speech frame.
 *  Pure + deterministic (caller supplies the clock) so it unit-tests on the JVM. */
class SilenceDetector(
    private val thresholdRms: Float = 0.06f,
    private val silenceMs: Long = 3000,
) {
    private var spoke = false
    private var silenceStart = -1L
    private var fired = false

    fun reset() { spoke = false; silenceStart = -1L; fired = false }

    fun update(rms: Float, nowMs: Long): Boolean {
        if (fired) return false
        if (rms >= thresholdRms) { spoke = true; silenceStart = -1L; return false }
        if (!spoke) return false
        if (silenceStart < 0) silenceStart = nowMs
        if (nowMs - silenceStart >= silenceMs) { fired = true; return true }
        return false
    }
}
```
- [ ] **Step 4: Run — verify PASS** (same command). Expected: 4 tests pass.
- [ ] **Step 5: Commit**
```bash
git add android/app/src/main/java/com/tanay/echo/floating/SilenceDetector.kt android/app/src/test/java/com/tanay/echo/floating/SilenceDetectorTest.kt
git commit -m "feat(android): silence detector for hands-free tap-to-stop"
```

### Task A3: `GestureInterpreter` (pure logic, TDD)

**Files:**
- Create: `android/app/src/main/java/com/tanay/echo/floating/GestureInterpreter.kt`
- Test: `android/app/src/test/java/com/tanay/echo/floating/GestureInterpreterTest.kt`

**Interfaces:**
- Produces (for A5): `sealed interface Gesture { object Tap; object HoldStart; object HoldEnd; data class Drag(dx,dy) }` and `class GestureInterpreter(longPressMs=300, touchSlopPx=16f)` with `fun down/move/up(...)` returning `Gesture?`. Distinguishes tap (quick, no slop) from hold (past `longPressMs`) and drag (past slop).

- [ ] **Step 1: Write failing tests** (quick up = Tap; passing longPressMs before up = HoldStart then HoldEnd; movement beyond slop = Drag, suppresses Tap). Full test code:
```kotlin
package com.tanay.echo.floating

import org.junit.Assert.*
import org.junit.Test

class GestureInterpreterTest {
    @Test fun `quick press-release is a tap`() {
        val g = GestureInterpreter(longPressMs = 300, touchSlopPx = 16f)
        assertNull(g.down(0f, 0f, 0))
        assertEquals(Gesture.Tap, g.up(0f, 0f, 120))
    }
    @Test fun `holding past threshold starts and ends a hold`() {
        val g = GestureInterpreter(longPressMs = 300, touchSlopPx = 16f)
        g.down(0f, 0f, 0)
        assertEquals(Gesture.HoldStart, g.move(2f, 2f, 350))   // crossed time threshold
        assertEquals(Gesture.HoldEnd, g.up(2f, 2f, 800))
    }
    @Test fun `movement beyond slop is a drag not a tap`() {
        val g = GestureInterpreter(longPressMs = 300, touchSlopPx = 16f)
        g.down(0f, 0f, 0)
        val m = g.move(40f, 0f, 50)
        assertTrue(m is Gesture.Drag)
        assertNull(g.up(40f, 0f, 80))     // dragged -> not a tap
    }
}
```
- [ ] **Step 2: Run — verify FAIL.**
- [ ] **Step 3: Implement** `Gesture` + `GestureInterpreter` with the above semantics (track downTime, last position, `holdStarted`/`dragging` flags; `move` emits `HoldStart` the first time `now-downTime>=longPressMs`, or `Drag` once past slop; `up` emits `Tap` only if neither hold nor drag occurred, else `HoldEnd` if a hold was active).
- [ ] **Step 4: Run — verify PASS.**
- [ ] **Step 5: Commit** `feat(android): gesture interpreter (tap vs hold vs drag) for the floating button`.

### Task A4: `EchoAccessibilityService` (paste into focused field)

**Files:**
- Create: `android/app/src/main/java/com/tanay/echo/floating/EchoAccessibilityService.kt`
- Create: `android/app/src/main/res/xml/accessibility_service_config.xml`
- Modify: `android/app/src/main/AndroidManifest.xml` (register the service).
- Optional test: a pure `ClipboardSaver` helper if the save/restore logic is extracted (TDD that part).

- [ ] **Step 1:** Create the config xml: `accessibilityEventTypes="typeViewFocused|typeWindowStateChanged"`, `accessibilityFeedbackType="feedbackGeneric"`, `canRetrieveWindowContent="true"`, `accessibilityFlags="flagDefault"`.
- [ ] **Step 2:** Implement the service with a `companion object { @Volatile var instance: EchoAccessibilityService? = null }` set in `onServiceConnected` / cleared in `onUnbind` + `onDestroy`. Implement `fun pasteIntoFocusedField(text: String): Boolean`: snapshot `ClipboardManager` primary clip; set clip to `text`; `val node = rootInActiveWindow?.findFocus(AccessibilityNodeInfo.FOCUS_INPUT)`; if node != null `node.performAction(AccessibilityNodeInfo.ACTION_PASTE)` and post a delayed (~400ms) clipboard restore, return true; else keep text on clipboard, return false. `onAccessibilityEvent`/`onInterrupt` can be no-ops.
- [ ] **Step 3:** Register in the manifest: `<service android:name=".floating.EchoAccessibilityService" android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE" android:exported="false"><intent-filter><action android:name="android.accessibilityservice.AccessibilityService"/></intent-filter><meta-data android:name="android.accessibilityservice" android:resource="@xml/accessibility_service_config"/></service>`.
- [ ] **Step 4: Build** (`compileDebugKotlin` + `assembleDebug` from the Global Constraints command). Expected: BUILD SUCCESSFUL.
- [ ] **Step 5: Commit** `feat(android): accessibility service to paste dictation into any focused field`.

### Task A5: `FloatingButtonService` (overlay bubble + pipeline wiring)

**Files:**
- Create: `android/app/src/main/java/com/tanay/echo/floating/FloatingButtonService.kt`
- Create: `android/app/src/main/res/layout/floating_bubble.xml` (+ drawables in A6).
- Modify: `AndroidManifest.xml` (register the foreground service + permissions in A7).

**Interfaces:**
- Consumes: `DictationController` (`onText`, `onPhase`, `startCapture`, `stopAndTranscribe`, `cancelCapture`, `primeMic`), `SilenceDetector`, `GestureInterpreter`, `EchoAccessibilityService.instance`, `MicRecorder.onLevel`.

- [ ] **Step 1:** Implement the service: in `onCreate`, build a `DictationController`, set `onText = { text -> if (EchoAccessibilityService.instance?.pasteIntoFocusedField(text) != true) showCopiedHint() }`, `onPhase = { p,_ -> updateBubble(p) }`. Add the bubble view to `WindowManager` with `LayoutParams(TYPE_APPLICATION_OVERLAY, FLAG_NOT_FOCUSABLE or FLAG_NOT_TOUCH_MODAL or FLAG_LAYOUT_IN_SCREEN, PixelFormat.TRANSLUCENT)`, `gravity = TOP or END`, default margins; persist position.
- [ ] **Step 2:** Start as a foreground service (`startForeground` with a low-priority notification channel, fgs type microphone).
- [ ] **Step 3:** Wire touch → `GestureInterpreter`: `Tap` → toggle tap-mode capture (start; on second tap / ✓ tap or `SilenceDetector` fire → `stopAndTranscribe(focusedPackage)`); `HoldStart` → `startCapture()`; `HoldEnd` → `stopAndTranscribe`; `Drag` → update `LayoutParams` x/y via `WindowManager.updateViewLayout`. Feed `MicRecorder.onLevel` to both the waveform and (in tap mode) the `SilenceDetector`.
- [ ] **Step 4:** `focusedPackage()` from `EchoAccessibilityService.instance?.rootInActiveWindow?.packageName` (best-effort).
- [ ] **Step 5: Build** (`assembleDebug`). Expected: BUILD SUCCESSFUL.
- [ ] **Step 6: Commit** `feat(android): floating foreground service hosting the dictation bubble`.

### Task A6: Bubble UI matching the reference (lavender mic → violet waveform pill)

**Files:**
- Create: `android/app/src/main/java/com/tanay/echo/floating/WaveformView.kt` (custom View animating white bars from `MicRecorder` level).
- Create: `android/app/src/main/res/layout/floating_bubble.xml`, drawables (`bg_bubble_idle.xml` lavender circle, `bg_pill_recording.xml` violet pill), and `res/values` colors.
- Modify: `FloatingButtonService.updateBubble(phase)` to swap idle mic ↔ recording pill (+ ✓ in tap mode) ↔ transcribing (calm) ↔ inserted (✓ flash).

- [ ] **Step 1:** Build `WaveformView`: N white bars, heights driven by a smoothed level (idle = low idle motion), matching reference image 6. Lavender `#EDE7FF` idle circle, violet `#7C3AED` recording pill, white bars/icons.
- [ ] **Step 2:** Implement `updateBubble` state visuals to mirror `DictationPhase`.
- [ ] **Step 3: Build** (`assembleDebug`). Expected: BUILD SUCCESSFUL.
- [ ] **Step 4: Commit** `feat(android): bubble UI — lavender mic and violet waveform pill`.

### Task A7: Permissions, onboarding cards & master toggle

**Files:**
- Modify: `AndroidManifest.xml` — add `SYSTEM_ALERT_WINDOW`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_MICROPHONE`, `POST_NOTIFICATIONS`; ensure both services registered with correct `foregroundServiceType="microphone"` on the FGS.
- Modify: `android/app/src/main/java/com/tanay/echo/settings/SettingsActivity.kt` + its layout — add status cards (overlay / accessibility / notifications) each with an Enable button, and a master "Floating mic button" switch.
- Modify: `android/app/src/main/java/com/tanay/echo/settings/EchoSettings.kt` — add `var floatingEnabled: Boolean` (default false).

- [ ] **Step 1:** Add the manifest permissions + `foregroundServiceType` on `FloatingButtonService`.
- [ ] **Step 2:** Add `floatingEnabled` to `EchoSettings` (mirrors `cleanupEnabled` style).
- [ ] **Step 3:** In `SettingsActivity`, add: overlay card (`Settings.canDrawOverlays(this)`; Enable → `ACTION_MANAGE_OVERLAY_PERMISSION` intent); accessibility card (status via enabled-services check; Enable → `ACTION_ACCESSIBILITY_SETTINGS` + a note about "Allow restricted settings" for sideloaded apps); notifications card (33+; `POST_NOTIFICATIONS` request); master switch that starts/stops `FloatingButtonService` and persists `floatingEnabled`.
- [ ] **Step 4: Build** (`assembleDebug`). Expected: BUILD SUCCESSFUL.
- [ ] **Step 5: Commit** `feat(android): onboarding cards + master toggle for the floating mic button`.

### Task A8: Full Android test + APK build + on-device verification

- [ ] **Step 1: Run all Android unit tests**
```powershell
$env:JAVA_HOME='C:\Users\Tanay\scoop\apps\temurin17-jdk\current'; C:\Users\Tanay\scoop\apps\gradle87\gradle-8.7\bin\gradle.bat -p android --no-daemon --console=plain testDebugUnitTest
```
Expected: all tests pass (existing 61 + new SilenceDetector/Gesture tests).
- [ ] **Step 2: Assemble the release/debug APK** with the seeded `defaults.local.properties` (now including `syncToken`):
```powershell
$env:JAVA_HOME='C:\Users\Tanay\scoop\apps\temurin17-jdk\current'; $env:ANDROID_HOME='C:\Users\Tanay\scoop\apps\android-clt\current'; C:\Users\Tanay\scoop\apps\gradle87\gradle-8.7\bin\gradle.bat -p android --no-daemon --console=plain assembleDebug
```
Expected: BUILD SUCCESSFUL; APK at `android/app/build/outputs/apk/debug/app-debug.apk`.
- [ ] **Step 3:** Copy the APK to the Desktop and hand off to the user with on-device steps: enable Draw-over-apps + Accessibility (Allow restricted settings) + Notifications, toggle the floating button on, then verify tap-to-tick, hold-to-talk, paste into a Samsung Keyboard field, and "Brian → Bryan".
- [ ] **Step 4:** No commit (build artifact). Report final status.

---

## Self-Review (against the spec)

- **Goal 1 (floating button, tap=tick/silence, hold=PTT):** Tasks A2 (silence), A3 (gestures), A5 (wiring), A6 (UI). ✓
- **Goal 2 (auto-paste any app):** Task A4 (accessibility paste) + A5 wiring. ✓
- **Goal 3 (cross-device dictionary/history sync):** Tasks C1–C4. ✓
- **Goal 4 (minimal violet desktop overlay):** Tasks B1–B2. ✓
- **Permissions/onboarding:** Task A7. ✓
- **Honest limits:** on-device verification called out in C4/A8; server deploy reachability handled in C3. ✓
- **Type consistency:** `SilenceDetector.update(rms,nowMs)`, `GestureInterpreter` `Gesture` types, `EchoAccessibilityService.instance.pasteIntoFocusedField`, `MicRecorder.onLevel`, `EchoSettings.floatingEnabled` — referenced consistently across A1/A2/A3/A4/A5/A6/A7. ✓
- **No placeholders** in the TDD tasks (full test + impl code provided for A2; full tests for A3; concrete commands throughout). UI drawable specifics (A6) intentionally iterated on-device with screenshots rather than pre-pixeled. ✓
