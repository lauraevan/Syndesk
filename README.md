# Syndesk Host for Windows

This package contains the lightweight Windows host app for Syndesk. Version 0.5 preserves the viewer browser's preferred video codec for wider mobile compatibility and can restart the capture track when a phone connects without receiving frames. It also includes experimental 4K capture for high-end systems, independent resolution and frame-rate goals, and full mobile input controls.

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
