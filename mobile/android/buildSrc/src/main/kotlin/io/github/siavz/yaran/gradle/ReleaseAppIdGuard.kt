/**
 * ReleaseAppIdGuard: the `checkReleaseAppId` task every release variant depends on.
 *
 * The repository's application id is the placeholder `com.example.yaran`, because inventing a
 * domain is forbidden (D16); the maintainer sets the real one in `mobile/publisher.properties`
 * (Phase 21). This guard fails any release build still on a `com.example.` id, and, when
 * `requirePublisherDomain` is set, any release build with an empty publisher domain.
 *
 * - [releaseAppIdProblems] is the pure decision the task and the TestKit tests share.
 *
 * <module-headers:begin>
 * Uses: none
 * External: org.gradle.api, org.gradle.api.provider, org.gradle.api.tasks
 *
 * Used by:
 * io.github.siavz.yaran.gradle.ReleaseAppIdGuard
 * ├── io.github.siavz.yaran.gradle.AndroidGuardsPlugin (inferred)
 * └── io.github.siavz.yaran.gradle.AndroidGuardsPluginTest (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.gradle

import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.provider.Property
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

/** Every reason a release with these values must not build; empty when it may. */
fun releaseAppIdProblems(applicationId: String, publisherDomain: String, requirePublisherDomain: Boolean): List<String> = buildList {
    if (applicationId.startsWith("com.example.")) {
        add("applicationId $applicationId is the repository placeholder: set appId in mobile/publisher.properties")
    }
    if (requirePublisherDomain && publisherDomain.isBlank()) {
        add("publisherDomain is empty but -PrequirePublisherDomain=true: an official release must not ship the development callback")
    }
}

abstract class ReleaseAppIdGuard : DefaultTask() {
    @get:Input
    abstract val applicationId: Property<String>

    @get:Input
    abstract val publisherDomain: Property<String>

    @get:Input
    abstract val requirePublisherDomain: Property<Boolean>

    @TaskAction
    fun check() {
        val problems = releaseAppIdProblems(applicationId.get(), publisherDomain.get(), requirePublisherDomain.get())
        if (problems.isNotEmpty()) throw GradleException("Release build refused:\n" + problems.joinToString("\n") { "  - $it" })
    }
}
