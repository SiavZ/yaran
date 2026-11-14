/**
 * VerifyFossDependencies: the `:app:verifyFossDependencies` task.
 *
 * Fails when the `foss` release runtime classpath contains a module from
 * `com.google.android.gms`, `com.google.firebase`, `com.google.mlkit` or
 * `com.google.android.play`: the patterns F-Droid's scanner rejects (R5 §1 fact 11). Phase 18
 * runs it in CI; the `play` flavor may add Phase 16's embedded FCM distributor, `foss` never.
 *
 * - [forbiddenModules] is the pure decision the task and the TestKit tests share.
 *
 * <module-headers:begin>
 * Uses: none
 * External: org.gradle.api, org.gradle.api.provider, org.gradle.api.tasks
 *
 * Used by:
 * io.github.siavz.yaran.gradle.VerifyFossDependencies
 * ├── io.github.siavz.yaran.gradle.AndroidGuardsPlugin (inferred)
 * └── io.github.siavz.yaran.gradle.AndroidGuardsPluginTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.gradle

import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.provider.ListProperty
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

/** Group prefixes no `foss` build may ship. */
val FORBIDDEN_FOSS_GROUPS = listOf("com.google.android.gms", "com.google.firebase", "com.google.mlkit", "com.google.android.play")

/** The `group:module:version` coordinates in [coordinates] whose group is forbidden in `foss`. */
fun forbiddenModules(coordinates: List<String>): List<String> = coordinates.filter { coordinate ->
    val group = coordinate.substringBefore(':')
    FORBIDDEN_FOSS_GROUPS.any { group == it || group.startsWith("$it.") }
}

abstract class VerifyFossDependencies : DefaultTask() {
    @get:Input
    abstract val configurationName: Property<String>

    /** Resolved external modules of [configurationName], as `group:module:version`. */
    @get:Input
    abstract val coordinates: ListProperty<String>

    @TaskAction
    fun verify() {
        val forbidden = forbiddenModules(coordinates.get())
        if (forbidden.isNotEmpty()) {
            throw GradleException(
                "${configurationName.get()} contains proprietary Google libraries that F-Droid rejects:\n" +
                    forbidden.joinToString("\n") { "  $it" } +
                    "\nMove them to the play flavor (playImplementation) or drop them.",
            )
        }
        logger.lifecycle("${configurationName.get()}: ${coordinates.get().size} modules, none from ${FORBIDDEN_FOSS_GROUPS.joinToString()}")
    }
}
