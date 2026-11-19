/**
 * The vault directory's own listing and erase, for [Vault] (Sol native review round 11).
 *
 * A listing that fails is never read as "no files": a vault directory never created (a fresh
 * install) is empty, while one that exists and cannot be listed is [CoreError.Unavailable], or a
 * wipe would skip every namespace and then delete the lock that still guards them, and an erase
 * would report itself finished.
 *
 * <module-headers:begin>
 * Uses:
 * io.github.siavz.yaran.core.VaultFiles
 * ├── io.github.siavz.yaran.core.KeyProvider (inferred)
 * └── io.github.siavz.yaran.core.Vault (inferred)
 * External: java.io
 *
 * Used by:
 * io.github.siavz.yaran.core.VaultFiles
 * └── io.github.siavz.yaran.core.Vault (inferred)
 * <module-headers:end>
 */
package io.github.siavz.yaran.core

import java.io.File

/** The files in [dir] that [filter] keeps; empty only when [dir] was never created. */
internal fun listVault(
    dir: File,
    filter: (File) -> Boolean,
): List<File> = dir.listFiles(filter)?.toList() ?: if (dir.exists()) throw CoreError.Unavailable("cannot list the vault") else emptyList()

/**
 * Deletes every file in [dir], then every keystore key. The keys go whatever happens, which leaves
 * anything still on disk unreadable; a listing or deletion that failed is then reported as
 * [CoreError.Unavailable] rather than as an erase that finished.
 */
internal fun eraseVault(
    dir: File,
    keys: KeyProvider,
) {
    val leftover = runCatching { listVault(dir) { true }.filterNot { it.delete() } }
    keys.deleteAll()
    if (leftover.isFailure || leftover.getOrNull().orEmpty().isNotEmpty()) throw CoreError.Unavailable("the vault was not fully erased")
}
