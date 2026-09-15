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
let activeVideoSender = null;
let activeProfileName = "high";
let activeStreamSettings = null;
let profileSwitch = Promise.resolve();

const STREAM_PROFILES = {
  "data-saver": {
    width: 960,
    height: 540,
    fps: 24,
    bitrate: 1_800_000,
    degradationPreference: "maintain-framerate",
  },
  balanced: {
    width: 1280,
    height: 720,
    fps: 30,
    bitrate: 4_500_000,
    degradationPreference: "balanced",
  },
  high: {
    width: 1920,
    height: 1080,
    fps: 60,
    bitrate: 10_000_000,
    degradationPreference: "maintain-framerate",
  },
  ultra: {
    width: 2560,
    height: 1440,
    fps: 60,
    bitrate: 18_000_000,
    degradationPreference: "maintain-resolution",
  },
};

const RESOLUTION_GOALS = {
  540: { width: 960, height: 540 },
  720: { width: 1280, height: 720 },
  1080: { width: 1920, height: 1080 },
  1440: { width: 2560, height: 1440 },
  2160: { width: 3840, height: 2160 },
};

function normalizeStreamSettings(value) {
  const request =
    typeof value === "string" ? { profile: value } : value ?? {};
  const profileName = normalizeProfile(request.profile);
  const base = STREAM_PROFILES[profileName];
  const resolution = RESOLUTION_GOALS[request.qualityGoal];
  const requestedFps = Number(request.fpsGoal);
  const fps = [24, 30, 45, 60, 90, 120].includes(requestedFps)
    ? requestedFps
    : base.fps;
  const width = resolution?.width ?? base.width;
  const height = resolution?.height ?? base.height;
  const hasManualQuality = Boolean(resolution);
  const hasManualFps = [24, 30, 45, 60, 90, 120].includes(requestedFps);
  const calculatedBitrate = Math.round(width * height * fps * 0.09);
  const bitrate =
    hasManualQuality || hasManualFps
      ? Math.min(48_000_000, Math.max(1_400_000, calculatedBitrate))
      : base.bitrate;
  return {
    profile: profileName,
    qualityGoal: hasManualQuality ? String(request.qualityGoal) : "auto",
    fpsGoal: hasManualFps ? String(request.fpsGoal) : "auto",
    width,
    height,
    fps,
    bitrate,
    degradationPreference:
      hasManualFps && fps > 60
        ? "maintain-framerate"
        : hasManualQuality && hasManualFps
        ? "balanced"
        : hasManualQuality
          ? "maintain-resolution"
          : hasManualFps
            ? "maintain-framerate"
            : base.degradationPreference,
  };
}

function streamShape(settings) {
  return [settings.width, settings.height, settings.fps].join("x");
}

function normalizeProfile(value) {
  return Object.hasOwn(STREAM_PROFILES, value)
    ? value
    : "high";
}

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

