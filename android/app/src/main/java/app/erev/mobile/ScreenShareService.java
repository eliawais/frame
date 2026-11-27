package app.erev.mobile;

import android.app.Activity;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.graphics.Bitmap;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.display.VirtualDisplay;
import android.media.Image;
import android.media.ImageReader;
import android.media.projection.MediaProjection;
import android.media.projection.MediaProjectionManager;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.IBinder;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Base64;

import java.io.ByteArrayOutputStream;
import java.lang.ref.WeakReference;
import java.nio.ByteBuffer;
import java.util.concurrent.atomic.AtomicBoolean;

public final class ScreenShareService extends Service {
    interface Listener {
        void onFrame(String id, String jpeg);
        void onCaptureEnded(String id);
    }

    private static final String ACTION_STOP = "app.erev.mobile.STOP_SHARE";
    private static final String CHANNEL = "screen-share";
    private static final int NOTIFICATION = 210;
    private static WeakReference<Listener> listener = new WeakReference<>(null);
    private static ScreenShareService active;

    private final Handler main = new Handler(Looper.getMainLooper());
    private final AtomicBoolean frameRequested = new AtomicBoolean(true);
    private final ByteArrayOutputStream jpeg = new ByteArrayOutputStream();
    private HandlerThread thread;
    private Handler captureHandler;
    private MediaProjection projection;
    private VirtualDisplay display;
    private ImageReader reader;
    private Bitmap bitmap;
    private ByteBuffer pixels;
    private String captureId;
    private int density;
    private long lastFrameAt;
    private volatile boolean finishing;

    private final MediaProjection.Callback projectionCallback = new MediaProjection.Callback() {
        @Override
        public void onStop() {
            main.post(() -> stopSelf());
        }

        @Override
        public void onCapturedContentResize(int width, int height) {
            if (finishing || display == null) return;
            try {
                resizeCapture(width, height);
            } catch (RuntimeException error) {
                main.post(() -> stopSelf());
            }
        }
    };

    static void setListener(Listener observer) {
        listener = new WeakReference<>(observer);
    }

    static void clearListener(Listener observer) {
        if (listener.get() == observer) listener.clear();
    }

