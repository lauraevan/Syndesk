# Syndesk Host for Windows

This package contains the lightweight Windows host app for Syndesk. Version 0.7 reduces live latency with lower video buffering, faster adaptive quality changes, motion-first 60 FPS encoding, and more efficient bitrate targets. Mobile pointer mode now has persistent left-click and right-click selection alongside scroll, typing, and game controls.

## Build

Install Node.js 22 or newer and the .NET 8 SDK. Open PowerShell in this folder, then run:

```powershell
npm install
npm run dist
```

The finished installer is created at `dist/Syndesk-Host-Setup.exe`.

## Development

```powershell
npm install
npm run build:input
npm start
```

The input helper is required for remote mouse and keyboard control. The host can still stream its screen when that helper is missing.

The web portal is:

https://syndesk.cb88sggy8y.chatgpt.site

Keep your generated access key private. Use Generate a new key immediately if it is ever shared accidentally.
