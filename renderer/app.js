import {
  decryptSignal,
  delay,
  deriveSecrets,
  encryptSignal,
  sha256Base64Url,
  waitForIceGathering,
} from "./crypto.js";

const ui = {
  stateLabel: document.querySelector("#state-label"),
  headingTitle: document.querySelector("#heading-title"),
  headingCopy: document.querySelector("#heading-copy"),
  keyCard: document.querySelector("#key-card"),
  accessKey: document.querySelector("#access-key"),
  copyKey: document.querySelector("#copy-key"),
  copyLabel: document.querySelector("#copy-label"),
  sessionCard: document.querySelector("#session-card"),
  notice: document.querySelector("#notice"),
  noticeText: document.querySelector("#notice-text"),
  activate: document.querySelector("#activate"),
  deactivate: document.querySelector("#deactivate"),
  activeActions: document.querySelector("#active-actions"),
  rotateKey: document.querySelector("#rotate-key"),
  endSession: document.querySelector("#end-session"),
  minimize: document.querySelector("#minimize-window"),
  hide: document.querySelector("#hide-window"),
};

let hostState = null;
let secrets = null;
let serviceGeneration = 0;
let heartbeatTimer = null;
let activeConnection = null;
let activeStream = null;
let activeSessionId = null;
let sessionConnected = false;
let working = false;

function setNotice(message, isError = false) {
  ui.noticeText.textContent = message;
  ui.notice.classList.toggle("is-error", isError);
}

function render() {
  const active = Boolean(hostState?.active);
  document.body.classList.toggle("is-active", active);
  document.body.classList.toggle(
    "has-session",
    Boolean(activeConnection),
  );

  ui.keyCard.classList.toggle("is-hidden", !active);
  ui.sessionCard.classList.toggle(
    "is-hidden",
    !activeConnection,
  );
  ui.activate.classList.toggle("is-hidden", active);
  ui.deactivate.classList.toggle("is-hidden", !active);
  ui.activeActions.classList.toggle("is-hidden", !active);

  if (active) {
    ui.accessKey.textContent = hostState.key;
    ui.stateLabel.lastChild.textContent = activeConnection
      ? " Browser session active"
      : " Remote access is active";
    ui.headingTitle.textContent = activeConnection
      ? "Your screen is being shared."
      : "This PC is ready.";
    ui.headingCopy.textContent = activeConnection
      ? "The session is direct and encrypted. Disconnect it here at any time."
      : "Leave Syndesk running in the tray, then use the key from any browser.";
  } else {
    ui.stateLabel.lastChild.textContent =
      " Remote access is off";
    ui.headingTitle.textContent =
      "Make this PC reachable.";
    ui.headingCopy.textContent =
      "Activate Syndesk once, then connect securely from your browser wherever you are.";
  }
}

async function signalRequest(action, payload = {}) {
  if (!hostState || !secrets) {
    throw new Error("Syndesk is not activated.");
  }
  const response = await fetch(
    hostState.portalOrigin + "/api/signal",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + secrets.token,
      },
      body: JSON.stringify({
        action,
        locator: secrets.locator,
        ...payload,
      }),
    },
  );
  const result = await response.json();
  if (!response.ok) {
    throw new Error(
      result.error ||
        "The Syndesk service did not accept the request.",
    );
  }
  return result;
}

async function registerHost() {
  const tokenHash = await sha256Base64Url(secrets.token);
  return signalRequest("register", {
    tokenHash,
    deviceName: hostState.deviceName,
    platform: "windows",
    hostVersion: hostState.version,
  });
}

async function startService() {
  serviceGeneration += 1;
  const generation = serviceGeneration;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  stopSession(false);

  if (!hostState?.active || !hostState.key) {
    secrets = null;
    render();
    return;
  }

  try {
    setNotice("Registering this PC securely…");
    secrets = await deriveSecrets(hostState.key);
    await registerHost();
    if (generation !== serviceGeneration) return;
    setNotice(
      hostState.inputReady
        ? "Online. Your PC is waiting for an encrypted browser connection."
        : "Online for viewing. Rebuild the input helper to enable mouse and keyboard control.",
      !hostState.inputReady,
    );

    heartbeatTimer = setInterval(() => {
      if (
        generation === serviceGeneration &&
        hostState?.active
      ) {
        void signalRequest("heartbeat").catch(() => {
          setNotice(
            "The connection service is temporarily unreachable. Syndesk is retrying.",
            true,
          );
        });
      }
    }, 5000);
    void pollForSessions(generation);
  } catch (error) {
    setNotice(
      error instanceof Error
        ? error.message
        : "Syndesk could not activate this PC.",
      true,
    );
  }
}

