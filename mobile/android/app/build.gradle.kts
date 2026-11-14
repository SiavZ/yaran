/**
 * Gradle build for the yaran phone app module (`:app`): flavors, build types and publisher values.
 *
 * Two flavors in the `distribution` dimension share one application id so the store channels
 * can upgrade each other (D14): `foss` (F-Droid shape, no Google libraries, checked by
 * `verifyFossDependencies`) and `play`. The `e2e` build type is debug plus WebView debugging
 * and the e2e defaults (Phase 19 hooks H4, H6); release never sees either.
 *
 * - Publisher values come from `mobile/publisher.properties` (work item 17): the application
 *   id, the publisher domain (empty = development build), relay URL and Play push transport,
 *   as `BuildConfig` fields and manifest placeholders for Phase 15's callback aliases.
 * - `-PappIdOverride=<id>` replaces the properties file's `appId` for local and test builds;
 *   the release guard checks whichever id is in effect.
 * - Release signing reads `YARAN_ANDROID_KEYSTORE_FILE`, `YARAN_ANDROID_KEYSTORE_PASSWORD`,
 *   `YARAN_ANDROID_KEY_ALIAS` and `YARAN_ANDROID_KEY_PASSWORD` (Phase 18); without them a
 *   release comes out unsigned.
 * - versionCode and versionName are literals here on purpose (R5 §7.8).
 *
 * <module-headers:begin>
 * Uses: none
 * External: com.android.build.api.artifact, java.util
 *
 * Used by: entry point (Gradle build script, read by ./gradlew in mobile/android)
 * <module-headers:end>
 */
import com.android.build.api.artifact.SingleArtifact
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("yaran.android-guards")
    id("com.mikepenz.aboutlibraries.plugin")
}

val publisher =
    Properties().apply {
        val file = rootProject.file("../publisher.properties")
        if (file.exists()) file.reader(Charsets.UTF_8).use(::load)
    }

/** A publisher value; a missing key is empty. */
fun publisherValue(key: String): String = publisher.getProperty(key, "").trim()

/** [value] as a Java string literal for a BuildConfig field. */
fun javaString(value: String): String = "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"") + "\""

val appId =
    providers
        .gradleProperty("appIdOverride")
        .orNull
        ?.trim()
        ?.takeIf { it.isNotEmpty() } ?: publisherValue("appId")
val publisherDomain = publisherValue("publisherDomain")
val isDevelopmentBuild = publisherDomain.isEmpty()

require(Regex("[a-zA-Z][a-zA-Z0-9_]*(\\.[a-zA-Z][a-zA-Z0-9_]*)+").matches(appId)) {
    "appId in mobile/publisher.properties must be a dotted Android application id, got: $appId"
}
require(isDevelopmentBuild || Regex("[a-z0-9]([a-z0-9.-]*[a-z0-9])?").matches(publisherDomain)) {
    "publisherDomain in mobile/publisher.properties must be a bare lowercase host name, got: $publisherDomain"
}

yaranGuards {
    applicationId.set(appId)
    publisherDomain.set(this@Build_gradle.publisherDomain)
}

