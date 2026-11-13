# Browser recording

In the desktop browser, select **Record browser** to start and **Stop recording** to stop. The toolbar shows when capture is active. Select **Include tab audio** before starting to include audio. Audio is off by default.

A recording covers the selected tab and the tabs and popups it opens. It continues through page refreshes and captures available frame traffic and trusted manual interactions. Stopping from any included tab stops the whole recording. Closing a descendant tab does not stop its parent recording.

Open **Recordings** from the Explorer sidebar's + menu to inspect saved recordings. Select an event for request and response details. The timeline marks capture gaps and incomplete bodies. Choose a tab or popup view to play its video. Playback follows a shared timeline, but frame and event alignment is approximate. Video is available after recording stops.

## Capture limits

The recorder stores available URLs, headers, request and response bodies, interactions and video. It may contain cookies, access tokens and private data. Large bodies, streams, late debugger attachment, unavailable browser data, storage limits and other failures can leave gaps. The recording reports these limits; it does not promise every byte. Service-worker target traffic is not verified. Early extra network headers may be rejected when they cannot be attributed safely.

Clicks must come from a trusted browser event. Scripted clicks are excluded. Paseo cannot reliably distinguish a person from browser automation that produces trusted input, so their origin is marked unknown. A debugger detach or a click from a replaced document is recorded as a gap. After a debugger detach, Paseo attempts to resume capture and records a recovery marker. If recovery fails, the recording is marked interrupted.

## Audio

Paseo records audio from each captured tab or popup frame. It does not request system-wide loopback audio. Audio and video share one media stream for each view.

If audio is denied or unavailable, video continues. The recording control, event timeline and saved recording show the audio status. A missing interval remains marked even if a later view captures audio. You can mute audio during playback. The `combined` media label means the container has an audio track; it does not prove sound was captured throughout the segment.

| Platform | Evidence                                                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux    | Electron 44.2.0 under Xvfb captured and decoded separate synthetic root and production-popup tones. Disabled and unavailable audio produced no audio track. |
| macOS    | Unverified.                                                                                                                                                 |
| Windows  | Unverified.                                                                                                                                                 |

Operating system permissions and audio-track behavior must be verified on each platform. A track can exist while the page is silent.

## Storage and sharing

Recordings live in the desktop app's `userData/browser-recordings` directory until you delete them. An active recording recovered after a crash or interrupted shutdown is marked **Interrupted**. The desktop store has a 4 GiB logical quota; it reports a limit or disk error rather than evicting a recording.

Select **Share with agent**, choose the destination agent and host, and confirm the warning before a copy is sent. The copy contains captured events, metadata and media, and reports known capture gaps. Paseo adds a manifest reference to the chosen agent's draft; review and send the draft yourself. Sharing supports up to 1 GiB per recording, 1,024 parts and 16 MiB per part. The file index is limited to 16 MiB and 100,000 media files. It reports a limit or transfer failure instead of truncating the copy.

Each completed or uncertain transfer has a local history entry. **Remove shared copy** removes the destination copy first. If the destination is unavailable, **Forget shared copy** removes the local history only after a warning; the remote copy can remain accessible. Remove or explicitly forget all copies before deleting the original recording. If the local share history is damaged, the separate confirmed recovery action preserves the damaged bytes until the recording is deleted and warns that remote copies can remain.

A destination daemon requires workspace-write authority and validates the selected live agent. Permissions are daemon-wide and do not isolate processes that run as the same operating-system user; see [Daemon permissions](permissions.md#resources). On Unix, recording directories and files use restrictive modes. Windows ACL behavior, symlink protection and directory-sync durability are unverified. A process running as the same operating-system user can race changes to intermediate directories; the recording boundary does not claim isolation from that process.

The destination preserves incomplete shares whose owner is in an unknown or different process namespace. This can block new shares when the retained-share quota is reached. An administrator must verify that no daemon still uses the share before clearing the matching orphan directory and `.active-*` marker under the destination's `$PASEO_HOME/recording-shares`. Do not remove an entry while its owner may still be active. The retained-share quota is coordinated within each daemon process; simultaneous daemons using the same storage can exceed the nominal 4 GiB aggregate quota.

## Agent recording

Agents record QA evidence with `browser_record_start` and `browser_record_stop`, or `paseo browser record start|stop`. Both run as browser automation commands that the app's renderer handles, because only the renderer may start a recording (`packages/app/src/desktop/browser/automation/recording-commands.ts`). Stopping copies the recording to the caller agent through the same share pipeline as **Share with agent** and records the same history entry. It skips the confirmation: enabling browser tools on the daemon is the consent, and the broker refuses every command once they are turned off.

The stop returns once the destination daemon accepts the copy, before the upload, because an upload of up to 1 GiB outlasts an MCP tool call. The begin request carries `notifyRecipient`, and the destination daemon prompts the agent once the copy settles: with the manifest path on completion, or with a failure when the copy is deleted or the uploading app disconnects (`packages/server/src/server/recording-share/notice.ts`). The prompt waits for the agent's turn to end. A person's share leaves `notifyRecipient` unset and gets no prompt. A failure before the copy starts returns from the stop as an error.

An agent can stop and receive only a recording it started. The desktop main process keeps the starting agent on the active recording, so an agent can still stop it after a window reload. A recording the person started from the toolbar and another agent's recording are refused; the person stops those from the toolbar. An app restart marks running recordings interrupted, and the person shares those from **Recordings**.

The app advertises `record_start` and `record_stop` only to daemons that report `features.browserRecording`. Older daemons reject a host registration that lists a command they do not know, which would turn off every browser tool on that connection.

See [Browser Capture Harness](browser-capture-harness.md) for the Electron verification path and its limits.

## Verification

The following checks used Electron 44.2.0 on Linux under Xvfb and synthetic data. The desktop UI was driven with Playwright and its screenshots were inspected. The local test scripts and screenshots are not kept in the repository. macOS and Windows remain unverified.

| Journey              | Linux result                                                                                                                                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Toolbar and events   | Record and Stop worked; a guest click and request appeared in the saved timeline.                                                                                                                                   |
| Sidebar              | The scripted desktop check covered the Recordings list and detail, minimal tab scrolling, manual scroll through resize, and reveal on reselection.                                                                  |
| Sharing              | An explicit action showed the recipient, secret warning and capture gaps. The copied parts matched their manifest and the agent draft received its path. The native confirmation response was stubbed.              |
| Playback             | A saved video played across a refresh boundary. A combined audio/video segment played with a decoded synthetic tone. Frame-accurate synchronization and real audio-to-video generation switching were not measured. |
| Crash recovery       | Killing and reopening an isolated desktop preserved completed recordings and marked the active one interrupted. This did not test a packaged app, graceful quit or power-loss durability.                           |
| Automation and trust | The Electron harness checked concurrent browser automation, opening DevTools, a forced-detach gap and a request captured after recovery. A renderer test checks that captured markup displays as inert text.        |

The recording harness uses production capture modules but does not launch the full desktop UI. Its cases and commands are in [Browser Capture Harness](browser-capture-harness.md).
