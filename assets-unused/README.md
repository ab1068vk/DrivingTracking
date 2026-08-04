# Unused image assets

These 45 PNGs are **not imported by any source file**. They were moved here out of
`src/assets/` so the live asset folder only holds art the app actually ships.

They are kept rather than deleted because they look like deliberate source/variant
art (multiple `-vN` revisions of the same scene) that may be wanted again.

## Why they were considered unused

A basename search across `src/`, `android/app/`, `marketing/`, `scripts/`, `e2e/`,
`index.html`, and `capacitor.config.ts` returns no hits for any of them.

An earlier, wider search *appeared* to find references, but every hit was inside
`android/.gradle/.../executionHistory.bin` — a Gradle build-cache blob, not code.
Do not treat that file as a reference when re-checking.

## Before deleting

Nothing here is bundled: Vite only emits assets that are imported, so these cost
nothing at runtime today. They only cost working-tree size. Deleting them is safe
whenever you decide the variants are no longer wanted — git history keeps them.

## Re-using one

Move it back into `src/assets/` and import it. Prefer converting to WebP first;
the shipped art targets roughly 0.15 bytes/pixel, which `ffmpeg -c:v libwebp
-quality 90 -compression_level 6` produces for this style of image.
