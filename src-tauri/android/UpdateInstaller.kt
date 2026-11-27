package local.hub.mobile

import android.app.Activity
import android.content.Intent
import android.content.pm.PackageInfo
import android.content.pm.PackageManager
import android.content.pm.Signature
import android.net.Uri
import android.os.Build
import android.provider.Settings
import androidx.core.content.FileProvider
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.File

class UpdateFileProvider : FileProvider()

@InvokeArg
class UpdateInstallArgs {
    lateinit var filename: String
}

@TauriPlugin
class UpdateInstaller(private val activity: Activity) : Plugin(activity) {
    @Suppress("DEPRECATION")
    private fun signers(info: PackageInfo): Set<Signature> =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            info.signingInfo?.apkContentsSigners.orEmpty().toSet()
        } else {
            info.signatures.orEmpty().toSet()
        }

    @Suppress("DEPRECATION")
    private fun validate(apk: File) {
        val manager = activity.packageManager
        val flags = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            PackageManager.GET_SIGNING_CERTIFICATES
        } else {
            PackageManager.GET_SIGNATURES
        }
        val update = manager.getPackageArchiveInfo(apk.absolutePath, flags)
        require(update?.packageName == activity.packageName) { "APK выпущен для другого приложения" }
        val current = manager.getPackageInfo(activity.packageName, flags)
        val updateSigners = signers(requireNotNull(update))
        require(updateSigners.isNotEmpty() && updateSigners == signers(current)) {
            "Подпись APK отличается от подписи установленного Хаба"
        }
    }

    @Command
    fun install(invoke: Invoke) {
        val filename = invoke.parseArgs(UpdateInstallArgs::class.java).filename
        if (!Regex("^Hub-[0-9]+\\.[0-9]+\\.[0-9]+-android-arm64\\.apk$").matches(filename)) {
            invoke.reject("Неожиданное имя APK")
            return
        }
        val apk = File(activity.cacheDir, "hub-updates/$filename")
        if (!apk.isFile) {
            invoke.reject("Скачанный APK не найден")
            return
        }

        try {
            validate(apk)
        } catch (e: Exception) {
            invoke.reject(e.message ?: "Не удалось проверить APK")
            return
        }

        activity.runOnUiThread {
            try {
                val permission = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O &&
                    !activity.packageManager.canRequestPackageInstalls()
                if (permission) {
                    val packageUri = Uri.parse("package:" + activity.packageName)
                    activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, packageUri))
                } else {
                    val uri = FileProvider.getUriForFile(activity, activity.packageName + ".update-files", apk)
                    activity.startActivity(Intent(Intent.ACTION_VIEW).apply {
                        setDataAndType(uri, "application/vnd.android.package-archive")
                        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                    })
                }
                invoke.resolve(JSObject().put("permission", permission))
            } catch (e: Exception) {
                invoke.reject(e.message ?: "Не удалось открыть установщик Android")
            }
        }
    }
}
