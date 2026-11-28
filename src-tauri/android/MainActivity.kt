package local.hub.mobile

import android.graphics.Color
import android.os.Bundle
import android.view.View
import androidx.core.graphics.ColorUtils
import androidx.core.view.ViewCompat
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat

class MainActivity : TauriActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WindowCompat.setDecorFitsSystemWindows(window, false)
        @Suppress("DEPRECATION")
        window.statusBarColor = Color.TRANSPARENT
        if (android.os.Build.VERSION.SDK_INT >= 29) {
            window.isStatusBarContrastEnforced = false
        }
        setBarColor(Color.rgb(13, 21, 17))
        val content = findViewById<View>(android.R.id.content)
        ViewCompat.setOnApplyWindowInsetsListener(content) { view, insets ->
            val system = insets.getInsetsIgnoringVisibility(
                WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout()
            )
            val keyboard = insets.getInsets(WindowInsetsCompat.Type.ime())
            view.setPadding(system.left, system.top, system.right, maxOf(system.bottom, keyboard.bottom))
            WindowInsetsCompat.CONSUMED
        }
        ViewCompat.requestApplyInsets(content)
    }

    fun setBarColor(color: Int) {
        // Android 15+ рисует прозрачную статусную строку поверх фона корневого View.
        val content = findViewById<View>(android.R.id.content)
        content.setBackgroundColor(color)
        WindowCompat.getInsetsController(window, content).isAppearanceLightStatusBars =
            ColorUtils.calculateLuminance(color) > 0.179
    }
}
