package expo.modules.guardnative

import android.app.AlarmManager
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import org.json.JSONObject

/**
 * Wake-check alarms (PRD 18.8, SUR-GAP-015): a real alarm, not a notification.
 *
 *  - scheduled with AlarmManager.setAlarmClock, which Doze does not defer;
 *  - rung on the ALARM audio stream, so it sounds with the phone on silent or vibrate;
 *  - shown as a full-screen intent, which opens the prompt over the lock screen;
 *  - insistent (the sound repeats) until the guard answers or the ack window closes;
 *  - persisted, and re-armed after a reboot or an app update.
 */
object GuardAlarms {
  private const val PREFS = "guard_alarms"
  const val CHANNEL = "wake_alarm_v1"
  const val EXTRA_ID = "alarm_id"

  private fun prefs(ctx: Context) = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  private fun notificationId(id: String) = ("wake:$id").hashCode()

  fun ensureChannel(ctx: Context) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return
    val nm = ctx.getSystemService(NotificationManager::class.java) ?: return
    if (nm.getNotificationChannel(CHANNEL) != null) return
    val channel = NotificationChannel(CHANNEL, "Wake-check alarms", NotificationManager.IMPORTANCE_HIGH)
    channel.description = "Rings like an alarm during night shifts, even when the phone is silent."
    channel.setSound(
      RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM),
      AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ALARM)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()
    )
    channel.enableVibration(true)
    channel.vibrationPattern = longArrayOf(0, 800, 400, 800, 400, 800)
    channel.lockscreenVisibility = android.app.Notification.VISIBILITY_PUBLIC
    channel.setBypassDnd(true)
    nm.createNotificationChannel(channel)
  }

  fun canScheduleExact(ctx: Context): Boolean {
    val am = ctx.getSystemService(AlarmManager::class.java) ?: return false
    return Build.VERSION.SDK_INT < Build.VERSION_CODES.S || am.canScheduleExactAlarms()
  }

  private fun firePendingIntent(ctx: Context, id: String): PendingIntent {
    val intent = Intent(ctx, GuardAlarmReceiver::class.java).putExtra(EXTRA_ID, id)
    intent.action = "expo.modules.guardnative.ALARM.$id"
    return PendingIntent.getBroadcast(
      ctx, id.hashCode(), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  private fun openPendingIntent(ctx: Context, id: String, url: String): PendingIntent {
    val intent = Intent(Intent.ACTION_VIEW, Uri.parse(url))
      .setPackage(ctx.packageName)
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
    return PendingIntent.getActivity(
      ctx, notificationId(id), intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    )
  }

  fun schedule(ctx: Context, id: String, atMs: Long, title: String, body: String, url: String, timeoutMs: Long): Boolean {
    val record = JSONObject()
      .put("at", atMs).put("title", title).put("body", body).put("url", url).put("timeout", timeoutMs)
    prefs(ctx).edit().putString(id, record.toString()).apply()
    return arm(ctx, id, atMs, url)
  }

  private fun arm(ctx: Context, id: String, atMs: Long, url: String): Boolean {
    val am = ctx.getSystemService(AlarmManager::class.java) ?: return false
    val fire = firePendingIntent(ctx, id)
    return try {
      if (canScheduleExact(ctx)) {
        // setAlarmClock is exempt from Doze and shows the alarm icon, like a clock app.
        am.setAlarmClock(AlarmManager.AlarmClockInfo(atMs, openPendingIntent(ctx, id, url)), fire)
      } else {
        am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, fire)
      }
      true
    } catch (e: SecurityException) {
      am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, atMs, fire)
      true
    }
  }

  fun cancel(ctx: Context, id: String) {
    ctx.getSystemService(AlarmManager::class.java)?.cancel(firePendingIntent(ctx, id))
    prefs(ctx).edit().remove(id).apply()
    dismiss(ctx, id)
  }

  fun dismiss(ctx: Context, id: String) {
    NotificationManagerCompat.from(ctx).cancel(notificationId(id))
  }

  fun scheduledIds(ctx: Context): List<String> = prefs(ctx).all.keys.toList()

  /** Called by the receiver when an alarm is due. */
  fun ring(ctx: Context, id: String) {
    val raw = prefs(ctx).getString(id, null) ?: return
    prefs(ctx).edit().remove(id).apply()
    val r = JSONObject(raw)
    ensureChannel(ctx)

    val open = openPendingIntent(ctx, id, r.optString("url"))
    val icon = ctx.resources.getIdentifier("notification_icon", "drawable", ctx.packageName)
      .takeIf { it != 0 } ?: android.R.drawable.ic_lock_idle_alarm

    val builder = NotificationCompat.Builder(ctx, CHANNEL)
      .setSmallIcon(icon)
      .setContentTitle(r.optString("title"))
      .setContentText(r.optString("body"))
      .setCategory(NotificationCompat.CATEGORY_ALARM)
      .setPriority(NotificationCompat.PRIORITY_MAX)
      .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
      .setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM), android.media.AudioManager.STREAM_ALARM)
      .setVibrate(longArrayOf(0, 800, 400, 800, 400, 800))
      .setContentIntent(open)
      .setFullScreenIntent(open, true)
      .setOngoing(true)
      .setAutoCancel(true)
    val timeout = r.optLong("timeout", 0)
    if (timeout > 0) builder.setTimeoutAfter(timeout)

    val notification = builder.build()
    // Repeat the sound until the guard responds.
    notification.flags = notification.flags or android.app.Notification.FLAG_INSISTENT
    try {
      NotificationManagerCompat.from(ctx).notify(notificationId(id), notification)
    } catch (e: SecurityException) {
      // Notification permission withdrawn: App health already reports this.
    }
  }

  /** After a reboot or an update, alarms are gone from AlarmManager; put back the future ones. */
  fun rearmAll(ctx: Context) {
    val now = System.currentTimeMillis()
    for ((id, value) in prefs(ctx).all) {
      val r = try { JSONObject(value as String) } catch (e: Exception) { null } ?: continue
      val at = r.optLong("at", 0)
      if (at <= now) {
        prefs(ctx).edit().remove(id).apply()
      } else {
        arm(ctx, id, at, r.optString("url"))
      }
    }
  }
}

class GuardAlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    val id = intent.getStringExtra(GuardAlarms.EXTRA_ID) ?: return
    GuardAlarms.ring(context, id)
  }
}

class GuardBootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      Intent.ACTION_BOOT_COMPLETED,
      Intent.ACTION_MY_PACKAGE_REPLACED,
      "android.intent.action.QUICKBOOT_POWERON" -> GuardAlarms.rearmAll(context)
    }
  }
}
