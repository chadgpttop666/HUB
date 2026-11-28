package local.hub.mobile

import android.app.Activity
import android.app.AlarmManager
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.provider.Settings
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import app.tauri.annotation.Command
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray
import org.json.JSONObject

private const val FIRE_ALARM = "local.hub.mobile.CALENDAR_RING"
private const val FIRE_REGULAR = "local.hub.mobile.CALENDAR_NOTIFY"
private const val STOP = "local.hub.mobile.CALENDAR_STOP"
private const val SNOOZE = "local.hub.mobile.CALENDAR_SNOOZE"
private const val ALARM_NOTIFICATION = 3287
private const val LATE_MS = 120_000L
private const val SNOOZE_MS = 5 * 60_000L
private const val MAX_RING_MS = 10 * 60_000L

@TauriPlugin
class CalendarReminders(private val activity: Activity) : Plugin(activity) {
    @Command
    fun replace(invoke: Invoke) {
        val entries = invoke.getArgs().optJSONArray("entries") ?: JSONArray()
        activity.runOnUiThread {
            try {
                CalendarSchedule.replace(activity, entries)
                invoke.resolve()
            } catch (error: Exception) {
                invoke.reject(error.message ?: "Не удалось сохранить напоминания")
            }
        }
    }

    @Command
    fun permissions(invoke: Invoke) {
        val request = invoke.getArgs().optString("request")
        activity.runOnUiThread {
            try {
                if (request == "notifications" && !CalendarSchedule.notificationsEnabled(activity)) {
                    val settings = if (Build.VERSION.SDK_INT >= 26) {
                        Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, activity.packageName)
                    } else {
                        Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:${activity.packageName}"))
                    }
                    activity.startActivity(settings)
                } else if (request == "exact" && Build.VERSION.SDK_INT >= 31 && !CalendarSchedule.exactEnabled(activity)) {
                    activity.startActivity(Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, Uri.parse("package:${activity.packageName}")))
                }
                CalendarSchedule.reschedule(activity)
                invoke.resolve(JSObject().apply {
                    put("supported", true)
                    put("platform", "phone")
                    put("notifications", CalendarSchedule.notificationsEnabled(activity))
                    put("exact", CalendarSchedule.exactEnabled(activity))
                })
            } catch (error: Exception) {
                invoke.reject(error.message ?: "Не удалось открыть разрешения")
            }
        }
    }
}

private data class Entry(val id: String, val at: Long, val kind: String, val due: Long = at, val fired: Boolean = false) {
    fun json() = JSONObject().put("id", id).put("at", at).put("kind", kind).put("due", due).put("fired", fired)

    companion object {
        fun parse(data: JSONObject): Entry {
            val at = data.getLong("at")
            return Entry(data.getString("id"), at, data.getString("kind"), data.optLong("due", at), data.optBoolean("fired"))
        }
    }
}

object CalendarSchedule {
    private fun prefs(context: Context) = context.getSharedPreferences("hub-calendar-reminders", Context.MODE_PRIVATE)
    private fun alarms(context: Context) = context.getSystemService(AlarmManager::class.java)
    private fun notifications(context: Context) = context.getSystemService(NotificationManager::class.java)

    fun notificationsEnabled(context: Context) = notifications(context).areNotificationsEnabled()
    fun exactEnabled(context: Context) = Build.VERSION.SDK_INT < 31 || alarms(context).canScheduleExactAlarms()

    private fun load(context: Context): List<Entry> {
        val data = JSONArray(prefs(context).getString("entries", "[]") ?: "[]")
        return List(data.length()) { Entry.parse(data.getJSONObject(it)) }
    }

    private fun save(context: Context, entries: List<Entry>) {
        check(prefs(context).edit().putString("entries", JSONArray(entries.map { it.json() }).toString()).commit()) {
            "Не удалось сохранить расписание Android"
        }
    }

