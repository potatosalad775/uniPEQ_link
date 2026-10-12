package kr.potatosalad775.unipeq;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

/**
 * Phase 0 link probe, debug builds only: a foreground service that does nothing but exist, to
 * measure whether it keeps the WebView's JavaScript running while uniPEQ is in the background.
 * Started and stopped by peq_link_server's scripts/android-link-probe.mjs (--fgs / --stop-fgs).
 */
public class LinkProbeService extends Service {

    private static final String CHANNEL_ID = "link-probe";
    private static final int NOTIFICATION_ID = 7301;

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String origin = intent != null ? intent.getStringExtra("origin") : null;

        Notification.Builder builder;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationManager manager = getSystemService(NotificationManager.class);
            manager.createNotificationChannel(
                new NotificationChannel(CHANNEL_ID, "Link", NotificationManager.IMPORTANCE_LOW)
            );
            builder = new Notification.Builder(this, CHANNEL_ID);
        } else {
            builder = new Notification.Builder(this);
        }
        Intent open = new Intent(this, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        Notification notification = builder
            // A system icon: an adaptive launcher icon as the small icon crashes on Android 8.0.
            .setSmallIcon(android.R.drawable.stat_notify_sync)
            .setContentTitle("Linked with modernGraphTool")
            .setContentText(origin != null ? "Listening from " + origin : "Link probe running")
            .setContentIntent(PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE))
            .setOngoing(true)
            .build();

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            startForeground(NOTIFICATION_ID, notification, ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }
        LinkProbeVisibility.setKeepVisible(intent != null && intent.getBooleanExtra("keepVisible", false));
        return START_NOT_STICKY;
    }

    @Override
    public void onDestroy() {
        LinkProbeVisibility.setKeepVisible(false);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
