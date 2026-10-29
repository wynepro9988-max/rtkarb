package id.rtka.rumahbintang;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.app.DownloadManager;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.ProgressBar;
import android.widget.Toast;
import android.window.OnBackInvokedDispatcher;

import java.util.Objects;
import java.util.Set;

/**
 * Pembungkus aplikasi web RTKA Rumah Bintang.
 *
 * Semua logika bisnis & otorisasi berada di server. Aplikasi ini sengaja tipis:
 *  - hanya memuat domain BASE_URL; tautan lain dibuka di browser eksternal,
 *  - FLAG_SECURE mencegah screenshot/rekam layar & pratinjau di Recent Apps,
 *  - tanpa akses berkas lokal dan tanpa JavaScript interface,
 *  - cache WebView dibersihkan saat aplikasi ditutup.
 */
public class MainActivity extends Activity {

    private static final int REQUEST_FILE = 41;
    private static final Set<String> EXTERNAL_SCHEMES = Set.of("https", "http", "mailto", "tel");

    private WebView webView;
    private ProgressBar progress;
    private View offline;
    private ValueCallback<Uri[]> fileCallback;
    private Uri baseUri;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE);
        setContentView(R.layout.activity_main);

        baseUri = Uri.parse(BuildConfig.BASE_URL);
        webView = findViewById(R.id.webview);
        progress = findViewById(R.id.progress);
        offline = findViewById(R.id.offline);
        findViewById(R.id.retry).setOnClickListener(v -> {
            offline.setVisibility(View.GONE);
            webView.reload();
        });

        WebView.setWebContentsDebuggingEnabled(BuildConfig.DEBUG);
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setAcceptThirdPartyCookies(webView, false);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);
        s.setGeolocationEnabled(false);
        s.setJavaScriptCanOpenWindowsAutomatically(false);
        s.setSupportMultipleWindows(false);
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        s.setSafeBrowsingEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(true);
        s.setUserAgentString(s.getUserAgentString() + " RTKAApp/" + BuildConfig.VERSION_NAME);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (isAppUrl(uri)) return false;
                openExternally(uri);
                return true;
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                if (request.isForMainFrame()) offline.setVisibility(View.VISIBLE);
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                progress.setVisibility(View.GONE);
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onProgressChanged(WebView view, int newProgress) {
                progress.setVisibility(newProgress < 100 ? View.VISIBLE : View.GONE);
                progress.setProgress(newProgress);
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (fileCallback != null) fileCallback.onReceiveValue(null);
                fileCallback = callback;
                try {
                    startActivityForResult(params.createIntent(), REQUEST_FILE);
                    return true;
                } catch (ActivityNotFoundException e) {
                    fileCallback = null;
                    return false;
                }
            }
        });

        // Unduhan (laporan Excel, dokumen) memakai cookie sesi WebView.
        webView.setDownloadListener((url, userAgent, contentDisposition, mimeType, contentLength) -> {
            Uri uri = Uri.parse(url);
            if (!isAppUrl(uri)) return;
            String name = URLUtil.guessFileName(url, contentDisposition, mimeType);
            String cookie = CookieManager.getInstance().getCookie(url);
            DownloadManager.Request request = new DownloadManager.Request(uri)
                    .addRequestHeader("Cookie", cookie == null ? "" : cookie)
                    .addRequestHeader("User-Agent", userAgent)
                    .setMimeType(mimeType)
                    .setTitle(name)
                    .setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
                    .setDestinationInExternalPublicDir(Environment.DIRECTORY_DOWNLOADS, name);
            getSystemService(DownloadManager.class).enqueue(request);
            Toast.makeText(this, getString(R.string.download_started, name), Toast.LENGTH_SHORT).show();
        });

        if (Build.VERSION.SDK_INT >= 33) {
            getOnBackInvokedDispatcher().registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, () -> {
                if (webView.canGoBack()) webView.goBack();
                else finish();
            });
        }

        if (savedInstanceState != null) webView.restoreState(savedInstanceState);
        else webView.loadUrl(BuildConfig.BASE_URL);
    }

    private boolean isAppUrl(Uri uri) {
        return Objects.equals(uri.getScheme(), baseUri.getScheme())
                && Objects.equals(uri.getHost(), baseUri.getHost())
                && uri.getPort() == baseUri.getPort();
    }

    private void openExternally(Uri uri) {
        if (!EXTERNAL_SCHEMES.contains(uri.getScheme())) return;
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, uri));
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, R.string.no_app, Toast.LENGTH_SHORT).show();
        }
    }

    /** Fallback untuk Android < 13. */
    @SuppressWarnings("deprecation")
    @Override
    public void onBackPressed() {
        if (webView.canGoBack()) webView.goBack();
        else super.onBackPressed();
    }

    @SuppressWarnings("deprecation")
    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_FILE) {
            if (fileCallback != null) {
                fileCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        super.onSaveInstanceState(outState);
        webView.saveState(outState);
    }

    @Override
    protected void onDestroy() {
        if (isFinishing()) {
            webView.clearCache(true);
            CookieManager.getInstance().flush();
        }
        webView.destroy();
        super.onDestroy();
    }
}
