#!/usr/bin/env bash
set -euo pipefail

: "${ANDROID_HOME:?Run android-actions/setup-android before installing SDK components}"

# setup-android accepts the SDK licenses and selects sdkmanager on PATH.
# No stdin producer is needed: yes can report EPIPE as exit 1 instead of SIGPIPE.
sdkmanager --sdk_root="$ANDROID_HOME" \
  "platforms;android-36" \
  "build-tools;36.0.0" \
  "platform-tools" </dev/null

# A skipped package (for example an unaccepted license) is not a successful install.
test -s "$ANDROID_HOME/platforms/android-36/android.jar"
test -x "$ANDROID_HOME/build-tools/36.0.0/aapt2"
test -x "$ANDROID_HOME/platform-tools/adb"
echo "Android SDK components installed"
