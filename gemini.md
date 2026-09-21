# Azure DevOps Work Item Importer Agent Instructions

## 🎯 Formål
Byg en lokal webapplikation med en Node.js (Express) backend og et rent frontend (HTML/CSS/JS), der kan importere Features, User Stories og Tasks til Azure DevOps ud fra et JSON-datasæt via en Personal Access Token (PAT). 

Systemet skal understøtte både oprettelse af nye Features og tilknytning til en eksisterende Feature (via ID).

---

## 🏗️ Arkitektur & Krav

1. **Backend (Node.js/Express)**
   - Kører lokalt (f.eks. port `3000`).
   - Fungerer som proxy for at eliminere CORS-problemer mod Azure DevOps REST API.
   - Endpoint: `POST /api/import`
     - Modtager: `{ org, project, pat, existingFeatureId (optional), features: [...] }`
     - Returnerer: En liste over oprettede/tilknyttede elementer med ID, type, titel og status.
   - Sikkerhed: Begræns payload og log aldrig PAT-tokenet i konsollen.

2. **Frontend (`public/index.html`)**
   - Felter til:
     - Azure DevOps Organization (`org`)
     - Project Name (`project`)
     - Personal Access Token (`pat` - password type)
     - Eksisterende Feature ID (valgfrit input-felt)
     - JSON-input (textarea eller fil-upload)
   - **Live hierarkisk preview**:
     - Parser JSON on-the-fly og viser et visuelt træ med badges (Feature $\rightarrow$ User Story $\rightarrow$ Task).
     - Hvis et eksisterende Feature ID er angivet, skal previewet tydeligt indikere, at stories tilknyttes dette ID frem for at oprette nye features.
   - **Status/Log-panel**:
     - Viser realtids- eller trinvis feedback under oprettelsen med ID-referencer på oprettede work items.

---

## 📡 Azure DevOps REST API Detaljer

- **Base URL for oprettelse**:
  `POST https://dev.azure.com/{organization}/{project}/_apis/wit/workitems/${type}?api-version=7.1-preview.3`
- **Headers**:
  - `Content-Type: application/json-patch+json`
  - `Authorization: Basic base64(":" + pat)`
- **Payload Schema (`json-patch+json`)**:
  ```json
  [
    { "op": "add", "path": "/fields/System.Title", "value": "{title}" },
    { "op": "add", "path": "/fields/System.Description", "value": "{description}" }
  ]
  ```
- **Hierarkisk Linking (Child -> Parent)**:
  Ved oprettelse af en User Story under en Feature, eller en Task under en User Story, tilføjes følgende relation til payloaden:
  ```json
  {
    "op": "add",
    "path": "/relations/-",
    "value": {
      "rel": "System.LinkTypes.Hierarchy-Reverse",
      "url": "{parent_work_item_url}"
    }
  }
  ```

---

## 📋 Forventet JSON Format

```json
[
  {
    "title": "Feature Titel (ignoreres hvis eksisterende ID angives)",
    "description": "Valgfri feature beskrivelse",
    "userStories": [
      {
        "title": "Som bruger vil jeg...",
        "description": "Acceptance criteria...",
        "tasks": [
          {
            "title": "Implementer database schema",
            "description": "Opret tabeller og migrationer"
          }
        ]
      }
    ]
  }
]
```

---

## 🛠️ Opgaver for agenten

1. **Initialiser projekt**:
   - Opret `package.json` med afhængigheder (`express`).
2. **Opret `server.js`**:
   - Implementer ruter, proxy-kald med `fetch`, hierarkisk rækkefølge (Feature $\rightarrow$ Story $\rightarrow$ Task) og robust fejlhåndtering.
3. **Opret `public/index.html`**:
   - Lav et minimalistisk og responsivt UI med CSS-styling og live hierarki-preview.
4. **Validering & Verifikation**:
   - Kontroller at fejlbeskeder fra Azure DevOps API returneres læsbart til UI'et.
   - Sørg for at appen kan startes med `npm start` eller `node server.js`.