    fun replace(context: Context, input: JSONArray) {
        val old = load(context).associateBy { it.id }
        val entries = List(input.length()) { Entry.parse(input.getJSONObject(it)) }.map { incoming ->
            val previous = old[incoming.id]
            if (previous != null && previous.at == incoming.at && previous.kind == incoming.kind) previous else incoming
        }
        val byId = entries.associateBy { it.id }
        for ((id, previous) in old) {
            val current = byId[id]
            if (current == null || current.at != previous.at || current.kind != previous.kind) {
                notifications(context).cancel("calendar:$id", 1)
                if (CalendarAlarmService.activeId == id) context.stopService(Intent(context, CalendarAlarmService::class.java))
            }
        }
        save(context, entries)
        reschedule(context)
    }

    private fun pending(context: Context, action: String, id: String = ""): PendingIntent {
        val intent = Intent(context, CalendarAlarmReceiver::class.java).setAction(action)
        if (id.isNotEmpty()) {
            intent.data = Uri.Builder().scheme("hub-calendar").authority("reminder").appendPath(id).build()
            intent.putExtra("id", id)
        }
        return PendingIntent.getBroadcast(context, 0, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    private fun openHub(context: Context): PendingIntent {
        val intent = Intent(context, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP)
        return PendingIntent.getActivity(context, 327, intent, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    }

    fun reschedule(context: Context) {
        val manager = alarms(context)
        val exact = exactEnabled(context)
        val enabled = notificationsEnabled(context)
        val now = System.currentTimeMillis()
        val entries = load(context).filter { !it.fired && it.due >= now - (if (it.kind == "alarm") LATE_MS else 3_600_000L) }
        for (isAlarm in listOf(true, false)) {
            val operation = pending(context, if (isAlarm) FIRE_ALARM else FIRE_REGULAR)
            val next = entries.filter { (it.kind == "alarm") == isAlarm }.minOfOrNull { it.due }
            if (next == null || !enabled || (isAlarm && !exact)) {
                manager.cancel(operation)
                continue
            }
            val time = maxOf(next, now + 250L)
            try {
                if (isAlarm) manager.setAlarmClock(AlarmManager.AlarmClockInfo(time, openHub(context)), operation)
                else if (exact) manager.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, time, operation)
                else manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, time, operation)
            } catch (error: SecurityException) {
                if (!isAlarm) manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, time, operation)
            }
        }
    }

    private fun channels(context: Context) {
        if (Build.VERSION.SDK_INT < 26) return
        notifications(context).createNotificationChannels(listOf(
            NotificationChannel("hub-calendar-quiet", "Календарь · тихие", NotificationManager.IMPORTANCE_LOW),
            NotificationChannel("hub-calendar-normal", "Календарь · обычные", NotificationManager.IMPORTANCE_DEFAULT),
            NotificationChannel("hub-calendar-alarm", "Календарь · будильник", NotificationManager.IMPORTANCE_HIGH).apply {
                setSound(null, null) // Звонком и его остановкой управляет служба.
            }
        ))
    }

    private fun regular(context: Context, entry: Entry) {
        val quiet = entry.kind == "silent"
        val notification = NotificationCompat.Builder(context, if (quiet) "hub-calendar-quiet" else "hub-calendar-normal")
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle("Календарь Хаба")
            .setContentText("Время события")
            .setContentIntent(openHub(context))
            .setAutoCancel(true)
            .apply { if (quiet) setSilent(true) else setDefaults(Notification.DEFAULT_ALL) }
            .build()
        notifications(context).notify("calendar:${entry.id}", 1, notification)
    }

    fun alarmNotification(context: Context, id: String): Notification {
        channels(context)
        return NotificationCompat.Builder(context, "hub-calendar-alarm")
            .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
            .setContentTitle("Будильник Хаба")
            .setContentText("Время события в календаре")
            .setContentIntent(openHub(context))
            .setCategory(NotificationCompat.CATEGORY_ALARM)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setOngoing(true)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .addAction(0, "Выключить", pending(context, STOP, id))
            .addAction(0, "Отложить на 5 минут", pending(context, SNOOZE, id))
            .build()
    }

