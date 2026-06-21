# Debug sideload builds are not minified (see build.gradle.kts), so these rules only
# matter if you switch the release build to minify. Keep kotlinx.serialization metadata.
-keepattributes *Annotation*, InnerClasses
-dontnote kotlinx.serialization.**
-keepclassmembers class **$$serializer { *; }
-keepclassmembers @kotlinx.serialization.Serializable class * {
    static **$Companion Companion;
}
