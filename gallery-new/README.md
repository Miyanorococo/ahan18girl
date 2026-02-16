# New Gallery UI

This is a modern, responsive redesign of the Gallery.

## Features
- **Modern Dark UI**: Clean interface with glassmorphism touches.
- **Sidebar Navigation**: easy access to different views.
- **Dashboard**: KPI summary and recent experiments.
- **Filtering**: Advanced filtering by model and genre.
- **Pagination**: Client-side pagination for better performance.
- **Detail View**: Immersive mode for viewing experiment results.

## Setup
The gallery expects to be served from the same origin as the API.
If you are running the python backend (e.g. `flask` or `fastapi`), ensure this folder is served statically or accessible.

## Files
- `index.html`: Entry point.
- `css/styles.css`: All styles.
- `js/app.js`: Application logic.
- `js/api.js`: API wrapper.
