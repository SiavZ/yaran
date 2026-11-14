/**
 * Gradle build for `buildSrc`: the yaran Android build guards as a local Gradle plugin.
 *
 * Provides the `yaran.android-guards` plugin that `app/build.gradle.kts` applies:
 * `verifyFossDependencies` (no Google Play services, Firebase, ML Kit or Play libraries in
 * the `foss` release runtime classpath) and `checkReleaseAppId` (no placeholder application
 * id, and a publisher domain when `-PrequirePublisherDomain=true`).
 *
 * - Gradle TestKit tests run the plugin against throwaway fixture projects, offline.
 *
 * <module-headers:begin>
 * Uses: none
 * External: none
 *
 * Used by: entry point (Gradle build script, read by ./gradlew in mobile/android)
 * <module-headers:end>
 */
plugins {
    `kotlin-dsl`
}

repositories {
    mavenCentral()
    gradlePluginPortal()
}

gradlePlugin {
    plugins {
        create("androidGuards") {
            id = "yaran.android-guards"
            implementationClass = "io.github.siavz.yaran.gradle.AndroidGuardsPlugin"
        }
    }
}

dependencies {
    testImplementation(gradleTestKit())
    testImplementation("junit:junit:4.13.2")
}
