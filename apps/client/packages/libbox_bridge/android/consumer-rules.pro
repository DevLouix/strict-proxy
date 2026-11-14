# gomobile's generated Java is called from native code by name: libbox.so looks
# up go.Seq.getRef through JNI. The bridge calls the generated API directly, but
# R8 still cannot see the native side of that handshake.
#
# These rules are consumer rules, so they travel with the plugin into every app
# that depends on it. Without them a minified release APK aborts during
# Libbox.<clinit> with "failed to find method Seq.getRef".
-keep class go.** { *; }
# Mirrors the keep rule shipped in libbox.aar's proguard.txt, which is lost
# when the AAR is unpacked into classes.jar + jni libraries.
-keep class io.nekohasekai.** { *; }
-keepclasseswithmembers class * {
    native <methods>;
}
