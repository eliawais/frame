package app.erev.mobile;

import android.Manifest;
import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.Color;
import android.media.projection.MediaProjectionManager;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Base64;
import android.util.Rational;
import android.view.Gravity;
import android.view.View;
import android.view.WindowInsets;
import android.webkit.CookieManager;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;
import android.widget.Toast;
import androidx.webkit.JavaScriptReplyProxy;
import androidx.webkit.WebViewCompat;
import androidx.webkit.WebViewFeature;

import org.json.JSONException;
import org.json.JSONObject;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class MainActivity extends Activity implements ScreenShareService.Listener {
    private static final String ORIGIN = "https://erev.pages.dev";
    private static final int CAPTURE = 1;
    private static final int MEDIA_PERMISSION = 2;
    private static final int CHOOSE_FILE = 3;

    private WebView browser;
    private TextView pipLabel;
    private JavaScriptReplyProxy captureReply;
    private String captureId;
    private boolean pickerOpen;
    private boolean projectionRunning;
    private PermissionRequest mediaRequest;
    private ValueCallback<Uri[]> fileResult;
    private boolean androidLoginOpen;

    @Override
    public void onCreate(Bundle state) {
        super.onCreate(state);
        browser = new WebView(this);
        browser.setBackgroundColor(Color.rgb(20, 21, 19));
        pipLabel = new TextView(this);
        pipLabel.setText("Erev is sharing your screen");
        pipLabel.setTextColor(Color.WHITE);
        pipLabel.setBackgroundColor(Color.rgb(20, 21, 19));
        pipLabel.setGravity(Gravity.CENTER);
        pipLabel.setVisibility(View.GONE);
        FrameLayout layout = new FrameLayout(this);
        layout.addView(browser);
        layout.addView(pipLabel);
        if (Build.VERSION.SDK_INT >= 35) {
            layout.setOnApplyWindowInsetsListener((view, insets) -> {
                var bars = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
                view.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                return insets;
            });
        }
        setContentView(layout);

        WebSettings settings = browser.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        CookieManager.getInstance().setAcceptThirdPartyCookies(browser, false);

        browser.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                if (!request.isForMainFrame()) return false;
                Uri url = request.getUrl();
                if (sameOrigin(url)) {
                    if (!"/auth/google".equals(url.getPath())) return false;
                    openGoogleSignIn();
                } else if ("https".equals(url.getScheme())) {
                    openBrowser(url);
                }
                return true;
            }
        });

        browser.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                requestMedia(request);
            }

            @Override
            public void onPermissionRequestCanceled(PermissionRequest request) {
                if (mediaRequest == request) mediaRequest = null;
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> result, FileChooserParams params) {
                if (fileResult != null) fileResult.onReceiveValue(null);
                fileResult = result;
                try {
                    startActivityForResult(params.createIntent(), CHOOSE_FILE);
                } catch (ActivityNotFoundException error) {
                    fileResult.onReceiveValue(null);
                    fileResult = null;
                }
                return true;
            }
        });

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(browser, "ErevAndroid", Collections.singleton(ORIGIN),
                (view, message, origin, mainFrame, reply) -> {
                    if (mainFrame && sameOrigin(origin)) handleCaptureMessage(message.getData(), reply);
                });
        }
        ScreenShareService.setListener(this);
        if (!finishSignIn(getIntent())) browser.loadUrl(ORIGIN + "/");
    }

    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        finishSignIn(intent);
    }

    private static boolean sameOrigin(Uri uri) {
        return "https".equals(uri.getScheme()) && "erev.pages.dev".equals(uri.getHost())
            && uri.getUserInfo() == null && (uri.getPort() == -1 || uri.getPort() == 443);
    }

    private void openGoogleSignIn() {
        if (androidLoginOpen) return;
        androidLoginOpen = true;
        byte[] random = new byte[32];
        new SecureRandom().nextBytes(random);
        int flags = Base64.URL_SAFE | Base64.NO_PADDING | Base64.NO_WRAP;
        String verifier = Base64.encodeToString(random, flags);
        String challenge;
        try {
            challenge = Base64.encodeToString(MessageDigest.getInstance("SHA-256")
                .digest(verifier.getBytes(StandardCharsets.US_ASCII)), flags);
        } catch (NoSuchAlgorithmException error) {
            throw new IllegalStateException(error);
        }
        CookieManager.getInstance().setCookie(ORIGIN, "__Host-erev-android=" + verifier
            + "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600", success -> {
                androidLoginOpen = false;
                if (isFinishing() || isDestroyed()) return;
                if (Boolean.TRUE.equals(success)) {
                    CookieManager.getInstance().flush();
                    openBrowser(Uri.parse(ORIGIN + "/auth/android?challenge=" + challenge));
                } else {
                    Toast.makeText(this, "Could not start sign-in. Try again.", Toast.LENGTH_SHORT).show();
                }
            });
    }

    private boolean finishSignIn(Intent intent) {
        Uri url = intent.getData();
        if (url == null || !"erev-android".equals(url.getScheme()) || !"login".equals(url.getHost())) return false;
        String code = url.getQueryParameter("code");
        if (code == null || !code.matches("[A-Za-z0-9_-]{43}")) return false;
        stopCapture();
        browser.loadUrl(ORIGIN + "/auth/android/finish#" + code);
        setIntent(new Intent());
        return true;
    }

    private void openBrowser(Uri url) {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW, url).addCategory(Intent.CATEGORY_BROWSABLE));
        } catch (ActivityNotFoundException error) {
            Toast.makeText(this, "Install a web browser to open this link.", Toast.LENGTH_SHORT).show();
        }
    }

    private void requestMedia(PermissionRequest request) {
        if (!sameOrigin(request.getOrigin()) || mediaRequest != null) {
            request.deny();
            return;
        }
        List<String> missing = new ArrayList<>();
        for (String resource : request.getResources()) {
            String permission = permissionFor(resource);
            if (permission != null && checkSelfPermission(permission) != PackageManager.PERMISSION_GRANTED) {
                missing.add(permission);
            }
        }
        if (missing.isEmpty()) {
            grantMedia(request);
        } else {
            mediaRequest = request;
            requestPermissions(missing.toArray(new String[0]), MEDIA_PERMISSION);
        }
    }

    private static String permissionFor(String resource) {
        if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)) return Manifest.permission.RECORD_AUDIO;
        if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)) return Manifest.permission.CAMERA;
        return null;
    }

    private void grantMedia(PermissionRequest request) {
        List<String> allowed = new ArrayList<>();
        for (String resource : request.getResources()) {
            String permission = permissionFor(resource);
            if (permission != null && checkSelfPermission(permission) == PackageManager.PERMISSION_GRANTED) {
                allowed.add(resource);
            }
        }
        if (allowed.isEmpty()) request.deny();
        else request.grant(allowed.toArray(new String[0]));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] results) {
        super.onRequestPermissionsResult(requestCode, permissions, results);
        if (requestCode == MEDIA_PERMISSION && mediaRequest != null) {
            PermissionRequest request = mediaRequest;
            mediaRequest = null;
            grantMedia(request);
        }
    }

    private void handleCaptureMessage(String data, JavaScriptReplyProxy reply) {
        if (data == null || data.length() > 250) return;
        try {
            JSONObject event = new JSONObject(data);
            String id = event.optString("id");
            if (!id.matches("[a-f0-9]{32}")) return;
            switch (event.optString("action")) {
                case "start":
                    if (captureId != null || pickerOpen) {
                        send(reply, "ended", id, null);
                        return;
                    }
                    captureId = id;
                    captureReply = reply;
                    MediaProjectionManager manager = getSystemService(MediaProjectionManager.class);
                    pickerOpen = true;
                    try {
                        startActivityForResult(manager.createScreenCaptureIntent(), CAPTURE);
                    } catch (RuntimeException error) {
                        pickerOpen = false;
                        onCaptureEnded(id);
                    }
                    break;
                case "next":
                    if (id.equals(captureId)) ScreenShareService.requestFrame(id);
                    break;
                case "stop":
                    if (id.equals(captureId)) stopCapture();
                    break;
                default:
                    break;
            }
        } catch (JSONException ignored) {
            // Ignore malformed messages from the page.
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == CHOOSE_FILE && fileResult != null) {
            ValueCallback<Uri[]> result = fileResult;
            fileResult = null;
            result.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
        }
        if (requestCode != CAPTURE) return;
        pickerOpen = false;
        if (captureId == null) return;
        if (resultCode != RESULT_OK || data == null) {
            onCaptureEnded(captureId);
            return;
        }
        Intent start = new Intent(this, ScreenShareService.class);
        start.putExtra("capture", captureId);
        start.putExtra("permission", data);
        try {
            startForegroundService(start);
        } catch (RuntimeException error) {
            onCaptureEnded(captureId);
        }
    }

    @Override
    public void onFrame(String id, String jpeg) {
        if (!id.equals(captureId)) return;
        if (!projectionRunning) {
            projectionRunning = true;
            updatePip();
        }
        send(captureReply, "frame", id, jpeg);
    }

    @Override
    public void onCaptureEnded(String id) {
        if (!id.equals(captureId)) return;
        JavaScriptReplyProxy reply = captureReply;
        clearCapture();
        send(reply, "ended", id, null);
    }

    private static void send(JavaScriptReplyProxy reply, String kind, String id, String jpeg) {
        try {
            JSONObject message = new JSONObject();
            message.put("kind", kind);
            message.put("id", id);
            if (jpeg != null) message.put("jpeg", jpeg);
            reply.postMessage(message.toString());
        } catch (JSONException | IllegalStateException ignored) {
            // The page may have been closed while a frame was pending.
        }
    }

    private void stopCapture() {
        if (captureId == null) return;
        clearCapture();
        stopService(new Intent(this, ScreenShareService.class));
    }

    private void clearCapture() {
        captureId = null;
        captureReply = null;
        projectionRunning = false;
        updatePip();
    }

    private boolean pipSupported() {
        return getPackageManager().hasSystemFeature(PackageManager.FEATURE_PICTURE_IN_PICTURE);
    }

    private void updatePip() {
        if (Build.VERSION.SDK_INT >= 31 && pipSupported()) {
            setPictureInPictureParams(new PictureInPictureParams.Builder()
                .setAspectRatio(new Rational(16, 9)).setAutoEnterEnabled(projectionRunning).build());
        }
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (Build.VERSION.SDK_INT < 31 && projectionRunning && pipSupported()) {
            enterPictureInPictureMode(new PictureInPictureParams.Builder()
                .setAspectRatio(new Rational(16, 9)).build());
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean inPip, Configuration configuration) {
        super.onPictureInPictureModeChanged(inPip, configuration);
        pipLabel.setVisibility(inPip ? View.VISIBLE : View.GONE);
    }

    @Override
    protected void onStop() {
        super.onStop();
        if (projectionRunning && !isInPictureInPictureMode()) {
            String id = captureId;
            JavaScriptReplyProxy reply = captureReply;
            stopCapture();
            send(reply, "ended", id, null);
        }
    }

    @Override
    protected void onDestroy() {
        stopCapture();
        ScreenShareService.clearListener(this);
        browser.destroy();
        super.onDestroy();
    }
}