async function captureScreen(settingsRequest, includeAudio = true) {
  const profile = normalizeStreamSettings(settingsRequest);
  const source = await window.syndesk.getDisplaySource();
  const video = {
    mandatory: {
      chromeMediaSource: "desktop",
      chromeMediaSourceId: source.id,
      minWidth: 320,
      maxWidth: profile.width,
      minHeight: 240,
      maxHeight: profile.height,
      minFrameRate: 15,
      maxFrameRate: profile.fps,
    },
  };
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: includeAudio
        ? {
            mandatory: {
              chromeMediaSource: "desktop",
              chromeMediaSourceId: source.id,
            },
          }
        : false,
      video,
    });
  } catch {
    return navigator.mediaDevices.getUserMedia({
      audio: false,
      video,
    });
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
          message.t === "text" ||
          message.t === "release-all")
      ) {
        void window.syndesk.injectInput(message);
      } else if (
        (message?.t === "stream-profile" ||
          message?.t === "stream-settings") &&
        typeof message.profile === "string"
      ) {
        profileSwitch = profileSwitch
          .then(() => switchStreamProfile(message))
          .catch(() => undefined);
      } else if (message?.t === "restart-video") {
        profileSwitch = profileSwitch
          .then(() => restartVideoStream())
          .catch(() => undefined);
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

async function tuneVideoSender(sender, settingsRequest) {
  const profile = normalizeStreamSettings(settingsRequest);
  try {
    const parameters = sender.getParameters();
    if (!parameters.encodings?.length) {
      parameters.encodings = [{}];
    }
    parameters.encodings[0].maxBitrate = profile.bitrate;
    parameters.encodings[0].maxFramerate = profile.fps;
    parameters.encodings[0].scaleResolutionDownBy = 1;
    parameters.encodings[0].priority = "high";
    parameters.encodings[0].networkPriority = "high";
    parameters.degradationPreference =
      profile.degradationPreference;
    await sender.setParameters(parameters);
  } catch {
    try {
      const fallback = sender.getParameters();
      if (!fallback.encodings?.length) fallback.encodings = [{}];
      fallback.encodings[0].maxBitrate = profile.bitrate;
      fallback.encodings[0].maxFramerate = profile.fps;
      fallback.degradationPreference =
        profile.degradationPreference;
      await sender.setParameters(fallback);
    } catch {
      // Chromium will retain its adaptive defaults.
    }
  }
}

async function restartVideoStream(
  settingsRequest = activeStreamSettings,
) {
  const nextSettings = normalizeStreamSettings(settingsRequest);
  if (!activeVideoSender || !activeStream) return;
  const replacement = await captureScreen(nextSettings, false);
  const nextTrack = replacement.getVideoTracks()[0];
  if (!nextTrack || !activeVideoSender || !activeStream) {
    for (const track of replacement.getTracks()) track.stop();
    return;
  }
  nextTrack.contentHint = nextSettings.fps > 60 ? "motion" : "detail";
  const previousTrack = activeVideoSender.track;
  await activeVideoSender.replaceTrack(nextTrack);
  await tuneVideoSender(activeVideoSender, nextSettings);
  if (previousTrack) {
    activeStream.removeTrack(previousTrack);
    previousTrack.stop();
  }
  activeStream.addTrack(nextTrack);
  activeProfileName = nextSettings.profile;
  activeStreamSettings = nextSettings;
}

async function switchStreamProfile(settingsRequest) {
  const nextSettings = normalizeStreamSettings(settingsRequest);
  if (
    (activeStreamSettings &&
      streamShape(nextSettings) === streamShape(activeStreamSettings)) ||
    !activeVideoSender ||
    !activeStream
  ) {
    if (activeVideoSender) {
      await tuneVideoSender(activeVideoSender, nextSettings);
    }
    activeProfileName = nextSettings.profile;
    activeStreamSettings = nextSettings;
    return;
  }

  await restartVideoStream(nextSettings);
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
      rtcpMuxPolicy: "require",
      iceCandidatePoolSize: 4,
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

    const offerPayload = await decryptSignal(
      secrets.signalKey,
      secrets.locator,
      session.offerCipher,
    );
    const offer = offerPayload?.description ?? offerPayload;
    activeStreamSettings = normalizeStreamSettings(
      offerPayload?.settings ?? offerPayload?.profile,
    );
    activeProfileName = activeStreamSettings.profile;
    await connection.setRemoteDescription(offer);
    if (generation !== serviceGeneration) {
      throw new Error("Remote access was disabled.");
    }

    activeStream = await captureScreen(activeStreamSettings);
    for (const track of activeStream.getVideoTracks()) {
      track.contentHint =
        activeStreamSettings.fps > 60 ? "motion" : "detail";
      const sender = connection.addTrack(
        track,
        activeStream,
      );
      activeVideoSender = sender;
      await tuneVideoSender(sender, activeStreamSettings);
    }
    for (const track of activeStream.getAudioTracks()) {
      connection.addTrack(track, activeStream);
    }
    // Preserve the viewing browser's codec order. Forcing Electron's
    // preferred H.264 profile can create an undecodable black stream on iOS.

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
  activeVideoSender = null;
  activeProfileName = "high";
  activeStreamSettings = null;
  profileSwitch = Promise.resolve();
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
