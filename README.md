# Garage Contract → Invoice Assistant (v0.3)

## Run locally
1) Install: `npm i`
2) Create `.env` with:
   ```
   OPENAI_API_KEY=sk-...   # do NOT commit this
   PORT=3000
   ```
3) Start: `npm run dev`
4) Open http://localhost:3000

## Using in Cursor
- File → New Project → add these files (or unzip the zip).
- Put your API key in a local `.env` (never in code).
- `npm run dev` from the integrated terminal.

## Notes
- PDF goes directly to the model via the OpenAI Responses API.
- Pick a model from the dropdown; default is o3 (best reasoning).
- Toggle Force multi‑schedule (Auto/On/Off). In Auto, the model returns `model_recommendations.force_multi`.
- Optional: paste an **empty** Garage contract JSON so we return its `contractId` for later POSTs.

## How it works (end-to-end)

1. **Frontend (browser)**
   • You open `public/index.html` which is a single vanilla-JS page.  
   • Select a PDF (or drag-drop) + choose model + force-multi option.  
   • The page assembles a `FormData` payload: the file plus OPTIONAL Garage JSON.  
   • It POSTs this to `/api/extract` with query params `model` and `forceMulti`.

2. **Express server (`server.js`)**
   1. Receives the multipart request; `multer` streams the PDF to `uploads/` (tmp).  
   2. Logs basic file info for debug (`originalname`, `mimetype`, `size`).  
   3. **Uploads the PDF to OpenAI** using `/v1/files` with `purpose:"assistants"` – this returns a `file_id`.
   4. Builds a **strict system prompt** (`buildSystemPrompt`) that tells the LLM to:
      • enumerate every revenue schedule,  
      • return *only* JSON matching the Zod schema (`ExtractSchema`).
   5. Calls **`openai.responses.create`** with:
      • `model` – o3 / o4-mini / gpt-4o-mini / o3-mini,  
      • `input` – `[system, user]` messages where the user message is an `input_text` + the `file_id` (as `input_file`).  
      • `text.format:'json_schema'` and our JSON Schema (converted from Zod via `zod-to-json-schema`).  
   6. The Responses API validates the schema server-side – if the model tries to emit anything else, the request fails.
   7. On success we parse the JSON into `ExtractSchema`, lightly post-process confidences, and return a JSON payload back to the browser.
   8. On **any** error we capture status/code/message/request_id and include it in the response so the UI can show human-readable debugging info.
   9. Finally we delete the tmp PDF from `uploads/`.

3. **Frontend rendering**
   • Renders a card per schedule with confidence, evidence (page snippets), and copy-ready “Garage plan” JSON.  
   • Shows any issues / model recommendations.  
   • Everything is client-side; no framework required.

### Key points / gotchas

• We use the **Files API** + `input_file` – PDFs are accepted when purpose is `assistants`.  
• Strict JSON schema means *zero* hallucinated prose.  
• Force-multi toggle lets the analyst bias the model to search for multiple schedules.  
• A `/health` route pings `client.models.list()` so you can confirm the API key is valid.

### Typical error messages & fixes

| Error (debug.message) | Meaning | Action |
|-----------------------|---------|--------|
| `Invalid file format application/pdf` | Using wrong `purpose` (must be `assistants`) | Confirm `server.js` upload step |
| `unsupported_parameter response_format` | Using outdated param – should be `text.format` | Pull latest code |
| `unknown_parameter text.schema` | Nested shape wrong – use `text.format` with inline schema | Pull latest code |
| `rate_limit_error` | Org / key rate-limited | Retry with back-off |

> **Tip:** The detailed debug block in error responses includes `request_id`; paste that in OpenAI support chat for faster help.

---
Happy extracting! 🚗💸
# Updated Tue Sep 30 15:45:58 EDT 2025
