package io.github.georgiabramovich.commits

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.res.ColorStateList
import android.net.Uri
import android.text.format.DateUtils
import android.view.View
import android.widget.RemoteViews
import androidx.core.graphics.ColorUtils
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.Worker
import androidx.work.WorkerParameters
import java.time.Instant
import java.time.ZoneId
import java.time.temporal.ChronoUnit
import java.util.concurrent.TimeUnit

/** Home screen widget: the newest commits across the repos pinned in the app. */
class CommitsWidget : AppWidgetProvider() {

    override fun onEnabled(context: Context) {
        val request = PeriodicWorkRequestBuilder<RefreshWorker>(30, TimeUnit.MINUTES)
            .setConstraints(online)
            .build()
        WorkManager.getInstance(context).enqueueUniquePeriodicWork(PERIODIC, ExistingPeriodicWorkPolicy.KEEP, request)
    }

    override fun onDisabled(context: Context) {
        WorkManager.getInstance(context).cancelUniqueWork(PERIODIC)
    }

    override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) {
        render(context)
        refreshNow(context)
    }

    override fun onReceive(context: Context, intent: Intent) {
        super.onReceive(context, intent)
        // Also refresh right after an app update, so new widget code shows without waiting.
        if (intent.action == ACTION_REFRESH || intent.action == Intent.ACTION_MY_PACKAGE_REPLACED) {
            render(context, refreshing = true)
            refreshNow(context)
        }
    }

    class RefreshWorker(context: Context, params: WorkerParameters) : Worker(context, params) {
        override fun doWork(): Result {
            WidgetData.refresh(applicationContext)
            render(applicationContext)
            return Result.success()
        }
    }

    companion object {
        private const val ACTION_REFRESH = "io.github.georgiabramovich.commits.REFRESH"
        private const val PERIODIC = "widget-periodic"
        private const val ONE_OFF = "widget-now"
        private val online = Constraints.Builder().setRequiredNetworkType(NetworkType.CONNECTED).build()

        fun refreshNow(ctx: Context) {
            val request = OneTimeWorkRequestBuilder<RefreshWorker>().setConstraints(online).build()
            WorkManager.getInstance(ctx).enqueueUniqueWork(ONE_OFF, ExistingWorkPolicy.REPLACE, request)
        }

        fun render(ctx: Context, refreshing: Boolean = false) {
            val manager = AppWidgetManager.getInstance(ctx)
            val ids = manager.getAppWidgetIds(ComponentName(ctx, CommitsWidget::class.java))
            if (ids.isEmpty()) return
            val views = buildViews(ctx, refreshing)
            ids.forEach { manager.updateAppWidget(it, views) }
        }

        private fun buildViews(ctx: Context, refreshing: Boolean): RemoteViews {
            val views = RemoteViews(ctx.packageName, R.layout.widget)
            val now = System.currentTimeMillis()

            views.setOnClickPendingIntent(R.id.header, openApp(ctx, 0, null))
            views.setOnClickPendingIntent(R.id.empty, openApp(ctx, 1, null))
            views.setOnClickPendingIntent(
                R.id.refresh,
                PendingIntent.getBroadcast(
                    ctx, 0,
                    Intent(ctx, CommitsWidget::class.java).setAction(ACTION_REFRESH),
                    PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
                ),
            )

            val state = WidgetData.state(ctx)
            val updated = WidgetData.updatedAt(ctx)
            val commits = if (state == WidgetData.State.OK) WidgetData.commits(ctx) else emptyList()
            // Commits newer than the newest one there was when the app was last opened.
            val seen = WidgetData.seenAt(ctx)
            val isNew = { c: WidgetCommit -> seen != null && c.date > seen }
            val newCount = commits.count(isNew)
            // With a single pinned repo its name goes in the title instead of on every row.
            val pins = WidgetData.pins(ctx)
            val singleRepo = pins.size == 1
            views.setTextViewText(
                R.id.title,
                if (singleRepo && state == WidgetData.State.OK) pins[0].substringAfter('/') else ctx.getString(R.string.widget_title),
            )
            views.setTextViewText(
                R.id.subtitle,
                when {
                    refreshing -> ctx.getString(R.string.widget_refreshing)
                    state != WidgetData.State.OK -> ctx.getString(R.string.widget_title_hint)
                    WidgetData.error(ctx) != null -> WidgetData.error(ctx)
                    updated != null && newCount > 0 ->
                        ctx.getString(R.string.widget_new_updated, newCount, ago(ctx, updated.toEpochMilli(), now))
                    updated != null -> ctx.getString(R.string.widget_updated, ago(ctx, updated.toEpochMilli(), now))
                    else -> ctx.getString(R.string.widget_loading)
                },
            )

            views.setTextViewText(
                R.id.empty,
                ctx.getString(
                    when (state) {
                        WidgetData.State.SIGNED_OUT -> R.string.widget_signed_out
                        WidgetData.State.NO_PINS -> R.string.widget_no_pins
                        WidgetData.State.OK -> if (updated == null) R.string.widget_loading else R.string.widget_no_commits
                    },
                ),
            )

            val slots = authorSlots(commits.map { it.author })
            val items = RemoteViews.RemoteCollectionItems.Builder().setViewTypeCount(1)
            commits.forEachIndexed { i, c ->
                val row = RemoteViews(ctx.packageName, R.layout.widget_row)
                val slot = slots.getValue(c.author)
                val (light, dark) = AUTHOR_COLORS[slot]
                row.setColorStateList(
                    R.id.row, "setBackgroundTintList",
                    ColorStateList.valueOf(ColorUtils.blendARGB(CARD_LIGHT, light, 0.16f)),
                    ColorStateList.valueOf(ColorUtils.blendARGB(CARD_DARK, dark, 0.20f)),
                )
                row.setColorInt(R.id.dot, "setColorFilter", light, dark)
                row.setColorInt(R.id.author, "setTextColor", light, dark)
                row.setTextViewText(R.id.author, c.author)
                row.setTextViewText(R.id.time, " · ${ago(ctx, c.date.toEpochMilli(), now)}")
                row.setViewVisibility(R.id.fresh, if (isNew(c)) View.VISIBLE else View.GONE)
                row.setTextViewText(R.id.repo, c.repo.substringAfter('/'))
                row.setViewVisibility(R.id.repo, if (singleRepo) View.GONE else View.VISIBLE)
                row.setTextViewText(R.id.message, c.title)
                row.setOnClickFillInIntent(
                    R.id.row,
                    // The app tints the commit screen with the same color this card shows.
                    Intent().putExtra(MainActivity.EXTRA_HASH, "#/c/${c.repo.split('/').joinToString("/") { Uri.encode(it) }}/${c.sha}?tint=$slot"),
                )
                items.addItem(i.toLong(), row)
            }
            views.setRemoteAdapter(R.id.list, items.build())
            views.setEmptyView(R.id.list, R.id.empty)
            views.setPendingIntentTemplate(R.id.list, openApp(ctx, 2, null, mutable = true))
            views.setViewVisibility(R.id.refresh, if (state == WidgetData.State.OK) View.VISIBLE else View.GONE)
            return views
        }

        private fun openApp(ctx: Context, requestCode: Int, hash: String?, mutable: Boolean = false): PendingIntent {
            val intent = Intent(ctx, MainActivity::class.java)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                .apply { if (hash != null) putExtra(MainActivity.EXTRA_HASH, hash) }
            val flags = PendingIntent.FLAG_UPDATE_CURRENT or
                if (mutable) PendingIntent.FLAG_MUTABLE else PendingIntent.FLAG_IMMUTABLE
            return PendingIntent.getActivity(ctx, requestCode, intent, flags)
        }

        // Cards are a wash of the author's color over these bases, light and dark respectively.
        private const val CARD_LIGHT = 0xFFFFFFFF.toInt()
        private const val CARD_DARK = 0xFF1C1B1F.toInt()

        // Each author keeps one color: a deep shade for light mode and a soft one for dark mode.
        // app.js has the same list, hash and probing (AUTHOR_COLORS there): keep them in sync.
        // All pairs measure >= 4.5:1 against the row surface (tone 90 light / tone 20 dark).
        private val AUTHOR_COLORS = listOf(
            0xFF00695C to 0xFF4DB6AC, // teal
            0xFFB23C00 to 0xFFFFB74D, // orange
            0xFFAD1457 to 0xFFF48FB1, // pink
            0xFF1259B5 to 0xFF64B5F6, // blue
            0xFF6A1B9A to 0xFFCE93D8, // purple
            0xFF236C28 to 0xFF81C784, // green
            0xFF7A5C00 to 0xFFFFD54F, // amber
            0xFF3949AB to 0xFF9FA8DA, // indigo
            0xFFB71C1C to 0xFFEF9A9A, // red
            0xFF006874 to 0xFF4DD0E1, // cyan
        ).map { (l, d) -> l.toInt() to d.toInt() }

        /**
         * Each author starts from a color derived from their name, so it stays the same across refreshes.
         * If someone else in the list already has it, they take the next free one, so up to
         * [AUTHOR_COLORS].size people on screen never share a color. Returns each author's index.
         */
        private fun authorSlots(authors: List<String>): Map<String, Int> {
            val taken = BooleanArray(AUTHOR_COLORS.size)
            val result = mutableMapOf<String, Int>()
            for (author in authors.distinct()) {
                var slot = Math.floorMod(author.lowercase().hashCode(), AUTHOR_COLORS.size)
                if (taken.all { it }) taken.fill(false)
                while (taken[slot]) slot = (slot + 1) % AUTHOR_COLORS.size
                taken[slot] = true
                result[author] = slot
            }
            return result
        }

        /** "14 min. ago" today, "Yesterday", then the date ("Oct 28"; with the year if it isn't this year). */
        private fun ago(ctx: Context, then: Long, now: Long): String {
            val zone = ZoneId.systemDefault()
            val thenDay = Instant.ofEpochMilli(then).atZone(zone).toLocalDate()
            val nowDay = Instant.ofEpochMilli(now).atZone(zone).toLocalDate()
            val days = ChronoUnit.DAYS.between(thenDay, nowDay)
            return when {
                now - then < DateUtils.MINUTE_IN_MILLIS -> "now"
                days <= 0 -> DateUtils.getRelativeTimeSpanString(then, now, DateUtils.MINUTE_IN_MILLIS, DateUtils.FORMAT_ABBREV_ALL).toString()
                days == 1L -> ctx.getString(R.string.yesterday)
                else -> DateUtils.formatDateTime(
                    ctx, then,
                    DateUtils.FORMAT_SHOW_DATE or DateUtils.FORMAT_ABBREV_MONTH or
                        if (thenDay.year == nowDay.year) DateUtils.FORMAT_NO_YEAR else DateUtils.FORMAT_SHOW_YEAR,
                )
            }
        }
    }
}
