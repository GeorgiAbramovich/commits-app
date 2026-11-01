package io.github.georgiabramovich.commits

import android.Manifest
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.widget.FrameLayout
import androidx.activity.ComponentActivity
import androidx.activity.addCallback
import androidx.activity.enableEdgeToEdge
import androidx.activity.result.contract.ActivityResultContracts
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewClientCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/** Hosts the bundled web app (repo root) in a WebView and bridges sign-in state to the widget. */
class MainActivity : ComponentActivity() {

    private lateinit var web: WebView
    private var page: JavaScriptReplyProxy? = null

    private val askToNotify = registerForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        setNotify(granted)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        enableEdgeToEdge()

        // Pad for the system bars on a container so the page itself never sits under them.
        val root = FrameLayout(this).apply { setBackgroundColor(getColor(R.color.app_bg)) }
        web = WebView(this)
        root.addView(web)
        setContentView(root)
        ViewCompat.setOnApplyWindowInsetsListener(root) { v, insets ->
            val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.ime())
            v.setPadding(bars.left, bars.top, bars.right, bars.bottom)
            WindowInsetsCompat.CONSUMED
        }

        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web.settings.javaScriptEnabled = true
        web.settings.domStorageEnabled = true
        web.setBackgroundColor(getColor(R.color.app_bg))
        web.webChromeClient = WebChromeClient() // enables confirm() for sign out
        web.webViewClient = object : WebViewClientCompat() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                assets.shouldInterceptRequest(request.url)

            // Our own pages stay in the app; github.com links open in the browser.
            override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean {
                if (request.url.host == HOST) return false
                startActivity(Intent(Intent.ACTION_VIEW, request.url))
                return true
            }
        }

        // The page posts {token, pins} whenever they change, and {notify} from Settings; only our own
        // origin can reach this. We answer with {notify} so the switch shows whether it's really on.
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "CommitsAndroid", setOf("https://$HOST")) { _, message, _, _, reply ->
                page = reply
                val data = JSONObject(message.data ?: return@addWebMessageListener)
                if (data.has("notify")) {
                    when {
                        !data.getBoolean("notify") -> setNotify(false)
                        canNotify() -> setNotify(true)
                        else -> askToNotify.launch(Manifest.permission.POST_NOTIFICATIONS)
                    }
                    return@addWebMessageListener
                }
                WidgetData.saveSession(
                    this,
                    token = data.optString("token").takeIf { !data.isNull("token") && it.isNotEmpty() },
                    pins = data.optJSONArray("pins")?.let { arr -> List(arr.length()) { arr.getString(it) } }.orEmpty(),
                )
                reply.postMessage(JSONObject().put("notify", MergeWatcher.isEnabled(this)).toString())
            }
        }

        onBackPressedDispatcher.addCallback(this) {
            if (web.canGoBack()) web.goBack() else finish()
        }

        if (savedInstanceState != null) web.restoreState(savedInstanceState)
        else web.loadUrl(START_URL + intent.hashExtra())
    }

    // Tapping a commit in the widget while the app is already open.
    override fun onNewIntent(intent: Intent) {
        super.onNewIntent(intent)
        val hash = intent.hashExtra()
        if (hash.isNotEmpty()) web.evaluateJavascript("location.hash = ${JSONObject.quote(hash)}", null)
    }

    override fun onSaveInstanceState(outState: Bundle) {
        super.onSaveInstanceState(outState)
        web.saveState(outState)
    }

    private fun canNotify() =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
            checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED

    private fun setNotify(on: Boolean) {
        MergeWatcher.setEnabled(this, on)
        page?.postMessage(JSONObject().put("notify", MergeWatcher.isEnabled(this)).toString())
    }

    private fun Intent.hashExtra() = getStringExtra(EXTRA_HASH)?.takeIf { it.startsWith("#/") }.orEmpty()

    companion object {
        const val EXTRA_HASH = "hash"
        private const val HOST = WebViewAssetLoader.DEFAULT_DOMAIN
        private const val START_URL = "https://$HOST/assets/www/index.html"
    }
}
