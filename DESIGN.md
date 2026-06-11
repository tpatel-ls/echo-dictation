# Echo — Design system

## Principle

Echo is app UI in the **product register**: it should feel like a system HUD you trust
(Raycast, Wispr Flow), not a decorated app. The overlay is the one surface allowed a moment
of craft, because it's the product's signature. Motion is **smooth and settled** — ease-out
exponential curves, never bounce or elastic.

## The overlay pill (signature surface)

A floating, center-bottom glass capsule. Source of truth: `src/renderer/overlay/overlay.css`
+ `Waveform.tsx`. Design explored in `design/overlay-preview.html` (render via
`node scripts/preview-server.mjs design` → open in a browser).

**Glass capsule**
- Background: `linear-gradient(180deg, rgba(28,30,40,.80), rgba(13,14,20,.88))` — crisp dark
  glass, ~0.85 opacity so it reads over any desktop content without needing a live blur.
- Rim light: `inset 0 1.4px 0 rgba(255,255,255,.20)` + a masked top-edge `::before` highlight.
  This "glass catches light from above" cue is what makes it feel premium, not flat.
- Depth: layered shadows (`0 24px 50px -14px` ambient + a tight contact shadow).
- `backdrop-filter: blur(28px)` — active where supported; a harmless no-op on transparent
  Windows overlays (no desktop pixels to sample), so the gradient carries the look there.
- Radius 28px (full pill), height 56px.

**Waveform** — symmetric, center-weighted equalizer on a canvas, driven by live mic RMS.
Center bars weighted tallest; each bar has a phase-offset shimmer so it's alive even at steady
volume. Gradient `#fdfdff → #aeb6ee`, rounded caps, soft glow, rendered at devicePixelRatio.

**States** (one capsule, content swaps): `listening` (red breathing dot + live waveform +
timer), `transcribing` (calm dimmer traveling wave, distinct from listening), `inserted`
(green check that scales in, ease-out, + text preview), `empty`/`error` (single line).
Entrance: fade + translateY + slight scale over 220–260ms, `cubic-bezier(0.22,1,0.36,1)`.
All decorative motion has a `prefers-reduced-motion` off-switch.

## Dashboard tokens

Tailwind theme in `tailwind.config.cjs`. Restrained palette:
`bg #0a0c10` · `surface #13161c` · `surface2 #1b1f27` · `border #262b35` · `muted #8b94a7`
· `text #e6e9ef` · `accent #6d7bff` · `good #3ecf8e` · `bad #ff6b6b`.
Font: Inter / Segoe UI. Accent used for state + selection only, never decoration.
