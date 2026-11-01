package io.github.georgiabramovich.commits

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.text.format.DateUtils
import android.view.View
import android.widget.RemoteViews
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
            views.setTextViewText(
                R.id.subtitle,
                when {
                    refreshing -> ctx.getString(R.string.widget_refreshing)
                    state != WidgetData.State.OK -> ctx.getString(R.string.widget_title_hint)
                    WidgetData.error(ctx) != null -> WidgetData.error(ctx)
                    updated != null -> ctx.getString(R.string.widget_updated, ago(ctx, updated.toEpochMilli(), now))
                    else -> ctx.getString(R.string.widget_loading)
                },
            )

            val commits = if (state == WidgetData.State.OK) WidgetData.commits(ctx) else emptyList()
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

            val items = RemoteViews.RemoteCollectionItems.Builder().setViewTypeCount(1)
            commits.forEachIndexed { i, c ->
                val row = RemoteViews(ctx.packageName, R.layout.widget_row)
                row.setTextViewText(R.id.repo, c.repo.substringAfter('/'))
                row.setTextViewText(R.id.meta, "${c.author} · ${ago(ctx, c.date.toEpochMilli(), now)}")
                row.setTextViewText(R.id.message, c.title)
                row.setOnClickFillInIntent(
                    R.id.row,
                    Intent().putExtra(MainActivity.EXTRA_HASH, "#/c/${c.repo.split('/').joinToString("/") { Uri.encode(it) }}/${c.sha}"),
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
