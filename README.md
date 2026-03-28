# ClinicSense Browser Automation Server

A Node.js Express server that automates ClinicSense using Playwright browser automation.

## Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/health` | Health check |
| POST | `/check-availability` | Get practitioner availability for a date |
| POST | `/create-booking` | Create a new appointment |
| POST | `/cancel-booking` | Cancel an existing appointment |
| POST | `/reschedule-booking` | Reschedule an existing appointment |

## Setup

1. Install dependencies:
   ```bash
   npm install
   npx playwright install chromium
   ```

2. Create a `.env` file:
   ```
   CLINICSENSE_EMAIL=your@email.com
   CLINICSENSE_PASSWORD=yourpassword
   PORT=3000
   ```

3. Start the server:
   ```bash
   node server.js
   ```

## Example Usage

### Check Availability
```bash
curl -X POST http://localhost:3000/check-availability \
  -H "Content-Type: application/json" \
  -d '{"date": "2026-03-29"}'
```

### Create Booking
```bash
curl -X POST http://localhost:3000/create-booking \
  -H "Content-Type: application/json" \
  -d '{
    "date": "2026-03-29",
    "time": "14:00",
    "clientFirstName": "John",
    "clientLastName": "Smith",
    "clientEmail": "john@gmail.com",
    "clientPhone": "4031234567",
    "service": "Relaxation Massage",
    "duration": "60",
    "therapist": "Jhee Ann"
  }'
```

## Railway Deployment

This project is ready for Railway deployment. The `Procfile` defines the start command.

Set the following environment variables in Railway:
- `CLINICSENSE_EMAIL`
- `CLINICSENSE_PASSWORD`
- `PORT` (Railway sets this automatically)
