# Browser recording

## Audio

Audio is off when a recording starts unless you select it in the browser toolbar. Paseo records audio from each captured tab or popup frame. It does not request system-wide loopback audio. Audio and video share one media stream for each view.

If audio is denied or unavailable, video continues. The recording control shows the unavailable state. The event timeline and saved recording retain the audio status. A missing audio interval remains marked even if a later view captures audio. You can mute audio during playback.

The `combined` media label means that the container has an audio track. It does not prove that the track contains sound for the whole segment. Timed audio-status events mark capture loss and later recovery.

| Platform | Evidence                                                                                                                                   |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Linux    | Electron 44.2.0 captured and decoded synthetic tab and popup audio under Xvfb. The disabled and unavailable cases produced no audio track. |
| macOS    | Unverified.                                                                                                                                |
| Windows  | Unverified.                                                                                                                                |

The operating system can deny audio or return a stream without an audio track. Paseo reports both as unavailable. A track can exist while the page is silent. Track presence does not prove that sound was captured. Frame and platform permission behavior must be tested on each supported platform. See [browser-capture-harness.md](browser-capture-harness.md) for the Electron test harness.