    static void requestFrame(String id) {
        if (active != null && id.equals(active.captureId)) active.frameRequested.set(true);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (captureId != null) return START_NOT_STICKY;

        captureId = intent.getStringExtra("capture");
        Intent permission = Build.VERSION.SDK_INT >= 33
            ? intent.getParcelableExtra("permission", Intent.class)
            : intent.getParcelableExtra("permission");
        if (captureId == null || permission == null) {
            stopSelf();
            return START_NOT_STICKY;
        }

        try {
            Notification notification = sharingNotification();
            if (Build.VERSION.SDK_INT >= 29) {
                startForeground(NOTIFICATION, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PROJECTION);
            } else {
                startForeground(NOTIFICATION, notification);
            }
            active = this;
            thread = new HandlerThread("ErevScreenCapture");
            thread.start();
            captureHandler = new Handler(thread.getLooper());
            var metrics = getResources().getDisplayMetrics();
            density = metrics.densityDpi;
            int width = metrics.widthPixels;
            int height = metrics.heightPixels;
            if (Build.VERSION.SDK_INT >= 30) {
                var windowManager = getSystemService(android.view.WindowManager.class);
                var bounds = windowManager.getMaximumWindowMetrics().getBounds();
                width = bounds.width();
                height = bounds.height();
            }
            int sourceWidth = width;
            int sourceHeight = height;
            captureHandler.post(() -> startProjection(permission, sourceWidth, sourceHeight));
        } catch (RuntimeException error) {
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private Notification sharingNotification() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        manager.createNotificationChannel(new NotificationChannel(CHANNEL, "Screen sharing",
            NotificationManager.IMPORTANCE_LOW));
        PendingIntent open = PendingIntent.getActivity(this, 0, new Intent(this, MainActivity.class),
            PendingIntent.FLAG_IMMUTABLE);
        PendingIntent stop = PendingIntent.getService(this, 1,
            new Intent(this, ScreenShareService.class).setAction(ACTION_STOP), PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL)
            .setSmallIcon(R.drawable.erev)
            .setContentTitle("Erev is sharing your screen")
            .setContentText("Tap to return to your room.")
            .setContentIntent(open)
            .setOngoing(true)
            .addAction(new Notification.Action.Builder(null, "Stop sharing", stop).build())
            .build();
    }

    private void startProjection(Intent permission, int sourceWidth, int sourceHeight) {
        if (finishing) return;
        try {
            projection = getSystemService(MediaProjectionManager.class)
                .getMediaProjection(Activity.RESULT_OK, permission);
            projection.registerCallback(projectionCallback, captureHandler);
            resizeCapture(sourceWidth, sourceHeight);
        } catch (RuntimeException error) {
            main.post(() -> stopSelf());
        }
    }

    private void resizeCapture(int width, int height) {
        double scale = Math.min(1, 960.0 / Math.max(width, height));
        int scaledWidth = Math.max(2, (int) (width * scale));
        int scaledHeight = Math.max(2, (int) (height * scale));
        if (reader != null && reader.getWidth() == scaledWidth && reader.getHeight() == scaledHeight) return;

        ImageReader previous = reader;
        reader = ImageReader.newInstance(scaledWidth, scaledHeight, PixelFormat.RGBA_8888, 2);
        reader.setOnImageAvailableListener(this::onImageAvailable, captureHandler);
        if (display == null) {
            display = projection.createVirtualDisplay("Erev screen share", scaledWidth, scaledHeight, density,
                DisplayManager.VIRTUAL_DISPLAY_FLAG_AUTO_MIRROR, reader.getSurface(), null, captureHandler);
        } else {
            display.resize(scaledWidth, scaledHeight, density);
            display.setSurface(reader.getSurface());
        }
        if (previous != null) previous.close();

        if (bitmap != null) bitmap.recycle();
        bitmap = Bitmap.createBitmap(scaledWidth, scaledHeight, Bitmap.Config.ARGB_8888);
        pixels = ByteBuffer.allocate(scaledWidth * scaledHeight * 4);
    }

    private void onImageAvailable(ImageReader source) {
        if (finishing || source != reader) return;
        try (Image image = source.acquireLatestImage()) {
            long now = SystemClock.elapsedRealtime();
            if (image == null || now - lastFrameAt < 100 || !frameRequested.compareAndSet(true, false)) return;
            lastFrameAt = now;
            Image.Plane plane = image.getPlanes()[0];
            ByteBuffer input = plane.getBuffer();
            int lineBytes = image.getWidth() * plane.getPixelStride();
            pixels.clear();
            for (int line = 0; line < image.getHeight(); line++) {
                int start = line * plane.getRowStride();
                input.limit(input.capacity());
                input.position(start);
                input.limit(start + lineBytes);
                pixels.put(input);
            }
            pixels.flip();
            bitmap.copyPixelsFromBuffer(pixels);
            jpeg.reset();
            if (!bitmap.compress(Bitmap.CompressFormat.JPEG, 68, jpeg)) {
                frameRequested.set(true);
                return;
            }
            String encoded = Base64.encodeToString(jpeg.toByteArray(), Base64.NO_WRAP);
            main.post(() -> {
                Listener observer = listener.get();
                if (!finishing && observer != null) observer.onFrame(captureId, encoded);
            });
        } catch (RuntimeException error) {
            main.post(() -> stopSelf());
        }
    }

    @Override
    public void onDestroy() {
        finishing = true;
        if (active == this) active = null;
        if (captureHandler != null) {
            captureHandler.post(() -> {
                if (display != null) display.release();
                if (reader != null) reader.close();
                if (bitmap != null) bitmap.recycle();
                if (projection != null) {
                    projection.unregisterCallback(projectionCallback);
                    projection.stop();
                }
                thread.quitSafely();
            });
        }
        stopForeground(STOP_FOREGROUND_REMOVE);
        Listener observer = listener.get();
        if (observer != null && captureId != null) observer.onCaptureEnded(captureId);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
