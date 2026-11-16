/**
 * Gradle build for `:yaran-secure-store`, the Capacitor adapter over the yaran native core.
 *
 * `npx cap sync android` includes this project by its npm name (`@yaran/secure-store` →
 * `:yaran-secure-store`) and adds it to the app; the plugin classes are found by Capacitor
 * through their `@CapacitorPlugin` annotations. All logic lives in `:yaran-core`; this module
 * validates arguments and maps errors to the stable codes of `src/definitions.ts`.
 *
 * - Depends on `:yaran-core` (included by `mobile/android/settings.gradle`) and on
 *   `:capacitor-android` (included by `capacitor.settings.gradle`).
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
    namespace = "io.github.siavz.yaran.securestore"
    compileSdk = 36
    defaultConfig {
        minSdk = 24
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

dependencies {
    implementation(project(":yaran-core"))
    implementation(project(":capacitor-android"))
    // Capacitor hands plugins its AppCompatActivity, and FileProvider lives in androidx.core.
    implementation(libs.androidx.appcompat)
    testImplementation(libs.junit)
}
