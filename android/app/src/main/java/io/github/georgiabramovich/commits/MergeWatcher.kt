package io.github.georgiabramovich.commits

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.app.NotificationChannelCompat
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.time.Instant
import java.util.concurrent.TimeUnit

/**
 * Notifies about pull requests merged in the pinned repos. There is no server: the phone checks
 * GitHub every 15 minutes (Android's minimum for background work) with the user's token.
 */
object MergeWatcher {
    private const val PREFS = "merges"
    private const val PERIODIC = "merge-watch"
    private const val ONE_OFF = "merge-watch-now"
    private const val CHANNEL = "merged-prs"
    private const val MAX_REPOS = 15
    private const val MAX_PER_CHECK = 10
    private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

    private data class Merge(val number: Int, val title: String, val author: String, val base: String, val sha: String, val mergedAt: Instant)

    private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

    /** On only if the user turned it on and Android still allows the app to notify. */
    fun isEnabled(ctx: Context) =
        prefs(ctx).getBoolean("enabled", false) && NotificationManagerCompat.from(ctx).areNotificationsEnabled()

    fun setEnabled(ctx: Context, on: Boolean) {
        prefs(ctx).edit().putBoolean("enabled", on).apply()
        val work = WorkManager.getInstance(ctx)
        if (!on) {
            work.cancelUniqueWork(PERIODIC)
            return
        }
        work.enqueueUniquePeriodicWork(
            PERIODIC, ExistingPeriodicWorkPolicy.KEEP,
            PeriodicWorkRequestBuilder<CheckWorker>(15, TimeUnit.MINUTES).setConstraints(online).build(),
        )
        // Check right away so newly pinned repos get their starting point now rather than in 15 minutes.
        work.enqueueUniqueWork(ONE_OFF, ExistingWorkPolicy.REPLACE, OneTimeWorkRequestBuilder<CheckWorker>().setConstraints(online).build())
    }

    class CheckWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
        override fun doWork(): Result {
            check(applicationContext)
            return Result.success()
        }
    }

    /** Notifies about merges newer than each repo's last seen merge. Blocking; run it off the main thread. */
    fun check(ctx: Context) {
        if (!isEnabled(ctx)) return
        val token = WidgetData.token(ctx) ?: return
        // Per repo: merged_at of the newest merge already seen. A repo without one gets its starting point
        // on this check, so turning this on (or pinning a repo) never floods you with old merges.
        val seen = JSONObject(prefs(ctx).getString("seen", "{}")!!)
        for (repo in WidgetData.pins(ctx).take(MAX_REPOS)) {
            val merges = try {
                fetchMerges(token, repo)
            } catch (e: Exception) {
                continue
            }
            val since = seen.optString(repo).takeIf { it.isNotEmpty() }?.let(Instant::parse)
            val newest = merges.maxOfOrNull { it.mergedAt }
            if (since == null) {
                seen.put(repo, (newest ?: Instant.now()).toString())
                continue
            }
            merges.filter { it.mergedAt > since }.sortedBy { it.mergedAt }.takeLast(MAX_PER_CHECK).forEach { notify(ctx, repo, it) }
            if (newest != null && newest > since) seen.put(repo, newest.toString())
        }
        prefs(ctx).edit().putString("seen", seen.toString()).apply()
    }

    private fun fetchMerges(token: String, repo: String): List<Merge> {
        val (owner, name) = repo.split("/", limit = 2)
        val url = URL("https://api.github.com/repos/${Uri.encode(owner)}/${Uri.encode(name)}/pulls?state=closed&sort=updated&direction=desc&per_page=30")
        val conn = url.openConnection() as HttpURLConnection
        try {
            conn.connectTimeout = 15_000
            conn.readTimeout = 15_000
            conn.setRequestProperty("Authorization", "Bearer $token")
            conn.setRequestProperty("Accept", "application/vnd.github+json")
            conn.setRequestProperty("X-GitHub-Api-Version", "2022-11-28")
            if (conn.responseCode != 200) return emptyList()
            val arr = JSONArray(conn.inputStream.bufferedReader().use { it.readText() })
            return (0 until arr.length()).map { arr.getJSONObject(it) }
                .filter { !it.isNull("merged_at") && !it.isNull("merge_commit_sha") }
                .map {
                    Merge(
                        number = it.getInt("number"),
                        title = it.getString("title"),
                        author = it.optJSONObject("user")?.optString("login").orEmpty(),
                        base = it.optJSONObject("base")?.optString("ref").orEmpty(),
                        sha = it.getString("merge_commit_sha"),
                        mergedAt = Instant.parse(it.getString("merged_at")),
                    )
                }
        } finally {
            conn.disconnect()
        }
    }

    private fun notify(ctx: Context, repo: String, m: Merge) {
        val manager = NotificationManagerCompat.from(ctx)
        if (!manager.areNotificationsEnabled()) return
        manager.createNotificationChannel(
            NotificationChannelCompat.Builder(CHANNEL, NotificationManagerCompat.IMPORTANCE_DEFAULT)
                .setName(ctx.getString(R.string.merges_channel))
                .setDescription(ctx.getString(R.string.merges_channel_description))
                .build(),
        )
        val id = "$repo#${m.number}".hashCode()
        val open = Intent(ctx, MainActivity::class.java)
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
            .putExtra(MainActivity.EXTRA_HASH, "#/c/${repo.split('/').joinToString("/") { Uri.encode(it) }}/${m.sha}")
        // "Open PR" goes to the pull request on GitHub in the browser; the notification itself opens the merge commit.
        val (owner, name) = repo.split("/", limit = 2)
        val pr = Intent(Intent.ACTION_VIEW, Uri.parse("https://github.com/${Uri.encode(owner)}/${Uri.encode(name)}/pull/${m.number}"))
            .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        val repoName = repo.substringAfter('/')
        val notification = NotificationCompat.Builder(ctx, CHANNEL)
            .setSmallIcon(R.drawable.ic_notification)
            .setColor(ctx.getColor(R.color.icon_bg_end))
            .setContentTitle("${m.title} (#${m.number})")
            .setContentText(ctx.getString(R.string.merges_text, m.author, m.base, repoName))
            .setWhen(m.mergedAt.toEpochMilli())
            .setShowWhen(true)
            .setAutoCancel(true)
            .setGroup(CHANNEL)
            .setContentIntent(PendingIntent.getActivity(ctx, id, open, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT))
            .addAction(
                0, ctx.getString(R.string.merges_open_pr),
                PendingIntent.getActivity(ctx, "$repo#${m.number}/pr".hashCode(), pr, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT),
            )
            .build()
        try {
            manager.notify(id, notification)
        } catch (e: SecurityException) {
            // Permission revoked between the check above and now.
        }
    }
}
