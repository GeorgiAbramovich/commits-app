package io.github.georgiabramovich.commits

import android.content.Context
import android.net.Uri
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant

/** A commit as shown in the widget. */
data class WidgetCommit(
    val repo: String, // owner/name
    val sha: String,
    val title: String,
    val author: String,
    val date: Instant,
)

/** What the widget shows, stored in private SharedPreferences (never backed up). */
object WidgetData {
    private const val PREFS = "commits"
    private const val PER_REPO = 30
    private const val MAX_ITEMS = 30
    private const val MAX_REPOS = 15

    enum class State { SIGNED_OUT, NO_PINS, OK }

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    fun token(ctx: Context): String? = prefs(ctx).getString("token", null)

    fun pins(ctx: Context): List<String> =
        prefs(ctx).getString("pins", null)?.let { JSONArray(it) }?.let { a -> List(a.length()) { a.getString(it) } }.orEmpty()

    fun state(ctx: Context) = when {
        token(ctx) == null -> State.SIGNED_OUT
        pins(ctx).isEmpty() -> State.NO_PINS
        else -> State.OK
    }

    fun error(ctx: Context): String? = prefs(ctx).getString("error", null)

    fun updatedAt(ctx: Context): Instant? = prefs(ctx).getLong("updated", 0).takeIf { it > 0 }?.let(Instant::ofEpochMilli)

    fun commits(ctx: Context): List<WidgetCommit> {
        val arr = JSONArray(prefs(ctx).getString("items", "[]"))
        return List(arr.length()) {
            val o = arr.getJSONObject(it)
            WidgetCommit(o.getString("repo"), o.getString("sha"), o.getString("title"), o.getString("author"), Instant.parse(o.getString("date")))
        }
    }

    /** Called from the web app whenever the token or pins change. Refreshes the widget only if something changed. */
    fun saveSession(ctx: Context, token: String?, pins: List<String>) {
        val pinsJson = JSONArray(pins).toString()
        val p = prefs(ctx)
        if (p.getString("token", null) == token && p.getString("pins", "[]") == pinsJson) return
        p.edit().apply {
            if (token == null) remove("token") else putString("token", token)
            putString("pins", pinsJson)
            if (token == null) remove("items").remove("updated").remove("error")
        }.apply()
        CommitsWidget.refreshNow(ctx)
        CommitsWidget.render(ctx)
    }

    /** Fetches the newest commits of every pinned repo. Blocking; run it off the main thread. */
    fun refresh(ctx: Context) {
        val token = token(ctx) ?: return
        val pins = pins(ctx).take(MAX_REPOS)
        if (pins.isEmpty()) return
        val all = mutableListOf<WidgetCommit>()
        var error: String? = null
        for (repo in pins) {
            try {
                all += fetchCommits(token, repo)
            } catch (e: ApiError) {
                error = e.message
                if (e.code == 401) break
            } catch (e: Exception) {
                error = "Couldn't reach GitHub"
            }
        }
        val p = prefs(ctx).edit()
        // Keep showing the last good list if every request failed (e.g. offline).
        if (all.isNotEmpty() || error == null) {
            val items = JSONArray()
            all.sortedByDescending { it.date }.take(MAX_ITEMS).forEach {
                items.put(JSONObject().put("repo", it.repo).put("sha", it.sha).put("title", it.title).put("author", it.author).put("date", it.date.toString()))
            }
            p.putString("items", items.toString()).putLong("updated", System.currentTimeMillis())
        }
        if (error == null) p.remove("error") else p.putString("error", error)
        p.apply()
    }

    private class ApiError(val code: Int, message: String) : Exception(message)

    private fun fetchCommits(token: String, repo: String): List<WidgetCommit> {
        val (owner, name) = repo.split("/", limit = 2)
        val url = URL("https://api.github.com/repos/${Uri.encode(owner)}/${Uri.encode(name)}/commits?per_page=$PER_REPO")
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 15_000
            conn.readTimeout = 15_000
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("Accept", "application/vnd.github+json")
            conn.setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
            when (conn.responseCode) {
                200 -> {}
                401 -> throw ApiError(401, "Token expired. Open Commits to sign in again.")
                403 -> throw ApiError(403, "GitHub refused access (rate limit or SSO)")
                404 -> return emptyList() // repo deleted or access removed; skip it
                409 -> return emptyList() // empty repo
                else -> throw ApiError(conn.responseCode, "GitHub returned ${conn.responseCode}")
            }
            val arr = JSONArray(conn.inputStream.bufferedReader().use { it.readText() })
            return List(arr.length()) {
                val c = arr.getJSONObject(it)
                val commit = c.getJSONObject("commit")
                val author = commit.optJSONObject("author")
                WidgetCommit(
                    repo = repo,
                    sha = c.getString("sha"),
                    title = commit.getString("message").substringBefore('\n'),
                    author = c.optJSONObject("author")?.optString("login")?.takeIf { s -> s.isNotEmpty() }
                        ?: author?.optString("name").orEmpty(),
                    date = Instant.parse(author?.optString("date") ?: commit.getJSONObject("committer").getString("date")),
                )
            }
        } finally {
            conn.disconnect()
        }
    }
}
