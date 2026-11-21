package ir.benzin2.app;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import com.getcapacitor.BridgeActivity;

/**
 * G-16 — the Android entry point.
 *
 * Capacitor's {@link BridgeActivity} does the WebView wiring. Two things have to happen here
 * rather than in JavaScript:
 *
 *  - the notification channel must exist *before* the first FCM message arrives, otherwise
 *    Android 8+ drops the notification silently (the manifest names the same channel id);
 *  - the status bar has to match the dark surface from UX-SPEC.md, so the app does not start
 *    with a light bar over a dark screen.
 */
public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        createTradeChannel();
        getWindow().setStatusBarColor(Color.parseColor("#0B0F14"));
        getWindow().setNavigationBarColor(Color.parseColor("#0B0F14"));
    }

    private void createTradeChannel() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager == null) {
            return;
        }
        NotificationChannel channel = new NotificationChannel(
            getString(R.string.default_notification_channel_id),
            getString(R.string.default_notification_channel_name),
            NotificationManager.IMPORTANCE_HIGH
        );
        channel.setDescription(getString(R.string.default_notification_channel_name));
        channel.enableVibration(true);
        manager.createNotificationChannel(channel);
    }
}
