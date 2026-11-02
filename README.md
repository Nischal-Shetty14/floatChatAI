# FloatChat AI 🌊

FloatChat AI is an interactive, premium web application designed to monitor deep-sea ocean telemetry from floating sensor stations (buoys) and analyze marine trends using a Google Gemini AI-driven oceanographer assistant.

---

## Key Features

1. **Ocean Metrics KPI Grid**: Real-time readouts of Mean Temperature (°C), Salinity (PSU), Dissolved Oxygen (mg/L), pH, and Depth/Hydrostatic Pressure (dbar).
2. **Interactive Recharts Visualization**:
   - **Temporal Trends**: Temperature and Salinity over time.
   - **Biogeochemical Trends**: Dissolved Oxygen and acidity levels.
   - **Hydrostatic Profile**: A scatter plot matching Water Pressure vs. Depth (using a reversed Y-axis simulating ocean depths).
3. **Sensor Coordinate Map**: An interactive SVG representation of telemetry beacons anchored in the ocean. Beacons pulse to reflect their status (Active, Warning, Hypoxic Danger) and support click/hover tooltips.
4. **Telemetry Ingestion Portal**: Drag-and-drop file uploader supporting both CSV and JSON telemetry uploads. Includes download links for pre-formatted templates.
5. **FloatChat Analyst (AI Chatbot)**: A slide-in AI expert to analyze current telemetry records and alerts. Connects to the **Google Gemini API** (via UI input or backend environment config) and falls back to a high-fidelity simulation model if no API key is present.
6. **MERN Stack with Local Fallback**: Integrates MongoDB through Mongoose, but falls back seamlessly to a local JSON database file (`backend/data/telemetry.json`) for zero-setup execution.

---

## Tech Stack

- **Frontend**: React (Vite-based), Recharts (data plots), Lucide React (icons), Custom CSS (Glassmorphism layout, animations)
- **Backend**: Node.js, Express, Multer (file upload), CSV Parser (csv-to-json parsing), @google/generative-ai (Gemini SDK)
- **Database**: MongoDB (optional via Mongoose) / Local JSON file (fallback)

---

## Getting Started

### Prerequisites

Ensure you have **Node.js** (v16.x or newer) installed on your system.

### Install Dependencies

From the root directory, run the setup script to install all packages for both the frontend and backend:

```bash
npm run setup
```

_This will run a concurrent install in both `frontend/` and `backend/` folders._

### Seed Sample Telemetry

Before running the server, generate the baseline 30-day telemetry dataset for the 4 active stations:

```bash
npm run generate-data
```

_This writes sample CSV and JSON files under `backend/data/` and `frontend/public/`._

### Run the App

Launch both the React frontend and Express backend concurrently:

```bash
npm run dev
```

- **Frontend**: Runs at [http://localhost:3000](http://localhost:3000)
- **Backend API**: Runs at [http://localhost:5001/api](http://localhost:5001/api)

---

## Configuration & Environment

To configure database connections and Gemini keys, edit the backend environment file:

1. Open `backend/.env`
2. Configure settings:
   - `MONGODB_URI`: Connect to a local or remote MongoDB instance (e.g. `mongodb://localhost:27017/floatchat`). If left empty, the server automatically reads and writes from `backend/data/telemetry.json`.
   - `GEMINI_API_KEY`: Provide a Gemini API key to enable live AI responses. If left empty, the chatbot runs in simulation mode, and users can also input their API key dynamically in the frontend dashboard settings.

---

## Formatting Specifications for Data Uploads

When uploading custom CSV/JSON sheets, ensure they include these columns/fields:

- `timestamp`: UTC date string (e.g., `2026-06-01T00:00:00Z`)
- `buoyId`: String (e.g., `FC-PAC-01`)
- `buoyName`: String (e.g., `Pacific Deep-Shift`)
- `latitude` / `longitude`: Decimal coordinates
- `depth`: Depth in meters
- `temperature`: Celsius
- `pressure`: Hydrostatic pressure in dbar
- `salinity`: Salinity in PSU
- `oxygenContent`: Oxygen in mg/L
- `ph`: Acidity index
- `batteryLevel`: Battery remaining percentage
