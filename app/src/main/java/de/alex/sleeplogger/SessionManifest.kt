package de.alex.sleeplogger

import java.io.File
import java.security.MessageDigest
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import org.json.JSONObject

/** Published last, after all writers have closed and session.json records completion. */
object SessionManifest {
    const val NAME = "session_manifest.json"
    data class Digest(val bytes: Long, val sha256: String)

    fun files(dir: File): List<File> = requireNotNull(dir.listFiles()) { "Cannot read ${dir.name}" }
        .filter { it.isFile && !it.name.startsWith(".") && !it.name.endsWith(".part") }
        .sortedBy { it.name }

    fun digest(file: File): Digest {
        val md = MessageDigest.getInstance("SHA-256")
        val buf = ByteArray(64 * 1024)
        var bytes = 0L
        file.inputStream().use { input ->
            while (true) {
                val n = input.read(buf)
                if (n < 0) break
                md.update(buf, 0, n)
                bytes += n
            }
        }
        val hex = "0123456789abcdef"
        val hash = buildString { for (b in md.digest()) {
            append(hex[(b.toInt() and 255) ushr 4]); append(hex[b.toInt() and 15])
        } }
        return Digest(bytes, hash)
    }

    fun seal(directory: File) {
        require(JSONObject(File(directory, "session.json").readText()).getString("state") == "complete")
        val items = JSONObject()
        for (f in files(directory).filter { it.name != NAME }) {
            val d = digest(f)
            items.put(f.name, JSONObject().put("bytes", d.bytes).put("sha256", d.sha256))
        }
        val manifest = JSONObject().put("version", 1).put("session", directory.name).put("files", items)
        val tmp = File(directory, "$NAME.part")
        try {
            tmp.outputStream().use { out -> out.write(manifest.toString().toByteArray(Charsets.UTF_8)); out.fd.sync() }
            Files.move(tmp.toPath(), File(directory, NAME).toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
        } finally { tmp.delete() }
    }

    /** Includes the digest of the manifest itself. Missing manifests are always copy-only. */
    fun sealedFiles(dir: File): Map<String, Digest>? {
        val file = File(dir, NAME)
        if (!file.isFile) return null
        val manifest = JSONObject(file.readText())
        require(manifest.getInt("version") == 1 && manifest.getString("session") == dir.name)
        require(JSONObject(File(dir, "session.json").readText()).getString("state") == "complete")
        val entries = manifest.getJSONObject("files")
        val result = entries.keys().asSequence().associateWith { key ->
            val value = entries.getJSONObject(key)
            Digest(value.getLong("bytes"), value.getString("sha256"))
        }.toMutableMap()
        require("session.json" in result && NAME !in result)
        result[NAME] = digest(file)
        require(result.keys == files(dir).map { it.name }.toSet()) { "File list changed after completion: ${dir.name}" }
        return result
    }
}