async function pollForSessions(generation) {
  while (
    generation === serviceGeneration &&
    hostState?.active
  ) {
    if (activeConnection) {
      await delay(750);
      continue;
    }
    try {
      const result = await signalRequest("poll-host");
      if (
        result.session &&
        generation === serviceGeneration
      ) {
        await acceptSession(result.session, generation);
      } else {
        await delay(850);
      }
    } catch {
      setNotice(
        "Syndesk lost contact with the service. Retrying automatically…",
        true,
      );
      await delay(2500);
    }
  }
}

async function captureScreen() {
  const source = await window.syndesk.getDisplaySource();
  const video = {
    mandatory: {
      chromeMediaSource: "desktop",
      chromeMediaSourceId: source.id,
      minWidth: 1280,
      maxWidth: 1920,
      minHeight: 720,
      maxHeight: 1080,
      minFrameRate: 30,
      maxFrameRate: 60,
    },
  };
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: "desktop",
          chromeMediaSourceId: source.id,
        },
      },
      video,
    });
  } catch {
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video,
    });
  }
}

function preferHardwareFriendlyCodec(connection) {
  const capabilities =
    globalThis.RTCRtpSender?.getCapabilities?.("video");
  if (!capabilities?.codecs) return;
  const codecs = [...capabilities.codecs].sort(
    (left, right) => {
      const rank = (codec) => {
        const mime = codec.mimeType.toLowerCase();
        if (mime === "video/h264") return 0;
        if (mime === "video/vp9") return 1;
        if (mime === "video/av1") return 2;
        if (mime === "video/vp8") return 3;
        return 4;
      };
      return rank(left) - rank(right);
    },
  );
  for (const transceiver of connection.getTransceivers()) {
    if (
      transceiver.receiver.track.kind === "video" &&
      transceiver.setCodecPreferences
    ) {
      transceiver.setCodecPreferences(codecs);
    }
  }
}

function bindControlChannel(channel) {
  channel.addEventListener("message", (event) => {
    if (
      typeof event.data !== "string" ||
      event.data.length > 4096
    ) {
      return;
    }
    try {
      const message = JSON.parse(event.data);
      if (
        message &&
        (message.t === "pointer" ||
          message.t === "key" ||
          message.t === "release-all")
      ) {
        void window.syndesk.injectInput(message);
      }
    } catch {
      // Malformed control packets are ignored.
    }
  });
  channel.addEventListener("close", () => {
    void window.syndesk.injectInput({
      t: "release-all",
    });
  });
}

async function tuneVideoSender(sender) {
  try {
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) {
      parameters.encodings = [{}];
    }
    parameters.encodings[0].maxBitrate = 15_000_000;
    parameters.encodings[0].maxFramerate = 60;
    parameters.degradationPreference =
      "maintain-resolution";
    await sender.setParameters(parameters);
  } catch {
    // Chromium will retain its adaptive defaults.
  }
}

async function acceptSession(session, generation) {
  activeSessionId = session.id;
  sessionConnected = false;
  render();
  setNotice(
    "A verified browser is requesting the screen. Starting the encrypted stream…",
  );

  try {
    const configResponse = await fetch(
      hostState.portalOrigin + "/api/config",
    );
    if (!configResponse.ok) {
      throw new Error(
        "Could not load network routing configuration.",
      );
    }
    const config = await configResponse.json();
    const connection = new RTCPeerConnection({
      iceServers: config.iceServers,
      bundlePolicy: "max-bundle",
    });
    activeConnection = connection;
    render();

    connection.addEventListener(
      "datachannel",
      (event) => bindControlChannel(event.channel),
    );
    connection.addEventListener(
      "connectionstatechange",
      () => {
        if (connection !== activeConnection) return;
        if (connection.connectionState === "connected") {
          sessionConnected = true;
          render();
          setNotice(
            hostState.inputReady
              ? "A browser is controlling this PC. You can disconnect it at any time."
              : "A browser is viewing this PC. Input control is unavailable.",
            false,
          );
        }
        if (connection.connectionState === "failed") {
          stopSession();
          setNotice(
            "The remote connection failed. Syndesk is ready for another attempt.",
            true,
          );
        }
        if (connection.connectionState === "disconnected") {
          setTimeout(() => {
            if (
              connection === activeConnection &&
              connection.connectionState === "disconnected"
            ) {
              stopSession();
              setNotice(
                "The browser disconnected. This PC is ready again.",
              );
            }
          }, 8000);
        }
        if (connection.connectionState === "closed") {
          stopSession(false);
        }
      },
    );

    const offer = await decryptSignal(
      secrets.signalKey,
      secrets.locator,
      session.offerCipher,
    );
    await connection.setRemoteDescription(offer);
    if (generation !== serviceGeneration) {
      throw new Error("Remote access was disabled.");
    }

    activeStream = await captureScreen();
    for (const track of activeStream.getVideoTracks()) {
      track.contentHint = "motion";
      const sender = connection.addTrack(
        track,
        activeStream,
      );
      await tuneVideoSender(sender);
    }
    for (const track of activeStream.getAudioTracks()) {
      connection.addTrack(track, activeStream);
    }
    preferHardwareFriendlyCodec(connection);

    const answer = await connection.createAnswer();
    await connection.setLocalDescription(answer);
    await waitForIceGathering(connection);
    if (!connection.localDescription) {
      throw new Error(
        "Syndesk could not create a connection answer.",
      );
    }
    const answerCipher = await encryptSignal(
      secrets.signalKey,
      secrets.locator,
      connection.localDescription,
    );
    await signalRequest("answer", {
      sessionId: session.id,
      answerCipher,
    });
    setNotice(
      "Encrypted route created. Waiting for the browser to finish connecting…",
    );
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "The remote session could not start.";
    if (activeSessionId) {
      void signalRequest("fail", {
        sessionId: activeSessionId,
        error: message,
      }).catch(() => undefined);
    }
    stopSession(false);
    setNotice(message, true);
  }
}

