package sh.paseo.keyboard

import android.app.Activity
import android.content.Context
import android.view.KeyEvent
import android.widget.EditText
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityHandler

class PaseoHardwareKeyboardPackage : Package {
  override fun createReactActivityHandlers(activityContext: Context): List<ReactActivityHandler> =
    listOf(PaseoHardwareKeyboardActivityHandler(activityContext))
}

private class PaseoHardwareKeyboardActivityHandler(
  private val activityContext: Context,
) : ReactActivityHandler {
  override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean {
    if (keyCode != KeyEvent.KEYCODE_ENTER || event == null || event.action != KeyEvent.ACTION_DOWN) {
      return false
    }
    if (event.device?.isVirtual == true || !PaseoHardwareKeyboardState.enabled) {
      return false
    }

    val activity = activityContext as? Activity ?: return false
    if (activity.currentFocus !is EditText) return false

    val shouldSubmit = event.isShiftPressed == PaseoHardwareKeyboardState.sendOnShiftEnter
    if (!shouldSubmit) return false

    if (event.repeatCount == 0) {
      PaseoHardwareKeyboardState.module?.emitHardwareKeyboardSubmit(event.isShiftPressed)
    }
    return true
  }
}
