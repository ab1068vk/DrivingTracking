package com.roadsage.app.uitest.base

import androidx.test.uiautomator.BySelector
import androidx.test.uiautomator.UiDevice
import androidx.test.uiautomator.UiObject2
import androidx.test.uiautomator.Until

object WaitHelpers {
    fun findWithTimeout(
        device: UiDevice,
        selector: BySelector,
        timeoutMs: Long = 5_000L
    ): UiObject2? = device.wait(Until.findObject(selector), timeoutMs)

    fun waitForGone(
        device: UiDevice,
        selector: BySelector,
        timeoutMs: Long = 5_000L
    ): Boolean = device.wait(Until.gone(selector), timeoutMs) ?: false

    fun retryUntilTrue(
        attempts: Int = 10,
        intervalMs: Long = 500,
        block: () -> Boolean
    ): Boolean {
        repeat(attempts) {
            if (block()) return true
            Thread.sleep(intervalMs)
        }
        return false
    }
}
