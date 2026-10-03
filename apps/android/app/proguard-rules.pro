# Keep kotlinx.serialization generated serializers.
-keepclassmembers class com.zharness.mobile.** {
    *** Companion;
}
-keepclasseswithmembers class com.zharness.mobile.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-keep,includedescriptorclasses class com.zharness.mobile.**$$serializer { *; }
