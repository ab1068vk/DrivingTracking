package com.roadsage.app;

import android.content.ClipData;
import android.content.ClipDescription;
import android.content.ClipboardManager;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.os.PersistableBundle;

import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "SecureClipboard")
public class ClipboardPlugin extends Plugin {
    private static final long AUTO_CLEAR_DELAY_MS = 60_000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private Runnable pendingClear;

    @PluginMethod
    public void copyWithAutoClear(PluginCall call) {
        String text = call.getString("text", "");
        String label = call.getString("label", "Road Sage");

        ClipboardManager clipboard = (ClipboardManager) getContext().getSystemService(Context.CLIPBOARD_SERVICE);
        if (clipboard == null) {
            call.reject("Clipboard unavailable");
            return;
        }

        ClipData clip = ClipData.newPlainText(label, text);
        markClipSensitive(clip);
        clipboard.setPrimaryClip(clip);

        if (pendingClear != null) {
            handler.removeCallbacks(pendingClear);
        }

        pendingClear = () -> {
            ClipData current = clipboard.getPrimaryClip();
            CharSequence currentText = null;
            if (current != null && current.getItemCount() > 0) {
                currentText = current.getItemAt(0).getText();
            }

            if (text.contentEquals(currentText == null ? "" : currentText)) {
                clearClipboard(clipboard);
            }
            pendingClear = null;
        };
        handler.postDelayed(pendingClear, AUTO_CLEAR_DELAY_MS);

        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        if (pendingClear != null) {
            handler.removeCallbacks(pendingClear);
            pendingClear = null;
        }
        super.handleOnDestroy();
    }

    private static void clearClipboard(ClipboardManager clipboard) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            clipboard.clearPrimaryClip();
            return;
        }
        clipboard.setPrimaryClip(ClipData.newPlainText("", ""));
    }

    private static void markClipSensitive(ClipData clip) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.N) return;

        PersistableBundle extras = new PersistableBundle();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            extras.putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true);
        } else {
            extras.putBoolean("android.content.extra.IS_SENSITIVE", true);
        }
        clip.getDescription().setExtras(extras);
    }
}
