import { ipcRenderer } from "electron";
const ignoreSendFailure = () => {};

// This preload belongs only to the private recorder window, never to a page.
function configure(
  _event: Electron.IpcRendererEvent,
  config: { channel: string; audio?: boolean },
) {
  let recorder: MediaRecorder | undefined;
  let stream: MediaStream | undefined;
  let tail = Promise.resolve();
  let queuedBytes = 0;
  let sequence = 0;
  let previous = 0;
  let stopping = false;
  const send = (message: Record<string, unknown>) => ipcRenderer.invoke(config.channel, message);
  const reportAudioEnded = () => {
    if (!stopping)
      tail = tail
        .then(async () => {
          await send({ type: "audio-status", status: "unavailable", reason: "ended" });
          return undefined;
        })
        .catch(ignoreSendFailure);
  };
  window.addEventListener(
    "paseo-video-start",
    () => {
      void (async () => {
        try {
          let reason: string | undefined;
          try {
            stream = await navigator.mediaDevices.getDisplayMedia({
              video: true,
              audio: config.audio === true,
            });
          } catch (error) {
            if (!config.audio) throw error;
            reason =
              error instanceof DOMException && error.name === "NotAllowedError"
                ? "denied"
                : "unsupported";
            stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
          }
          if (!config.audio) {
            for (const track of stream.getAudioTracks()) {
              stream.removeTrack(track);
              track.stop();
            }
          }
          const audioTrack = config.audio ? stream.getAudioTracks()[0] : undefined;
          if (config.audio) {
            const status = audioTrack ? "captured" : "unavailable";
            await send({
              type: "audio-status",
              status,
              ...(status === "unavailable" ? { reason: reason ?? "unsupported" } : {}),
            });
          }
          audioTrack?.addEventListener("ended", reportAudioEnded);
          recorder = new MediaRecorder(stream, { videoBitsPerSecond: 1_000_000 });
          const origin = performance.now();
          previous = 0;
          recorder.ondataavailable = (event) => {
            void send({ type: "heartbeat" }).catch(() => {});
            if (!event.data.size) return;
            const end = performance.now() - origin;
            const start = previous;
            previous = end;
            const blob = event.data;
            const index = sequence++;
            queuedBytes += blob.size;
            if (queuedBytes > 16 * 1024 * 1024) {
              void send({ type: "error", message: "video-backpressure" });
              recorder?.stop();
              return;
            }
            tail = tail
              .then(async () => {
                try {
                  const bytes = await blob.arrayBuffer();
                  await send({
                    type: "chunk",
                    bytes,
                    start,
                    end,
                    sequence: index,
                    mimeType: recorder?.mimeType,
                  });
                  return undefined;
                } finally {
                  queuedBytes -= blob.size;
                }
              })
              .catch(() => {
                if (recorder && recorder.state !== "inactive") recorder.stop();
              });
          };
          recorder.onstop = () => {
            void tail.then(
              () => send({ type: "stopped" }),
              (error: unknown) => send({ type: "error", message: String(error) }),
            );
            stream?.getTracks().forEach((track) => track.stop());
          };
          stream.getVideoTracks()[0]?.addEventListener("ended", () => {
            if (!stopping && recorder?.state !== "inactive") {
              void send({ type: "error", message: "video-track-ended" });
              recorder?.stop();
            }
          });
          recorder.start(500);
          await send({ type: "started" });
        } catch (error) {
          await send({ type: "error", message: String(error) });
        }
      })();
    },
    { once: true },
  );
  ipcRenderer.on("paseo-video-stop", () => {
    stopping = true;
    if (recorder && recorder.state !== "inactive") recorder.stop();
    else void send({ type: "stopped" });
  });
  void send({ type: "ready" });
}
ipcRenderer.on("paseo-video-config", configure);
