package com.neotavern.mobile

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.pm.ServiceInfo
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat

/**
 * Builds and updates the generation foreground notification (Phase 8).
 *
 * Status only — the notification NEVER contains chat/message content (§85):
 * titles map the stream payload kind through [NotificationState]
 * (resource-backed initial labels from strings.xml), the small icon is the
 * host drawable and the only action is Stop. The channel is created lazily at
 * IMPORTANCE_LOW with no sound.
 */
object NotificationHelper {

    /** Shows the foreground notification (startForeground within the 5s window). */
    fun showForeground(service: Service) {
        ensureChannel(service)
        val notification = buildNotification(
            service,
            service.getString(R.string.notification_title_generating),
        )
        ServiceCompat.startForeground(
            service,
            NotificationState.NOTIFICATION_ID,
            notification,
            ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC,
        )
    }

    /** Refreshes the foreground notification title for a stream payload kind. */
    fun updateTitle(context: Context, kind: String) {
        ensureChannel(context)
        val title = NotificationState.titleForStreamState(kind)
            ?: context.getString(R.string.notification_title_generating)
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.notify(NotificationState.NOTIFICATION_ID, buildNotification(context, title))
    }

    /**
     * Removes the foreground notification (idempotent).
     *
     * [Service.stopForeground] alone is not enough after [updateTitle]
     * posted the same id through [NotificationManager.notify]: on API 34+
     * (including 36) that copy can linger as a regular notification.
     */
    fun cancelForeground(service: Service) {
        service.stopForeground(Service.STOP_FOREGROUND_REMOVE)
        service.getSystemService(NotificationManager::class.java)
            .cancel(NotificationState.NOTIFICATION_ID)
    }

    private fun ensureChannel(context: Context) {
        val manager = context.getSystemService(NotificationManager::class.java)
        if (manager.getNotificationChannel(NotificationState.CHANNEL_ID) != null) return
        val channel = NotificationChannel(
            NotificationState.CHANNEL_ID,
            context.getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW,
        ).apply {
            setSound(null, null)
            enableVibration(false)
        }
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(context: Context, title: String): Notification {
        val stopIntent = PendingIntent.getService(
            context,
            0,
            GenerationService.stopIntent(context),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val chatId = PresentationCanaryPrefs(context).lastChatId
        val openIntent = PendingIntent.getActivity(
            context,
            1,
            PresentationCanaryHost.openLauncherIntent(context, chatId),
            PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        return NotificationCompat.Builder(context, NotificationState.CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_generation)
            .setContentTitle(title)
            .setContentIntent(openIntent)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setOngoing(true)
            .setOnlyAlertOnce(true)
            .addAction(
                R.drawable.ic_stat_generation,
                context.getString(R.string.notification_action_stop),
                stopIntent,
            )
            .build()
    }
}
