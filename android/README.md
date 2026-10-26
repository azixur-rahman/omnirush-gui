# OmniRush Android

This directory contains the first Android surface for OmniRush, built with
Jetpack Compose. It uses a dark, translucent material system inspired by Apple
Liquid Glass: layered surfaces, restrained color, thumb-friendly controls, and
short interruptible press/entry motion.

## Build locally

From this directory, with Java 17 and the Android SDK installed:

```sh
gradle --no-daemon :app:assembleDebug
```

The APK is written to
`app/build/outputs/apk/debug/app-debug.apk`.

## GitHub Actions

`.github/workflows/android-apk.yml` builds the debug APK on changes under
`android/` and also supports **Run workflow**. Pushing a tag matching
`android-v*` attaches the APK to a GitHub release.

The current mobile surface includes the complete chat interaction and a local
preview responder so the UI can be exercised without credentials. The existing
desktop/server session transport can be connected in the next adapter layer
without changing the Compose presentation.
