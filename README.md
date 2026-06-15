# AutoGrok Team Pro

Chrome extension for automated Grok interactions with a human-in-the-loop confirmation flow.

**Stack:** JavaScript · Chrome Manifest V3 · Service Workers

## Features

- Automated prompt workflows on grok.com and x.com
- WebSocket bridge for real-time communication
- Background service worker orchestration
- Popup control panel for status monitoring
- Local storage for session persistence

## Install (Developer Mode)

1. Clone this repository
2. Open `chrome://extensions`
3. Enable **Developer mode**
4. Click **Load unpacked** and select the project folder

## Project Structure

```
background.js       Service worker — orchestration
content.js          Page injection on Grok / X
grok-ws-bridge.js   WebSocket bridge module
popup.html/js/css   Extension popup UI
manifest.json       MV3 configuration
```

## Author

Built by [Geron1mmo](https://github.com/Geron1mmo) — shipping fast, iterating daily.

## Development

Load unpacked in Chrome DevTools to test locally. Check `CONTRIBUTING.md` for PR guidelines.

## License

MIT