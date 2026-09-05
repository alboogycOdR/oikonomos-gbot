plugins {
    id("com.android.application")
    // The Flutter Gradle Plugin must be applied after the Android and Kotlin Gradle plugins.
    id("dev.flutter.flutter-gradle-plugin")
    // Firebase push setup, 2026-09-05 — reads google-services.json below.
    id("com.google.gms.google-services")
}

android {
    namespace = "com.basileia.oikonomos_mobile"
    // Pinned to 36 (not flutter.compileSdkVersion's default of 34), 2026-09-05 —
    // file_picker's transitive dependency flutter_plugin_android_lifecycle
    // requires compileSdk >= 36. Real Gradle release build failure, not caught
    // by flutter analyze/test (neither invokes a real Android release build).
    compileSdk = 36
    ndkVersion = flutter.ndkVersion

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    defaultConfig {
        // Matches the Android app registered in Firebase (basileia-oikonomos-gmail
        // project, 2026-09-05) — must stay in sync with google-services.json's
        // own package_name or Firebase will refuse to initialize.
        applicationId = "com.basileia.oikonomos"
        // You can update the following values to match your application needs.
        // For more information, see: https://flutter.dev/to/review-gradle-config.
        minSdk = flutter.minSdkVersion
        targetSdk = flutter.targetSdkVersion
        // Uses the version code from pubspec.yaml. When using split APKs, 1000 * ABI_VERSION
        // is added automatically by Flutter. (https://developer.android.com/studio/build/configure-apk-splits#configure-APK-versions)
        // You can force using the value of versionCode by specifying the `-P force-version-code-ignoring-abi=true`
        // flag during build.
        versionCode = flutter.versionCode
        versionName = flutter.versionName
    }

    buildTypes {
        release {
            // TODO: Add your own signing config for the release build.
            // Signing with the debug keys for now, so `flutter run --release` works.
            signingConfig = signingConfigs.getByName("debug")
        }
    }
}

kotlin {
    compilerOptions {
        jvmTarget = org.jetbrains.kotlin.gradle.dsl.JvmTarget.JVM_17
    }
}

flutter {
    source = "../.."
}
