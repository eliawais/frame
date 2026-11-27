# Erev for Android

The Android app opens Erev in an origin-restricted WebView. Google sign-in opens in the system browser, then returns to the app. Room permissions still come from the existing Erev approval system.

Tap **Share screen**, approve the Android picker, and return to the content you want to share. Erev uses picture-in-picture while switching apps. Stop from Erev, the sharing notification, or the Android screen sharing controls. The app sends screen video through the room's existing WebRTC connection. Room microphone audio is separate. The Android share does not capture other apps' audio.

## Build

Use JDK 17, Gradle 8.11.1 and Android SDK Platform 35. Run `gradle -p android assembleDebug` from the repository root. The debug build is written to `android/app/build/outputs/apk/debug/app-debug.apk`. The web host is fixed to `https://erev.pages.dev`.

## Server rollout

Apply `beta/android-handoffs.sql` to the Erev D1 database before publishing the matching Pages deployment. Keep the existing Google OAuth redirect URI.
