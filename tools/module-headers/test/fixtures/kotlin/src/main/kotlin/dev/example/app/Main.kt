/** App entry for the Kotlin fixture. */
package dev.example.app

import dev.example.core.Store
import dev.example.util.*
import androidx.core.Thing

class Main {
    fun run() {
        val s = Store()
        helper(s)
        Formatter.format(s)
        dup(1)
    }
}
