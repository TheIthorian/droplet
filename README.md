# Droplet

A self-contained static site for calm, music-reactive visuals.

## What it does

- Captures browser tab or system audio when the browser supports it
- Falls back to microphone input for ambient listening
- Includes demo mode and local file playback so the visuals are usable immediately
- Renders droplets, ripples, and an abstract center bloom that respond to the track

## Run locally

```bash
python3 -m http.server 4173
```

Then open `http://localhost:4173`.
