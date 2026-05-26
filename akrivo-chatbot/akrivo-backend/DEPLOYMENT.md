# AKRIVO AI free deployment

## Recommended free setup

Use one GitHub repo with both folders at the repo root:

```text
akrivo-project/
  akrivo-backend/
  akrivoai/
```

Deploy `akrivo-backend` as the web service. The backend serves the frontend automatically from `../akrivoai`.

## Render free web service

1. Push the repo to GitHub.
2. In Render, create a new Web Service from the repo.
3. Set Root Directory to `akrivo-backend`.
4. Set Build Command to `npm install`.
5. Set Start Command to `npm start`.
6. Add environment variables:

```text
GROQ_API_KEY=your_real_groq_key
GROQ_MODEL=llama-3.3-70b-versatile
MAX_SEARCH_RESULTS=7
```

Optional Google search:

```text
GOOGLE_SEARCH_API_KEY=your_google_custom_search_key
GOOGLE_SEARCH_ENGINE_ID=your_google_search_engine_id
```

## Koyeb free web service

Use the same repo layout and environment variables. Create a Web Service, choose the free instance, set the build command to `npm install`, and set the run command to `npm start`.

## Local check before deploying

```bash
cd akrivo-backend
npm install
npm test
npm start
```

Open `http://localhost:3000`.