function stopSession(releaseInput = true) {
  if (releaseInput) {
    void window.syndesk.injectInput({
      t: "release-all",
    });
  }
  if (activeStream) {
    for (const track of activeStream.getTracks()) {
      track.stop();
    }
  }
  if (activeConnection) {
    const connection = activeConnection;
    activeConnection = null;
    connection.close();
  }
  activeStream = null;
  activeSessionId = null;
  sessionConnected = false;
  render();
}

async function deactivateRemoteAccess() {
  serviceGeneration += 1;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (secrets && hostState?.active) {
    await signalRequest("deactivate").catch(
      () => undefined,
    );
  }
  stopSession();
  hostState = await window.syndesk.deactivate();
  secrets = null;
  setNotice(
    "Your screen stays private until remote access is activated.",
  );
  render();
}

ui.activate.addEventListener("click", async () => {
  if (working) return;
  working = true;
  ui.activate.disabled = true;
  ui.activate.innerHTML =
    '<span class="spinner"></span>Activating';
  try {
    hostState = await window.syndesk.activate({
      rotate: false,
    });
    render();
    await startService();
  } catch (error) {
    setNotice(
      error instanceof Error
        ? error.message
        : "Syndesk could not activate.",
      true,
    );
  } finally {
    working = false;
    ui.activate.disabled = false;
    ui.activate.innerHTML =
      '<span class="power-icon"></span>Activate Syndesk';
  }
});

ui.deactivate.addEventListener("click", () => {
  void deactivateRemoteAccess();
});

ui.copyKey.addEventListener("click", async () => {
  if (!hostState?.key) return;
  await window.syndesk.copyText(hostState.key);
  ui.copyLabel.textContent = "Copied";
  setTimeout(() => {
    ui.copyLabel.textContent = "Copy";
  }, 1400);
});

ui.rotateKey.addEventListener("click", async () => {
  if (
    !confirm(
      "Generate a new Syndesk key? The current key will stop working.",
    )
  ) {
    return;
  }
  serviceGeneration += 1;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  if (secrets) {
    await signalRequest("deactivate").catch(
      () => undefined,
    );
  }
  stopSession();
  hostState = await window.syndesk.activate({
    rotate: true,
  });
  render();
  await startService();
});

ui.endSession.addEventListener("click", () => {
  const sessionId = activeSessionId;
  if (sessionId && secrets) {
    void signalRequest("fail", {
      sessionId,
      error: "The host ended the session.",
    }).catch(() => undefined);
  }
  stopSession();
  setNotice(
    "The browser was disconnected. This PC is ready again.",
  );
});

ui.minimize.addEventListener("click", () => {
  void window.syndesk.windowAction("minimize");
});

ui.hide.addEventListener("click", () => {
  void window.syndesk.windowAction("hide");
});

window.syndesk.onDisabled(() => {
  void deactivateRemoteAccess();
});

window.syndesk.onInputStatus((ready) => {
  if (!hostState) return;
  hostState.inputReady = ready;
  render();
});

async function initialize() {
  try {
    hostState = await window.syndesk.getState();
    render();
    if (hostState.active && hostState.key) {
      await startService();
    } else {
      setNotice(
        "Your screen stays private until remote access is activated.",
      );
    }
  } catch (error) {
    setNotice(
      error instanceof Error
        ? error.message
        : "Syndesk could not load its secure settings.",
      true,
    );
  }
}

void initialize();
