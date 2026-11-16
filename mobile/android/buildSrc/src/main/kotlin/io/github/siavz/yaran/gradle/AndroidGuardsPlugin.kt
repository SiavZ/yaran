/**
 * AndroidGuardsPlugin: wires the yaran release guards into the app module.
 *
 * Applied as `yaran.android-guards` from `app/build.gradle.kts`, which fills the extension
 * from `mobile/publisher.properties`. Registers `verifyFossDependencies` (run by Phase 18 CI)
 * and `checkReleaseAppId`, which every task that produces, signs or installs a release artifact
 * depends on (assemble, bundle, package, sign, install), so no release APK or bundle can be
 * built without passing it, while debug and e2e builds (and release unit tests) are untouched.
 *
 * - `-PrequirePublisherDomain=true` (Phase 18's official release jobs) also demands a
 *   publisher domain, so an official build can never ship the dev callback (D8, T36).
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.gradle.AndroidGuardsPlugin
 * ├── io.github.siavz.yaran.gradle.ReleaseAppIdGuard (inferred)
 * └── io.github.siavz.yaran.gradle.VerifyFossDependencies (inferred)
 * External: org.gradle.api, org.gradle.api.artifacts.component, org.gradle.api.provider
 *
 * Used by: entry point (Gradle plugin applied by mobile/android/app/build.gradle.kts)
 * <module-headers:end>
 */
package io.github.siavz.yaran.gradle

import org.gradle.api.Plugin
import org.gradle.api.Project
import org.gradle.api.artifacts.component.ModuleComponentIdentifier
import org.gradle.api.provider.Property

/** Values the app module hands to the guards. */
abstract class AndroidGuardsExtension {
    abstract val applicationId: Property<String>
    abstract val publisherDomain: Property<String>

    /** The configuration `verifyFossDependencies` inspects. */
    abstract val fossConfiguration: Property<String>
}

class AndroidGuardsPlugin : Plugin<Project> {
    override fun apply(project: Project) {
        val extension = project.extensions.create("yaranGuards", AndroidGuardsExtension::class.java)
        extension.fossConfiguration.convention("fossReleaseRuntimeClasspath")
        extension.publisherDomain.convention("")

        project.tasks.register("verifyFossDependencies", VerifyFossDependencies::class.java) {
            group = "verification"
            description = "Fails when the foss release runtime classpath contains a Google proprietary library."
            configurationName.set(extension.fossConfiguration)
            coordinates.set(
                extension.fossConfiguration.map { name ->
                    project.configurations.getByName(name).incoming.resolutionResult.allComponents
                        .mapNotNull { it.id as? ModuleComponentIdentifier }
                        .map { "${it.group}:${it.module}:${it.version}" }
                },
            )
        }

        val guard = project.tasks.register("checkReleaseAppId", ReleaseAppIdGuard::class.java) {
            group = "verification"
            description = "Fails a release build with a placeholder application id or, when required, no publisher domain."
            applicationId.set(extension.applicationId)
            publisherDomain.set(extension.publisherDomain)
            requirePublisherDomain.set(
                project.providers.gradleProperty("requirePublisherDomain").map { it.toBoolean() }.orElse(false),
            )
        }
        project.tasks.matching { RELEASE_ARTIFACT_TASK.matches(it.name) }.configureEach { dependsOn(guard) }
    }

    private companion object {
        val RELEASE_ARTIFACT_TASK = Regex("(assemble|bundle|package|sign|install)\\w*Release(Bundle)?")
    }
}
