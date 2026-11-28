package local.hub.mobile

import android.app.Activity
import android.graphics.Color
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.Plugin

@InvokeArg
class BarColorArgs {
    lateinit var color: String
}

@TauriPlugin
class SystemBars(private val activity: Activity) : Plugin(activity) {
    @Command
    fun setColor(invoke: Invoke) {
        val color = invoke.parseArgs(BarColorArgs::class.java).color
        if (!Regex("^#[0-9a-fA-F]{6}$").matches(color)) {
            invoke.reject("Нужен цвет темы в формате RGB")
            return
        }
        activity.runOnUiThread {
            (activity as MainActivity).setBarColor(Color.parseColor(color))
            invoke.resolve()
        }
    }
}
