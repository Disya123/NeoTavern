package com.neotavern.mobile

import android.content.Context
import java.io.File
import java.io.IOException

/**
 * Owns the app's local data root: `<filesDir>/neotavern`.
 *
 * The kernel opens this directory as its data root (single writable owner via
 * the kernel's data-root lease). Files written here MUST be committed
 * atomically — [atomicWrite] writes to a temp file in the same directory and
 * renames it into place, so a crash mid-write can never leave a torn file.
 */
class ManagedDataRoot(context: Context) {

    private val rootDir = File(context.applicationContext.filesDir, DATA_ROOT_NAME)

    /** The data root directory (may not exist yet). */
    fun root(): File = rootDir

    /** Creates the data root if needed and returns it. */
    fun ensure(): File {
        if (!rootDir.exists() && !rootDir.mkdirs()) {
            throw IOException("Unable to create data root: $rootDir")
        }
        if (!rootDir.isDirectory) {
            throw IOException("Data root exists but is not a directory: $rootDir")
        }
        return rootDir
    }

    /**
     * Atomically writes `bytes` to `file` (which must live inside the data
     * root): write to a unique temp file, then rename over the target.
     * Rename within one filesystem is atomic on Android (rename(2) replaces
     * the target); the delete+retry arm only guards exotic filesystems where
     * the JVM rename helper refuses to overwrite.
     */
    fun atomicWrite(file: File, bytes: ByteArray) {
        val parent = file.absoluteFile.parentFile
            ?: throw IOException("Cannot resolve parent directory of $file")
        if (!parent.isDirectory && !parent.mkdirs()) {
            throw IOException("Unable to create parent directory: $parent")
        }
        val temp = File.createTempFile("${file.name}.", ".tmp", parent)
        try {
            temp.writeBytes(bytes)
            if (!temp.renameTo(file)) {
                if (file.exists() && !file.delete()) {
                    throw IOException("Unable to replace existing file: $file")
                }
                if (!temp.renameTo(file)) {
                    throw IOException("Unable to move temp file into place: $temp -> $file")
                }
            }
        } finally {
            if (temp.exists() && !temp.delete()) {
                // Best-effort cleanup of the temp file; the write already succeeded.
            }
        }
    }

    private companion object {
        const val DATA_ROOT_NAME = "neotavern"
    }
}