    fun deliver(context: Context, isAlarm: Boolean) {
        if (!notificationsEnabled(context) || (isAlarm && !exactEnabled(context))) return
        val now = System.currentTimeMillis()
        val entries = load(context)
        // Неточный сигнал Android может прийти поздно. Для будильника ограничиваем задержку.
        val due = entries.filter {
            !it.fired && (it.kind == "alarm") == isAlarm && it.due <= now &&
                now - it.due <= (if (isAlarm) LATE_MS else 3_600_000L)
        }
        if (due.isEmpty()) {
            reschedule(context)
            return
        }
        val ids = due.map { it.id }.toSet()
        save(context, entries.map { if (it.id in ids) it.copy(fired = true) else it })
        channels(context)
        if (isAlarm) {
            val intent = Intent(context, CalendarAlarmService::class.java).putExtra("id", due.first().id)
            try { ContextCompat.startForegroundService(context, intent) }
            catch (_: IllegalStateException) { regular(context, due.first().copy(kind = "normal")) }
            catch (_: SecurityException) { regular(context, due.first().copy(kind = "normal")) }
        } else {
            due.forEach { regular(context, it) }
        }
        reschedule(context)
    }

    fun stop(context: Context, id: String, snooze: Boolean) {
        if (CalendarAlarmService.activeId != id) return
        context.stopService(Intent(context, CalendarAlarmService::class.java))
        if (snooze) {
            val entries = load(context).map { entry ->
                if (entry.id == id) entry.copy(due = System.currentTimeMillis() + SNOOZE_MS, fired = false) else entry
            }
            save(context, entries)
            reschedule(context)
        }
    }
}

class CalendarAlarmReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        try {
            when (intent.action) {
                FIRE_ALARM -> CalendarSchedule.deliver(context, true)
                FIRE_REGULAR -> CalendarSchedule.deliver(context, false)
                STOP, SNOOZE -> intent.getStringExtra("id")?.let { CalendarSchedule.stop(context, it, intent.action == SNOOZE) }
                Intent.ACTION_BOOT_COMPLETED, Intent.ACTION_MY_PACKAGE_REPLACED, Intent.ACTION_TIME_CHANGED,
                AlarmManager.ACTION_SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED -> CalendarSchedule.reschedule(context)
            }
        } catch (error: Exception) {
            android.util.Log.w("HubCalendar", "Не удалось обработать напоминание", error)
        }
    }
}

class CalendarAlarmService : Service() {
    companion object {
        var activeId: String? = null
            private set
    }

    private var player: MediaPlayer? = null
    private val handler = Handler(Looper.getMainLooper())
    private val timeout = Runnable { stopSelf() }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val id = intent?.getStringExtra("id") ?: run { stopSelf(); return START_NOT_STICKY }
        activeId = id
        val serviceType = if (Build.VERSION.SDK_INT >= 29) ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK else 0
        ServiceCompat.startForeground(this, ALARM_NOTIFICATION, CalendarSchedule.alarmNotification(this, id), serviceType)
        if (player == null) {
            try {
                val uri = RingtoneManager.getActualDefaultRingtoneUri(this, RingtoneManager.TYPE_ALARM)
                    ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
                player = MediaPlayer()
                player?.apply {
                    setAudioAttributes(AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_ALARM)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION).build())
                    setDataSource(this@CalendarAlarmService, uri)
                    setWakeMode(this@CalendarAlarmService, android.os.PowerManager.PARTIAL_WAKE_LOCK)
                    isLooping = true
                    setOnPreparedListener { it.start() }
                    setOnErrorListener { _, _, _ -> stopSelf(); true }
                    prepareAsync()
                }
            } catch (error: Exception) {
                android.util.Log.w("HubCalendar", "Аудио будильника недоступно", error)
                stopSelf()
            }
        }
        handler.removeCallbacks(timeout)
        handler.postDelayed(timeout, MAX_RING_MS)
        return START_NOT_STICKY
    }

    override fun onDestroy() {
        handler.removeCallbacks(timeout)
        player?.release()
        activeId = null
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
        super.onDestroy()
    }
}
