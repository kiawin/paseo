package sh.paseo.keyboard

import android.content.res.Configuration
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

internal object PaseoHardwareKeyboardState {
  var module: PaseoHardwareKeyboardModule? = null
  var enabled = false
  var requireShift = false
  var requireMod = false
}

class PaseoHardwareKeyboardModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PaseoHardwareKeyboard")

    Events("onHardwareKeyboardSubmit")

    OnCreate {
      PaseoHardwareKeyboardState.module = this@PaseoHardwareKeyboardModule
    }

    Function("setHardwareKeyboardSubmitEnabled") {
      enabled: Boolean,
      requireShift: Boolean,
      requireMod: Boolean ->
      PaseoHardwareKeyboardState.enabled = enabled
      PaseoHardwareKeyboardState.requireShift = requireShift
      PaseoHardwareKeyboardState.requireMod = requireMod
    }

    Function("hasHardwareKeyboard") {
      val configuration = appContext.reactContext?.resources?.configuration
      configuration?.keyboard == Configuration.KEYBOARD_QWERTY ||
        configuration?.keyboard == Configuration.KEYBOARD_12KEY
    }

    OnDestroy {
      if (PaseoHardwareKeyboardState.module === this@PaseoHardwareKeyboardModule) {
        PaseoHardwareKeyboardState.module = null
      }
      PaseoHardwareKeyboardState.enabled = false
    }
  }

  fun emitHardwareKeyboardSubmit(shiftKey: Boolean, modKey: Boolean) {
    sendEvent("onHardwareKeyboardSubmit", mapOf("shiftKey" to shiftKey, "modKey" to modKey))
  }
}
