package com.drivesense.app;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import android.content.Context;
import android.view.View;
import android.widget.FrameLayout;

import androidx.test.core.app.ApplicationProvider;

import org.junit.Test;
import org.junit.runner.RunWith;
import org.robolectric.RobolectricTestRunner;
import org.robolectric.Shadows;
import org.robolectric.annotation.Config;

import java.util.concurrent.atomic.AtomicBoolean;

@RunWith(RobolectricTestRunner.class)
@Config(sdk = 35)
public class DriveSenseWebViewRendererRecoveryTest {
    @Test
    public void detachDestroyAndRecreateAreHandledInOrder() {
        Context context = ApplicationProvider.getApplicationContext();
        FrameLayout parent = new FrameLayout(context);
        View rendererView = new View(context);
        parent.addView(rendererView);
        AtomicBoolean destroyed = new AtomicBoolean(false);
        AtomicBoolean recreated = new AtomicBoolean(false);

        assertTrue(DriveSenseWebViewRendererRecovery.handle(
            rendererView,
            () -> destroyed.set(true),
            () -> recreated.set(true)
        ));

        assertNull(rendererView.getParent());
        assertTrue(destroyed.get());
        assertFalse(recreated.get());
        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        assertTrue(recreated.get());
    }

    @Test
    public void alreadyGoneRendererCleanupFailureStillSchedulesRecovery() {
        Context context = ApplicationProvider.getApplicationContext();
        AtomicBoolean recreated = new AtomicBoolean(false);

        assertTrue(DriveSenseWebViewRendererRecovery.handle(
            new View(context),
            () -> { throw new IllegalStateException("renderer already gone"); },
            () -> recreated.set(true)
        ));

        Shadows.shadowOf(android.os.Looper.getMainLooper()).idle();
        assertTrue(recreated.get());
    }

    @Test
    public void missingRendererFailsClosed() {
        assertFalse(DriveSenseWebViewRendererRecovery.handle(null, () -> {}, () -> {}));
    }

    @Test
    public void normalActivityTeardownDisposesTheOldAssociatedRenderer() {
        Context context = ApplicationProvider.getApplicationContext();
        FrameLayout parent = new FrameLayout(context);
        View rendererView = new View(context);
        parent.addView(rendererView);
        AtomicBoolean destroyed = new AtomicBoolean(false);

        DriveSenseWebViewRendererRecovery.dispose(rendererView, () -> destroyed.set(true));

        assertNull(rendererView.getParent());
        assertTrue(destroyed.get());
    }
}
