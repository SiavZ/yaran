/**
 * Gradle build for `:yaran-core`, the yaran native core library on Android.
 *
 * The core holds every piece of device-local security logic (vault, app lock, diagnostics,
 * sanitizer, screen privacy, host rules) so the Capacitor adapters stay thin and the G6
 * fallback host could reuse it without Capacitor. It is not a Capacitor plugin: `cap sync`
 * never writes it, `mobile/android/settings.gradle` includes it.
 *
 * - JUnit tests read the shared fixtures through the `yaran.fixtures` system property.
 * - The androidTest source set needs a device or emulator; it only has to compile in CI.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by: entry point (Gradle build script, included from mobile/android/settings.gradle)
 * <module-headers:end>
 */
plugins {
    id("com.android.library")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "io.github.siavz.yaran.core"
    compileSdk = 36
    defaultConfig {
        minSdk = 24
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
    testOptions {
        unitTests.all {
            it.systemProperty("yaran.fixtures", rootProject.file("../plugins/core/fixtures").absolutePath)
        }
    }
}

dependencies {
    api(libs.androidx.biometric)
    implementation(libs.androidx.core)
    testImplementation(libs.junit)
    testImplementation(libs.json)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.ext.junit)
}