android {
    namespace = "io.github.siavz.yaran.app"
    compileSdk = 36

    defaultConfig {
        applicationId = appId
        minSdk = 24
        targetSdk = 36
        versionCode = 1000
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"

        buildConfigField("String", "PUBLISHER_DOMAIN", javaString(publisherDomain))
        buildConfigField("boolean", "PUBLISHER_CALLBACK_ENABLED", "${!isDevelopmentBuild}")
        buildConfigField("boolean", "DEV_CALLBACK_ENABLED", "$isDevelopmentBuild")
        buildConfigField("String", "RELAY_URL", javaString(publisherValue("relayUrl")))
        buildConfigField("String", "PLAY_PUSH_TRANSPORT", javaString(publisherValue("playPushTransport")))
        // e2e-only values: off and empty everywhere but the e2e build type.
        buildConfigField("boolean", "E2E_WEBVIEW_DEBUG", "false")
        buildConfigField("String", "E2E_CONTROL_PLANE_URL", javaString(""))
        buildConfigField("String", "E2E_RELAY_URL", javaString(""))

        manifestPlaceholders +=
            mapOf(
                "publisherDomain" to publisherDomain,
                "publisherCallbackEnabled" to "${!isDevelopmentBuild}",
                "devCallbackEnabled" to "$isDevelopmentBuild",
                "e2eWebViewDebug" to "false",
                "yaranE2e" to "false",
                "yaranE2eControlPlaneUrl" to "",
            )
    }

    flavorDimensions += "distribution"
    productFlavors {
        // F-Droid shape: no Google libraries at all (D13); verifyFossDependencies enforces it.
        create("foss") {
            dimension = "distribution"
            manifestPlaceholders["yaranFlavor"] = "foss"
        }
        // Play shape: Phase 16 adds only the embedded FCM distributor (playImplementation).
        create("play") {
            dimension = "distribution"
            manifestPlaceholders["yaranFlavor"] = "play"
        }
    }

    val keystoreFile = System.getenv("YARAN_ANDROID_KEYSTORE_FILE").orEmpty()
    signingConfigs {
        if (keystoreFile.isNotEmpty()) {
            create("release") {
                storeFile = file(keystoreFile)
                storePassword = System.getenv("YARAN_ANDROID_KEYSTORE_PASSWORD")
                keyAlias = System.getenv("YARAN_ANDROID_KEY_ALIAS")
                keyPassword = System.getenv("YARAN_ANDROID_KEY_PASSWORD")
            }
        }
    }

    buildTypes {
        getByName("release") {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.findByName("release")
            // Reproducible builds (G7): no VCS stamp in the APK.
            vcsInfo.include = false
        }
        create("e2e") {
            initWith(getByName("debug"))
            matchingFallbacks += "debug"
            buildConfigField("boolean", "E2E_WEBVIEW_DEBUG", "true")
            buildConfigField("String", "E2E_CONTROL_PLANE_URL", javaString(publisherValue("e2e.controlPlaneUrl")))
            buildConfigField("String", "E2E_RELAY_URL", javaString(publisherValue("e2e.relayUrl")))
            manifestPlaceholders["yaranE2e"] = "true"
            manifestPlaceholders["e2eWebViewDebug"] = "true"
            manifestPlaceholders["yaranE2eControlPlaneUrl"] = publisherValue("e2e.controlPlaneUrl")
        }
    }

    buildFeatures {
        buildConfig = true
    }
    androidResources {
        generateLocaleConfig = true
        // Omit dot-files and VCS junk from the packaged web assets (Capacitor template default).
        ignoreAssetsPattern = "!.svn:!.git:!.ds_store:!*.scc:.*:!CVS:!thumbs.db:!picasa.ini:!*~"
    }
    // Reproducible builds (G7): no encrypted dependency blob in the APK or bundle.
    dependenciesInfo {
        includeInApk = false
        includeInBundle = false
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_21
        targetCompatibility = JavaVersion.VERSION_21
    }
}

// Reproducible builds (G7): baseline and ART profile output is not byte-stable.
tasks.configureEach {
    if (name.contains("ArtProfile")) enabled = false
}

// The unit tests read build outputs: the merged manifest and the generated BuildConfig of
// the variants whose flags they check.
val mergedManifests = mutableMapOf<String, Provider<RegularFile>>()
androidComponents {
    onVariants { variant -> mergedManifests[variant.name] = variant.artifacts.get(SingleArtifact.MERGED_MANIFEST) }
}
tasks.withType<Test>().configureEach {
    if (name != "testFossDebugUnitTest") return@configureEach
    val manifest = mergedManifests.getValue("fossDebug")
    val buildConfigs = listOf("fossDebug", "fossE2e", "fossRelease", "playRelease")
    inputs.file(manifest)
    dependsOn(buildConfigs.map { "generate${it.replaceFirstChar(Char::uppercase)}BuildConfig" })
    val buildConfigRoot = layout.buildDirectory.dir("generated/source/buildConfig")
    jvmArgumentProviders.add(
        CommandLineArgumentProvider {
            listOf(
                "-Dyaran.mergedManifest=${manifest.get().asFile.absolutePath}",
                "-Dyaran.buildConfigRoot=${buildConfigRoot.get().asFile.absolutePath}",
            )
        },
    )
}

// Cordova plugin support from the Capacitor template, only once `cap sync` has generated it.
val cordovaPlugins = findProject(":capacitor-cordova-android-plugins")
if (cordovaPlugins != null) {
    repositories { flatDir { dirs("../capacitor-cordova-android-plugins/src/main/libs") } }
    dependencies { implementation(cordovaPlugins) }
}

dependencies {
    implementation(libs.androidx.appcompat)
    implementation(libs.androidx.coordinatorlayout)
    implementation(libs.androidx.core.splashscreen)
    implementation(libs.androidx.activity)
    implementation(project(":capacitor-android"))
    implementation(project(":yaran-core"))
    testImplementation(libs.junit)
}

apply(from = "capacitor.build.gradle")

// License lists for the shell's About screen (work item 13): mobile/scripts/licenses.sh runs
// exportLibraryDefinitions<Flavor>Release with -PaboutLibraries.outputFile=<path>. Offline:
// licenses come from the dependency POMs, never from a network lookup during the build.
aboutLibraries {
    offlineMode = true
    export {
        prettyPrint = true
    }
}
