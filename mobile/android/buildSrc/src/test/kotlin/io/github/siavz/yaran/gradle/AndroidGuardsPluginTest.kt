/**
 * AndroidGuardsPluginTest: Gradle TestKit runs of the yaran release guards on fixture projects.
 *
 * Each test writes a throwaway build that applies `yaran.android-guards`, stands in for the
 * Android pieces the guards look at (a `fossReleaseRuntimeClasspath` configuration resolved
 * from a local pom-only repository, release and debug artifact task names), and asserts the build fails or
 * passes. Nothing touches the network.
 *
 * - verifyFossDependencies fails on a forbidden group and passes a clean classpath.
 * - checkReleaseAppId fails a release on the default id and on an empty publisher domain
 *   with `-PrequirePublisherDomain=true`, and never gates a debug build.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.gradle.AndroidGuardsPluginTest
 * ├── io.github.siavz.yaran.gradle.ReleaseAppIdGuard (inferred)
 * └── io.github.siavz.yaran.gradle.VerifyFossDependencies (inferred)
 * External: java.io, org.gradle.testkit.runner, org.junit, org.junit.Assert, org.junit.rules
 *
 * Used by: entry point (JUnit/Robolectric, via ./gradlew test in mobile/android)
 * <module-headers:end>
 */
package io.github.siavz.yaran.gradle

import org.gradle.testkit.runner.GradleRunner
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

class AndroidGuardsPluginTest {
    @get:Rule val temp = TemporaryFolder()

    private fun fixture(appId: String, domain: String = "", dependency: String? = null): File {
        val dir = temp.newFolder()
        val repo = File(dir, "repo")
        listOf("com.google.firebase:firebase-messaging", "com.google.android.gms:play-services-base", "org.example:clean").forEach {
            val (group, module) = it.split(':')
            val path = File(repo, "${group.replace('.', '/')}/$module/1.0").apply { mkdirs() }
            File(path, "$module-1.0.pom").writeText(
                """<project><modelVersion>4.0.0</modelVersion><groupId>$group</groupId><artifactId>$module</artifactId><version>1.0</version><packaging>pom</packaging></project>""",
            )
        }
        File(dir, "settings.gradle.kts").writeText("rootProject.name = \"fixture\"\n")
        File(dir, "build.gradle.kts").writeText(
            """
            plugins { id("yaran.android-guards") }
            repositories { maven { url = uri("repo") } }
            val fossReleaseRuntimeClasspath by configurations.creating
            dependencies { ${dependency?.let { "fossReleaseRuntimeClasspath(\"$it\")" } ?: ""} }
            yaranGuards {
                applicationId.set("$appId")
                publisherDomain.set("$domain")
            }
            listOf("assembleFossRelease", "bundlePlayRelease", "packageFossReleaseBundle", "assembleFossDebug", "assembleFossE2e", "testFossReleaseUnitTest").forEach { tasks.register(it) }
            """.trimIndent(),
        )
        return dir
    }

    private fun runner(dir: File, vararg args: String) = GradleRunner.create().withProjectDir(dir).withPluginClasspath().withArguments(*args)

    @Test
    fun verifyFossDependenciesFailsOnAForbiddenGroup() {
        listOf("com.google.firebase:firebase-messaging:1.0", "com.google.android.gms:play-services-base:1.0").forEach { dependency ->
            val result = runner(fixture("org.yaran.app", dependency = dependency), "verifyFossDependencies").buildAndFail()
            assertTrue(result.output, result.output.contains("proprietary Google libraries") && result.output.contains(dependency))
        }
    }

    @Test
    fun verifyFossDependenciesPassesACleanClasspath() {
        val result = runner(fixture("org.yaran.app", dependency = "org.example:clean:1.0"), "verifyFossDependencies").build()
        assertTrue(result.output, result.output.contains("none from"))
    }

    @Test
    fun releaseFailsOnTheDefaultApplicationId() {
        val dir = fixture("com.example.yaran")
        listOf("assembleFossRelease", "bundlePlayRelease", "packageFossReleaseBundle").forEach { task ->
            val result = runner(dir, task).buildAndFail()
            assertTrue(result.output, result.output.contains("repository placeholder"))
        }
    }

    @Test
    fun debugE2eAndReleaseUnitTestsAreNotGated() {
        runner(fixture("com.example.yaran"), "assembleFossDebug", "assembleFossE2e", "testFossReleaseUnitTest").build()
    }

    @Test
    fun releaseFailsOnAnEmptyDomainOnlyWhenRequired() {
        val dir = fixture("org.yaran.app")
        val refused = runner(dir, "assembleFossRelease", "-PrequirePublisherDomain=true").buildAndFail()
        assertTrue(refused.output, refused.output.contains("publisherDomain is empty"))
        runner(dir, "assembleFossRelease").build()
        runner(fixture("org.yaran.app", domain = "cp.example.org"), "assembleFossRelease", "-PrequirePublisherDomain=true").build()
    }

    @Test
    fun pureDecisions() {
        assertEquals(listOf("com.google.mlkit:barcode:1", "com.google.android.play:core:1"), forbiddenModules(listOf("com.google.mlkit:barcode:1", "com.google.android.play:core:1", "com.google.android.material:material:1", "org.unifiedpush.android:connector:3")))
        assertEquals(2, releaseAppIdProblems("com.example.yaran", "", true).size)
        assertTrue(releaseAppIdProblems("org.yaran.app", "", false).isEmpty())
    }
}
